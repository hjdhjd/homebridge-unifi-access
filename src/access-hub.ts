/* Copyright(C) 2019-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-hub.ts: Hub device class for UniFi Access.
 */
import { AccessDeviceConfig, AccessEventDoorbellCancel, AccessEventDoorbellRing, AccessEventPacket } from "unifi-access";
import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { AccessController } from "./access-controller.js";
import { AccessDevice } from "./access-device.js";
import { AccessReservedNames } from "./access-types.js";

export class AccessHub extends AccessDevice {

  private _hkLockState: CharacteristicValue;
  private doorbellRingRequestId: string | null;
  private lockDelayInterval: number | undefined;
  public uda: AccessDeviceConfig;

  // Create an instance.
  constructor(controller: AccessController, device: AccessDeviceConfig, accessory: PlatformAccessory) {

    super(controller, accessory);

    this.uda = device;
    this._hkLockState = this.hubLockState;
    this.lockDelayInterval = this.getFeatureNumber("Hub.LockDelayInterval");
    this.doorbellRingRequestId = null;

    // If we attempt to set the delay interval to something invalid, then assume we are using the default unlock behavior.
    if((this.lockDelayInterval !== undefined) && (this.lockDelayInterval < 0)) {

      this.lockDelayInterval = undefined;
    }

    this.configureHints();
    this.configureDevice();
  }

  // Configure device-specific settings for this device.
  protected configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    this.hints.logDoorbell = this.hasFeature("Log.Doorbell");
    this.hints.logLock = this.hasFeature("Log.Lock");

    return true;
  }

  // Initialize and configure the light accessory for HomeKit.
  private configureDevice(): boolean {

    this._hkLockState = this.hubLockState;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.uda.mac;
    this.accessory.context.controller = this.controller.uda.host.mac;

    if(this.lockDelayInterval === undefined) {

      this.log.info("The door lock relay will lock five seconds after unlocking in HomeKit.");
    } else {

      this.log.info("The door lock relay will remain unlocked %s after unlocking in HomeKit.",
        this.lockDelayInterval === 0 ? "indefinitely" : "for " + this.lockDelayInterval.toString() + " minutes");
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure the doorbell.
    this.configureDoorbell();
    this.configureDoorbellTrigger();

    // Configure the lock.
    this.configureLock();

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    this.controller.events.on(this.uda.unique_id, this.listeners[this.uda.unique_id] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_view", this.listeners[this.uda.unique_id] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_view.change", this.listeners[this.uda.unique_id] = this.eventHandler.bind(this));

    return true;
  }

  // Configure the lock for HomeKit.
  private configureLock(): boolean {

    // Find the service, if it exists.
    let lockService = this.accessory.getService(this.hap.Service.LockMechanism);

    // Add the service to the accessory, if needed.
    if(!lockService) {

      lockService = new this.hap.Service.LockMechanism(this.accessoryName);

      if(!lockService) {

        this.log.error("Unable to add lock.");
        return false;
      }

      this.accessory.addService(lockService);
    }

    // Return the lock state.
    lockService.getCharacteristic(this.hap.Characteristic.LockCurrentState)?.onGet(() => {

      return this.hkLockState;
    });

    lockService.getCharacteristic(this.hap.Characteristic.LockTargetState)?.onSet(async (value: CharacteristicValue) => {

      if(!await this.controller.udaApi.unlock(this.uda,
        (this.lockDelayInterval === undefined) ? undefined : (value === this.hap.Characteristic.LockTargetState.SECURED ? 0 : Infinity))) {

        this.log.error("Unable to %s.", value === this.hap.Characteristic.LockTargetState.SECURED ? "lock" : "unlock");

        // Revert our target state.
        setTimeout(() => {

          lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, !value);
        }, 50);
      }
    });

    // Initialize the lock.
    this._hkLockState = -1;
    lockService.displayName = this.accessoryName;
    lockService.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName);
    this.hkLockState = this.hubLockState;

    return true;
  }

  // Configure the doorbell service for HomeKit.
  private configureDoorbell(): boolean {

    // Find the doorbell service, if it exists.
    let doorbellService = this.accessory.getService(this.hap.Service.Doorbell);

    // If we don't have HKSV or the HKSV recording switch enabled, disable it and we're done.
    if(!this.hasFeature("Hub.Doorbell")) {

      if(doorbellService) {

        this.accessory.removeService(doorbellService);
      }

      return false;
    }

    // Add the doorbell service. HomeKit requires the doorbell service to be marked as the primary service on the accessory.
    if(!doorbellService) {

      doorbellService = new this.hap.Service.Doorbell(this.accessoryName);

      if(!doorbellService) {

        this.log.error("Unable to add doorbell.");
        return false;
      }

      this.accessory.addService(doorbellService);
    }

    doorbellService.setPrimaryService(true);
    this.log.info("Enabling doorbell.");

    return true;
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    // Find the switch service, if it exists.
    let triggerService = this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

    // Doorbell switches are disabled by default and primarily exist for automation purposes.
    if(!this.hasFeature("Hub.Doorbell.Trigger")) {

      if(triggerService) {

        this.accessory.removeService(triggerService);
      }

      return false;
    }

    const triggerName = this.accessoryName + " Doorbell Trigger";

    // Add the switch to the hub, if needed.
    if(!triggerService) {

      triggerService = new this.hap.Service.Switch(triggerName, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

      if(!triggerService) {

        this.log.error("Unable to add the doorbell trigger.");
        return false;
      }

      triggerService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      this.accessory.addService(triggerService);
    }

    // Trigger the doorbell.
    triggerService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return this.doorbellRingRequestId !== null;
    });

    // The state isn't really user-triggerable. We have no way, currently, to trigger a ring event on the hub.
    triggerService.getCharacteristic(this.hap.Characteristic.On)?.onSet(() => {

      setTimeout(() => {

        triggerService?.updateCharacteristic(this.hap.Characteristic.On, this.doorbellRingRequestId !== null);
      }, 50);
    });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, triggerName);
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling doorbell automation trigger.");

    return true;
  }

  // Configure MQTT capabilities of this light.
  private configureMqtt(): boolean {

    const lockService = this.accessory.getService(this.hap.Service.LockMechanism);

    if(!lockService) {

      return false;
    }

    // MQTT status.
    this.controller.mqtt?.subscribeGet(this.accessory, "lock", "Lock", () => {

      switch(this.hkLockState) {

        case this.hap.Characteristic.LockCurrentState.SECURED:

          return "true";
          break;

        case this.hap.Characteristic.LockCurrentState.UNSECURED:

          return "false";
          break;

        default:

          return "unknown";
          break;
      }
    });

    // MQTT status.
    this.controller.mqtt?.subscribeSet(this.accessory, "lock", "Lock", (value: string) => {

      switch(value) {

        case "true":

          void this.controller.udaApi.unlock(this.uda, 0);

          break;

        case "false":

          void this.controller.udaApi.unlock(this.uda, Infinity);

          break;

        default:

          this.log.error("MQTT: Unknown lock set message received: %s.", value);
          break;
      }
    });

    return true;
  }

  // Return the current HomeKit lock state that we are tracking for this hub.
  private get hkLockState(): CharacteristicValue {

    return this._hkLockState;
  }

  // Set the current HomeKit lock state for this hub.
  private set hkLockState(value: CharacteristicValue) {

    // If nothing is changed, we're done.
    if(this.hkLockState === value) {

      return;
    }

    // Update the lock state.
    this._hkLockState = value;

    // Retrieve the lock service.
    const lockService = this.accessory.getService(this.hap.Service.LockMechanism);

    if(!lockService) {

      return;
    }

    // Update the state in HomeKit.
    lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hkLockState === this.hap.Characteristic.LockCurrentState.UNSECURED ?
      this.hap.Characteristic.LockTargetState.UNSECURED : this.hap.Characteristic.LockTargetState.SECURED);
    lockService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hkLockState);
  }

  // Return the current state of the relay lock on the hub.
  private get hubLockState(): CharacteristicValue {

    const lockRelay = this.uda.configs.find(x => x.key === "input_state_rly-lock_dry");

    return (lockRelay?.value === "off" ?
      this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED) ?? this.hap.Characteristic.LockCurrentState.UNKNOWN;
  }

  // Handle hub-related events.
  private eventHandler(packet: AccessEventPacket): void {

    switch(packet.event) {

      case "access.data.device.remote_unlock":

        // Process an Access unlock event.
        this.hkLockState = this.hap.Characteristic.LockCurrentState.UNSECURED;

        if(this.hints.logLock) {

          this.log.info("Unlocked.");
        }

        break;

      case "access.data.device.update":

        // Process an Access device update event if our state has changed.
        if(this.hubLockState === this.hkLockState) {

          break;
        }

        this.hkLockState = this.hubLockState;

        if(this.hints.logLock) {

          this.log.info(this.hkLockState === this.hap.Characteristic.LockCurrentState.SECURED ? "Locked." : "Unlocked.");
        }

        break;

      case "access.remote_view":

        // Process an Access ring event if we're the intended target.
        if((packet.data as AccessEventDoorbellRing).connected_uah_id !== this.uda.unique_id) {

          break;
        }

        this.doorbellRingRequestId = (packet.data as AccessEventDoorbellRing).request_id;

        // Trigger the doorbell event in HomeKit.
        this.accessory.getService(this.hap.Service.Doorbell)?.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
          ?.sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

        // Update our doorbell trigger, if needed.
        this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, true);

        if(this.hints.logDoorbell) {

          this.log.info("Doorbell ring detected.");
        }

        break;

      case "access.remote_view.change":

        // Process the cancellation of an Access ring event if we're the intended target.
        if(this.doorbellRingRequestId !== (packet.data as AccessEventDoorbellCancel).remote_call_request_id) {

          break;
        }

        this.doorbellRingRequestId = null;

        // Update our doorbell trigger, if needed.
        this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, false);

        if(this.hints.logDoorbell) {

          this.log.info("Doorbell ring cancelled.");
        }

        break;

      default:

        break;
    }
  }
}
