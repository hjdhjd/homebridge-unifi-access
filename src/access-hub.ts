/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-hub.ts: Unified hub and reader device class for UniFi Access.
 */
import { AccessDevice, type AccessHints } from "./access-device.js";
import type { AccessDeviceConfig, AccessEventDoorbellCancel, AccessEventDoorbellRing, AccessEventPacket } from "unifi-access";
import type { CharacteristicValue, PlatformAccessory } from "homebridge";
import { acquireService, validService } from "homebridge-plugin-utils";
import type { AccessController } from "./access-controller.js";
import { AccessReservedNames } from "./access-types.js";

// Access methods available to us for readers.
const accessMethods = [

  { capability: "identity_face_unlock", key: "face", name: "Face Unlock", option: "AccessMethod.Face", subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_FACE },
  { capability: "hand_wave", key: "wave", name: "Hand Wave", option: "AccessMethod.Hand", subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_HAND },
  { capability: "mobile_unlock_ver2", key: "bt_button", name: "Mobile", option: "AccessMethod.Mobile", subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_MOBILE },
  { capability: "nfc_card_easy_provision", key: "nfc", name: "NFC", option: "AccessMethod.NFC", subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_NFC },
  { capability: "pin_code", key: "pin_code", name: "PIN", option: "AccessMethod.PIN", subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_PIN },
  { capability: "qr_code", key: "qr_code", name: "QR Code", option: "AccessMethod.QR", subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_QR }
] as const;

// Extract the key property values from the access methods array to create a union type of all possible keys for our supported access methods.
type AccessMethodKey = typeof accessMethods[number]["key"];

// Access v2 event data so that we can detect access method changes.
interface AccessEventDeviceUpdateV2 {

  access_method?: {

    [K in AccessMethodKey]?: "yes" | "no";
  };
}

// Define the dry contact inputs we're interested in for Access hubs.
const sensorInputs = [ "Dps", "Rel", "Ren", "Rex" ] as const;

// Create a union type based on our sensor inputs.
type SensorInput = typeof sensorInputs[number];

// Define the sensor wiring. It's a bit convoluted because there's a lot of inconsistency at the API level across device types in Access:
//   - For UA-ULTRA, we look at rex_button_mode = proxyMode.
//   - For other models, we look at per-device wiring keys.
const sensorWiring: Record<SensorInput, { proxyMode?: "dps" | "rex"; wiring?: Record<string, string[]> }> = {

  Dps: {

    proxyMode: "dps",
    wiring: {

      "UA-Hub-Door-Mini": [ "wiring_state_d1-dps-neg", "wiring_state_d1-dps-pos" ],
      UAH: [ "wiring_state_dps-neg", "wiring_state_dps-pos" ],
      UGT: [ "wiring_state_gate-dps-neg", "wiring_state_gate-dps-pos" ]
    }
  },
  Rel: {

    wiring: {

      UAH: [ "wiring_state_rel-neg", "wiring_state_rel-pos" ]
    }
  },
  Ren: {

    wiring: {

      UAH: [ "wiring_state_ren-neg", "wiring_state_ren-pos" ]
    }
  },
  Rex: {

    proxyMode: "rex",

    wiring: {

      "UA-Hub-Door-Mini": [ "wiring_state_d1-button-neg", "wiring_state_d1-button-pos" ],
      UAH: [ "wiring_state_rex-neg", "wiring_state_rex-pos" ]
    }
  }
};

// Create a mapped type of our HomeKit terminal input state check.
export type AccessHubHKProps = {

  [K in `hk${SensorInput}State`]: CharacteristicValue;
};

// Create a mapped type of our wiring checks.
export type AccessHubWiredProps = {

  [P in `is${SensorInput}Wired`]: boolean;
};

// Merge the declarations into the definition of the class, so TypeScript knows that these properties will exist.
export interface AccessHub extends AccessHubHKProps, AccessHubWiredProps { }

// Utility to assist us in constructing typing for the properties we will be using.
type KeyOf<T, Prefix extends string, Suffix extends string = ""> = Extract<keyof T, `${Prefix}${SensorInput}${Suffix}`>;

// Finally, define our key-unions types so we can satisfy our typing needs.
type HasWiringHintKey = KeyOf<AccessHints, "hasWiring">;
type HubStateKey = KeyOf<AccessHub, "hub", "State">;
type HkStateKey = KeyOf<AccessHub, "hk", "State">;
type LogHintKey = KeyOf<AccessHints, "log">;
type WiredKey = KeyOf<AccessHub, "is", "Wired">;

// Valid door service types.
type DoorServiceType = "Lock" | "GarageDoorOpener" | "Door";

export class AccessHub extends AccessDevice {

  private _hkLockState: CharacteristicValue;
  private _hkSideDoorLockState: CharacteristicValue;
  private doorbellRingRequestId: string | null;
  private doorServiceType: DoorServiceType;
  private lockDelayInterval: number | undefined;
  private sideDoorLockDelayInterval: number | undefined;
  private sideDoorServiceType: DoorServiceType;
  public uda: AccessDeviceConfig;

  // Create an instance.
  constructor(controller: AccessController, device: AccessDeviceConfig, accessory: PlatformAccessory) {

    super(controller, accessory);

    this.uda = device;
    this._hkLockState = this.hubLockState;
    this._hkSideDoorLockState = this.hubSideDoorLockState;
    this.doorServiceType = this.getDoorServiceType("Hub.DoorServiceType");
    this.lockDelayInterval = this.getFeatureNumber("Hub.LockDelayInterval") ?? undefined;
    this.sideDoorLockDelayInterval = this.getFeatureNumber("Hub.SideDoor.LockDelayInterval") ?? undefined;
    this.sideDoorServiceType = this.getDoorServiceType("Hub.SideDoor.ServiceType");
    this.doorbellRingRequestId = null;

    // If we attempt to set the delay interval to something invalid, then assume we are using the default unlock behavior.
    if((this.lockDelayInterval !== undefined) && (this.lockDelayInterval < 0)) {

      this.lockDelayInterval = undefined;
    }

    if((this.sideDoorLockDelayInterval !== undefined) && (this.sideDoorLockDelayInterval < 0)) {

      this.sideDoorLockDelayInterval = undefined;
    }

    this.configureHints();
    this.configureDevice();
  }

  // Configure device-specific settings for this device.
  protected configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    this.hints.hasSideDoor = (this.uda.device_type === "UGT") && this.hasFeature("Hub.SideDoor");
    this.hints.hasWiringDps = [ "UA Ultra", "UA Hub", "UA Hub Door Mini" ].includes(this.uda.display_model ?? "") && this.hasFeature("Hub.DPS");
    this.hints.hasWiringRel = ["UA Hub"].includes(this.uda.display_model ?? "") && this.hasFeature("Hub.REL");
    this.hints.hasWiringRen = ["UA Hub"].includes(this.uda.display_model ?? "") && this.hasFeature("Hub.REN");
    this.hints.hasWiringRex = [ "UA Ultra", "UA Hub", "UA Hub Door Mini" ].includes(this.uda.display_model ?? "") && this.hasFeature("Hub.REX");
    this.hints.logDoorbell = this.hasFeature("Log.Doorbell");
    this.hints.logDps = this.hasFeature("Log.DPS");
    this.hints.logLock = this.hasFeature("Log.Lock");
    this.hints.logRel = this.hasFeature("Log.REL");
    this.hints.logRen = this.hasFeature("Log.REN");
    this.hints.logRex = this.hasFeature("Log.REX");
    this.hints.logSideDoorLock = this.hasFeature("Log.SideDoorLock");

    // The Ultra has a single terminal input that's selectable between DPS and REX modes. We detect which mode it's operating in, and adjust accordingly. We've
    // over-engineered this a bit for future-proofing.
    if(this.uda.display_model === "UA Ultra") {

      this.checkUltraInputs();
    }

    return true;
  }

  // Get the door service type from configuration.
  private getDoorServiceType(option: string): DoorServiceType {

    const value = this.getFeatureValue(option)?.toLowerCase();

    switch(value) {

      case "garagedooropener":
      case "garage":

        return "GarageDoorOpener";

      case "door":

        return "Door";

      default:

        return "Lock";
    }
  }

  // Initialize and configure the light accessory for HomeKit.
  private configureDevice(): boolean {

    this._hkLockState = this.hubLockState;
    this._hkSideDoorLockState = this.hubSideDoorLockState;

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

    if(this.hints.hasSideDoor) {

      if(this.sideDoorLockDelayInterval === undefined) {

        this.log.info("The side door lock relay will lock five seconds after unlocking in HomeKit.");
      } else {

        this.log.info("The side door lock relay will remain unlocked %s after unlocking in HomeKit.",
          this.sideDoorLockDelayInterval === 0 ? "indefinitely" : "for " + this.sideDoorLockDelayInterval.toString() + " minutes");
      }
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure access method switches, if we're a reader device.
    this.configureAccessMethodSwitches();

    // Configure the lock, if we're a hub device.
    this.configureLock();
    this.configureLockTrigger();

    // Configure the side door lock, if we're a UA Gate device.
    this.configureSideDoorLock();
    this.configureSideDoorLockTrigger();

    // Configure the doorbell, if we have one.
    this.configureDoorbell();
    this.configureDoorbellTrigger();

    // Configure the sensors connected to terminal inputs.
    this.configureTerminalInputs();

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    this.controller.events.on(this.uda.unique_id, this.listeners[this.uda.unique_id] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_view", this.listeners["access.remote_view"] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_view.change", this.listeners["access.remote_view.change"] = this.eventHandler.bind(this));

    return true;
  }

  // Configure the access method switches for HomeKit.
  private configureAccessMethodSwitches(): boolean {

    for(const accessMethod of accessMethods) {

      // Validate whether we should have this service enabled.
      if(!validService(this.accessory, this.hap.Service.Switch,
        this.hasCapability("is_reader") && this.hasCapability(accessMethod.capability) && this.hasFeature(accessMethod.option), accessMethod.subtype)) {

        continue;
      }

      // Acquire the service.
      const service = acquireService(this.accessory, this.hap.Service.Switch, this.accessoryName + " " + accessMethod.name, accessMethod.subtype);

      if(!service) {

        this.log.error("Unable to add the %s access method switch.", accessMethod.name);

        continue;
      }

      // Retrieve the state when requested.
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => Boolean(this.uda.configs?.find(entry => entry.key === accessMethod.key)?.value === "yes"));

      // Set the state when requested.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        const entry = this.uda.configs?.find(entry => entry.key === accessMethod.key);
        let success;

        if(entry) {

          const response = await this.controller.udaApi.retrieve(this.controller.udaApi.getApiEndpoint("device") + "/" + this.id + "/settings", {

            body: JSON.stringify([{ key: entry.key, tag: "open_door_mode", value: value ? "yes" : "no" }]),
            method: "PUT"
          });

          success = this.controller.udaApi.responseOk(response?.statusCode);
        }

        // If we didn't find the configuration entry or we didn't succeed in setting the value, revert our switch state.
        if(!success) {

          this.log.error("Unable to %s the %s access method.", value ? "activate" : "deactivate", accessMethod.name);
          setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), 50);
        }
      });

      // Initialize the switch.
      service.updateCharacteristic(this.hap.Characteristic.On, Boolean(this.uda.configs?.find(entry => entry.key === accessMethod.key)?.value === "yes"));
    }

    return true;
  }

  // Configure the doorbell service for HomeKit.
  private configureDoorbell(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Doorbell, this.hasCapability("door_bell") && this.hasFeature("Hub.Doorbell"))) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Doorbell, this.accessoryName, undefined, () => this.log.info("Enabling the doorbell."));

    if(!service) {

      this.log.error("Unable to add the doorbell.");

      return false;
    }

    service.setPrimaryService(true);

    return true;
  }

  // Configure our contact sensors for HomeKit. Availability is determined by a combination of hub model, what's been configured on the hub, and feature options.
  private configureTerminalInputs(): boolean {

    const terminalInputs = [

      { input: "Dps", label: "Door Position Sensor" },
      { input: "Rel", label: "Remote Release" },
      { input: "Ren", label: "Request to Enter Sensor" },
      { input: "Rex", label: "Request to Exit Sensor" }
    ];

    for(const { input, label } of terminalInputs) {

      const hint = ("hasWiring" + input) as HasWiringHintKey;
      const reservedId = AccessReservedNames[("CONTACT_" + input.toUpperCase()) as keyof typeof AccessReservedNames];
      const state = ("hub" + input + "State") as HubStateKey;

      // Validate whether we should have this service enabled.
      if(!validService(this.accessory, this.hap.Service.ContactSensor, (hasService: boolean) => {

        if(!this.hints[hint] && hasService) {

          this.log.info("Disabling the " + label.toLowerCase() + ".");
        }

        return this.hints[hint];
      }, reservedId)) {

        continue;
      }

      // Acquire the service.
      const service = acquireService(this.accessory, this.hap.Service.ContactSensor, this.accessoryName + " " + label, reservedId,
        () => this.log.info("Enabling the " + label.toLowerCase() + "."));

      if(!service) {

        this.log.error("Unable to add the " + label.toLowerCase() + ".");

        continue;
      }

      // Initialize the sensor state.
      service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this[state]);
      service.updateCharacteristic(this.hap.Characteristic.StatusActive, !!this.uda.is_online);

      // If the hub has tamper indicator capabilities, let's reflect that in HomeKit.
      if(this.hasCapability("tamper_proofing")) {

        const tamperedEntry = this.uda.configs?.find(entry => entry.key === "tamper_event");

        if(tamperedEntry) {

          service.updateCharacteristic(this.hap.Characteristic.StatusTampered, (tamperedEntry.value === "true") ? this.hap.Characteristic.StatusTampered.TAMPERED :
            this.hap.Characteristic.StatusTampered.NOT_TAMPERED);
        }
      }
    }

    return true;
  }

  // Configure the main door for HomeKit - supports Lock, GarageDoorOpener, and Door service types.
  private configureLock(): boolean {

    // First, remove any previous service types that are no longer selected.
    const serviceTypes = [ this.hap.Service.LockMechanism, this.hap.Service.GarageDoorOpener, this.hap.Service.Door ];
    const selectedService = this.doorServiceType === "GarageDoorOpener" ? this.hap.Service.GarageDoorOpener :
      this.doorServiceType === "Door" ? this.hap.Service.Door : this.hap.Service.LockMechanism;

    for(const serviceType of serviceTypes) {

      if(serviceType !== selectedService) {

        const oldService = this.accessory.getServiceById(serviceType, AccessReservedNames.DOOR_MAIN) ??
          this.accessory.getService(serviceType);

        if(oldService && !oldService.subtype) {

          this.accessory.removeService(oldService);
        }
      }
    }

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, selectedService, this.hasCapability("is_hub"), AccessReservedNames.DOOR_MAIN)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, selectedService, this.accessoryName, AccessReservedNames.DOOR_MAIN,
      () => this.log.info("Configuring main door as %s service.", this.doorServiceType));

    if(!service) {

      this.log.error("Unable to add the door.");

      return false;
    }

    // Configure based on service type.
    if(this.doorServiceType === "GarageDoorOpener") {

      this.configureGarageDoorService(service, false);
    } else if(this.doorServiceType === "Door") {

      this.configureDoorService(service, false);
    } else {

      this.configureLockService(service, false);
    }

    // Initialize the state.
    this._hkLockState = -1;
    service.displayName = this.accessoryName;
    service.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName);
    this.hkLockState = this.hubLockState;

    service.setPrimaryService(true);

    return true;
  }

  // Configure a LockMechanism service.
  private configureLockService(service: ReturnType<typeof acquireService>, isSideDoor: boolean): void {

    if(!service) {

      return;
    }

    const lockStateGetter = isSideDoor ? (): CharacteristicValue => this.hkSideDoorLockState : (): CharacteristicValue => this.hkLockState;
    const lockCommand = isSideDoor ?
      async (lock: boolean): Promise<boolean> => this.hubSideDoorLockCommand(lock) :
      async (lock: boolean): Promise<boolean> => this.hubLockCommand(lock);

    service.getCharacteristic(this.hap.Characteristic.LockCurrentState).onGet(lockStateGetter);

    service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet(async (value: CharacteristicValue) => {

      if(!(await lockCommand(value === this.hap.Characteristic.LockTargetState.SECURED))) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.LockTargetState, !value), 50);
      }

      service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, lockStateGetter());
    });
  }

  // Configure a GarageDoorOpener service.
  private configureGarageDoorService(service: ReturnType<typeof acquireService>, isSideDoor: boolean): void {

    if(!service) {

      return;
    }

    const lockStateGetter = isSideDoor ? (): CharacteristicValue => this.hkSideDoorLockState : (): CharacteristicValue => this.hkLockState;
    const lockCommand = isSideDoor ?
      async (lock: boolean): Promise<boolean> => this.hubSideDoorLockCommand(lock) :
      async (lock: boolean): Promise<boolean> => this.hubLockCommand(lock);

    // Map lock state to door state: SECURED = CLOSED, UNSECURED = OPEN
    const getDoorState = (): CharacteristicValue => {

      const lockState = lockStateGetter();

      return lockState === this.hap.Characteristic.LockCurrentState.SECURED ?
        this.hap.Characteristic.CurrentDoorState.CLOSED : this.hap.Characteristic.CurrentDoorState.OPEN;
    };

    service.getCharacteristic(this.hap.Characteristic.CurrentDoorState).onGet(getDoorState);

    service.getCharacteristic(this.hap.Characteristic.TargetDoorState).onSet(async (value: CharacteristicValue) => {

      const shouldLock = value === this.hap.Characteristic.TargetDoorState.CLOSED;

      if(!(await lockCommand(shouldLock))) {

        // Revert target state on failure.
        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.TargetDoorState,
          value === this.hap.Characteristic.TargetDoorState.CLOSED ?
            this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED), 50);
      }

      service.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, getDoorState());
    });

    // ObstructionDetected is required - we always report no obstruction.
    service.getCharacteristic(this.hap.Characteristic.ObstructionDetected).onGet(() => false);
  }

  // Configure a Door service.
  private configureDoorService(service: ReturnType<typeof acquireService>, isSideDoor: boolean): void {

    if(!service) {

      return;
    }

    const lockStateGetter = isSideDoor ? (): CharacteristicValue => this.hkSideDoorLockState : (): CharacteristicValue => this.hkLockState;
    const lockCommand = isSideDoor ?
      async (lock: boolean): Promise<boolean> => this.hubSideDoorLockCommand(lock) :
      async (lock: boolean): Promise<boolean> => this.hubLockCommand(lock);

    // Map lock state to position: SECURED = 0 (closed), UNSECURED = 100 (open)
    const getPosition = (): CharacteristicValue => {

      const lockState = lockStateGetter();

      return lockState === this.hap.Characteristic.LockCurrentState.SECURED ? 0 : 100;
    };

    service.getCharacteristic(this.hap.Characteristic.CurrentPosition).onGet(getPosition);

    service.getCharacteristic(this.hap.Characteristic.TargetPosition).onSet(async (value: CharacteristicValue) => {

      // Treat anything < 50 as closed, >= 50 as open.
      const shouldLock = (value as number) < 50;

      if(!(await lockCommand(shouldLock))) {

        // Revert target position on failure.
        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.TargetPosition, getPosition()), 50);
      }

      service.updateCharacteristic(this.hap.Characteristic.CurrentPosition, getPosition());
    });

    // PositionState is required - we always report stopped since it's an instant action.
    service.getCharacteristic(this.hap.Characteristic.PositionState).onGet(() => this.hap.Characteristic.PositionState.STOPPED);
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hasCapability("door_bell") && this.hasFeature("Hub.Doorbell.Trigger"),
      AccessReservedNames.SWITCH_DOORBELL_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.accessoryName + " Doorbell Trigger",
      AccessReservedNames.SWITCH_DOORBELL_TRIGGER, () => this.log.info("Enabling the doorbell automation trigger."));

    if(!service) {

      this.log.error("Unable to add the doorbell automation trigger.");

      return false;
    }

    // Trigger the doorbell.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.doorbellRingRequestId !== null);

    // The state isn't really user-triggerable. We have no way, currently, to trigger a ring event on the hub.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(() => {

      setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, this.doorbellRingRequestId !== null), 50);
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.accessoryName + " Doorbell Trigger");
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure a switch to automate lock and unlock events in HomeKit beyond what HomeKit might allow for a lock service that gets treated as a secure service.
  private configureLockTrigger(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hasCapability("is_hub") && this.hasFeature("Hub.Lock.Trigger"),
      AccessReservedNames.SWITCH_LOCK_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.accessoryName + " Lock Trigger",
      AccessReservedNames.SWITCH_LOCK_TRIGGER, () => this.log.info("Enabling the lock automation trigger."));

    if(!service) {

      this.log.error("Unable to add the lock automation trigger.");

      return false;
    }

    // Trigger the doorbell.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.hkLockState !== this.hap.Characteristic.LockCurrentState.SECURED);

    // The state isn't really user-triggerable. We have no way, currently, to trigger a lock or unlock event on the hub.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // If we are on, we are in an unlocked state. If we are off, we are in a locked state.
      if(!(await this.hubLockCommand(!value))) {

        // Revert our state.
        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), 50);
      }
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.accessoryName + " Lock Trigger");
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure the side door for HomeKit (UA Gate only) - supports Lock, GarageDoorOpener, and Door service types.
  private configureSideDoorLock(): boolean {

    // First, remove any previous service types that are no longer selected.
    const serviceTypes = [ this.hap.Service.LockMechanism, this.hap.Service.GarageDoorOpener, this.hap.Service.Door ];
    const selectedService = this.sideDoorServiceType === "GarageDoorOpener" ? this.hap.Service.GarageDoorOpener :
      this.sideDoorServiceType === "Door" ? this.hap.Service.Door : this.hap.Service.LockMechanism;

    for(const serviceType of serviceTypes) {

      if(serviceType !== selectedService) {

        const oldService = this.accessory.getServiceById(serviceType, AccessReservedNames.LOCK_SIDE_DOOR);

        if(oldService) {

          this.accessory.removeService(oldService);
        }
      }
    }

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, selectedService, this.hints.hasSideDoor, AccessReservedNames.LOCK_SIDE_DOOR)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, selectedService, this.accessoryName + " Side Door", AccessReservedNames.LOCK_SIDE_DOOR,
      () => this.log.info("Configuring side door as %s service.", this.sideDoorServiceType));

    if(!service) {

      this.log.error("Unable to add the side door.");

      return false;
    }

    // Configure based on service type.
    if(this.sideDoorServiceType === "GarageDoorOpener") {

      this.configureGarageDoorService(service, true);
    } else if(this.sideDoorServiceType === "Door") {

      this.configureDoorService(service, true);
    } else {

      this.configureLockService(service, true);
    }

    // Initialize the lock.
    this._hkSideDoorLockState = -1;
    service.displayName = this.accessoryName + " Side Door";
    service.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName + " Side Door");
    this.hkSideDoorLockState = this.hubSideDoorLockState;

    return true;
  }

  // Configure a switch to automate side door lock and unlock events in HomeKit beyond what HomeKit might allow for a lock service that gets treated as a secure service.
  private configureSideDoorLockTrigger(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.hasSideDoor && this.hasFeature("Hub.SideDoor.Lock.Trigger"),
      AccessReservedNames.SWITCH_SIDEDOOR_LOCK_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.accessoryName + " Side Door Lock Trigger",
      AccessReservedNames.SWITCH_SIDEDOOR_LOCK_TRIGGER, () => this.log.info("Enabling the side door lock automation trigger."));

    if(!service) {

      this.log.error("Unable to add the side door lock automation trigger.");

      return false;
    }

    // Trigger the lock state.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.hkSideDoorLockState !== this.hap.Characteristic.LockCurrentState.SECURED);

    // The state isn't really user-triggerable. We have no way, currently, to trigger a lock or unlock event on the hub.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // If we are on, we are in an unlocked state. If we are off, we are in a locked state.
      if(!(await this.hubSideDoorLockCommand(!value))) {

        // Revert our state.
        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), 50);
      }
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.accessoryName + " Side Door Lock Trigger");
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure MQTT capabilities of this light.
  private configureMqtt(): boolean {

    const lockService = this.accessory.getService(this.hap.Service.LockMechanism);

    if(!lockService) {

      return false;
    }

    // MQTT doorbell status.
    this.controller.mqtt?.subscribeGet(this.id, "doorbell", "Doorbell ring", () => {

      return this.doorbellRingRequestId !== null ? "true" : "false";
    });

    // MQTT DPS status.
    this.controller.mqtt?.subscribeGet(this.id, "dps", "Door position sensor", () => {

      if(!this.isDpsWired) {

        return "unknown";
      }

      switch(this.hkDpsState) {

        case this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED:

          return "false";


        case this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED:

          return "true";

        default:

          return "unknown";
      }
    });

    // MQTT lock status.
    this.controller.mqtt?.subscribeGet(this.id, "lock", "Lock", () => {

      switch(this.hkLockState) {

        case this.hap.Characteristic.LockCurrentState.SECURED:

          return "true";

        case this.hap.Characteristic.LockCurrentState.UNSECURED:

          return "false";

        default:

          return "unknown";
      }
    });

    // MQTT lock status.
    this.controller.mqtt?.subscribeSet(this.id, "lock", "Lock", (value: string) => {

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

    // MQTT side door lock status (UA Gate only).
    if(this.hints.hasSideDoor) {

      this.controller.mqtt?.subscribeGet(this.id, "sidedoorlock", "Side Door Lock", () => {

        switch(this.hkSideDoorLockState) {

          case this.hap.Characteristic.LockCurrentState.SECURED:

            return "true";

          case this.hap.Characteristic.LockCurrentState.UNSECURED:

            return "false";

          default:

            return "unknown";
        }
      });

      this.controller.mqtt?.subscribeSet(this.id, "sidedoorlock", "Side Door Lock", (value: string) => {

        switch(value) {

          case "true":

            void this.hubSideDoorLockCommand(true);

            break;

          case "false":

            void this.hubSideDoorLockCommand(false);

            break;

          default:

            this.log.error("MQTT: Unknown side door lock set message received: %s.", value);

            break;
        }
      });
    }

    return true;
  }

  // Check and validate Ultra inputs with what the user has configured in HomeKit.
  private checkUltraInputs(): void {

    for(const input of [ "Dps", "Rex" ] as const) {

      const hint = ("hasWiring" + input) as HasWiringHintKey;
      const mode = input.toLowerCase();

      // Is the mode enabled on the hub?
      const isEnabled = this.uda.extensions?.[0]?.target_config?.some(entry => (entry.config_key === "rex_button_mode") && entry.config_value === mode);

      if(this.hints[hint] && !isEnabled) {

        // The hub has disabled this input.
        this.hints[hint] = false;
      } else if(!this.hints[hint] && isEnabled && this.hasFeature("Hub." + input.toUpperCase())) {

        // The hub has the input enabled, and we want it enabled in HomeKit.
        this.hints[hint] = true;
      }
    }
  }

  // Utility function to execute lock and unlock actions on a hub.
  private async hubLockCommand(isLocking: boolean): Promise<boolean> {

    const action = isLocking ? "lock" : "unlock";

    // Only allow relocking if we are able to do so.
    if((this.lockDelayInterval === undefined) && isLocking) {

      this.log.error("Unable to manually relock when the lock relay is configured to the default settings.");

      return false;
    }

    // If we're not online, we're done.
    if(!this.isOnline) {

      this.log.error("Unable to %s. Device is offline.", action);

      return false;
    }

    // Execute the action.
    if(!(await this.controller.udaApi.unlock(this.uda, (this.lockDelayInterval === undefined) ? undefined : (isLocking ? 0 : Infinity)))) {

      this.log.error("Unable to %s.", action);

      return false;
    }

    return true;
  }

  // Utility function to execute side door lock and unlock actions on a UA Gate hub.
  private async hubSideDoorLockCommand(isLocking: boolean): Promise<boolean> {

    const action = isLocking ? "lock" : "unlock";

    // Only allow relocking if we are able to do so.
    if((this.sideDoorLockDelayInterval === undefined) && isLocking) {

      this.log.error("Unable to manually relock the side door when the lock relay is configured to the default settings.");

      return false;
    }

    // If we're not online, we're done.
    if(!this.isOnline) {

      this.log.error("Unable to %s the side door. Device is offline.", action);

      return false;
    }

    // Try to get the side door location ID from extensions first (port_setting with target_name = "oper2").
    let sideDoorLocationId = this.uda.extensions?.find(ext => ext.extension_name === "port_setting" && ext.target_name === "oper2")?.target_value;

    // Get the primary door ID for this device (may be undefined if no door is bound).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const primaryDoorId = this.uda.door?.unique_id;

    // Debug logging.
    this.log.debug("Side door lookup - Device unique_id: %s, mac: %s, primary door: %s.",
      this.uda.unique_id, this.uda.mac, primaryDoorId);
    this.log.debug("Side door lookup - Extensions found: %s.", JSON.stringify(this.uda.extensions ?? []));
    this.log.debug("Side door lookup - Available doors: %d, floors: %d.",
      this.controller.udaApi.doors?.length ?? 0, this.controller.udaApi.floors?.length ?? 0);

    // If not found in extensions, try to find a second door associated with this hub.
    // This handles setups where the side door is configured as a separate door/location rather than oper2.
    if(!sideDoorLocationId && this.controller.udaApi.doors) {

      const doors = this.controller.udaApi.doors;
      const floors = this.controller.udaApi.floors;

      // Log all doors for debugging.
      for(const door of doors) {

        this.log.debug("Side door lookup - Door: %s (ID: %s), device_groups: %s.",
          door.name, door.unique_id, JSON.stringify(door.device_groups?.map(d => ({ id: d.unique_id, mac: d.mac })) ?? []));
      }

      // Strategy 1: Find a door that has this device in its device_groups.
      let sideDoor = doors.find(door => door.unique_id !== primaryDoorId &&
        door.device_groups?.some(device => device.unique_id === this.uda.unique_id || device.mac === this.uda.mac)
      );

      // Strategy 2: If device_groups didn't work, find another door on the same floor as the primary door.
      // This works for setups where doors are bound to the same hub but device_groups isn't populated.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if(!sideDoor && primaryDoorId && this.uda.floor?.unique_id) {

        const floorId = this.uda.floor.unique_id;

        this.log.debug("Side door lookup - Trying floor-based lookup. Floor ID: %s.", floorId);

        // Find another door on the same floor
        sideDoor = doors.find(door => door.unique_id !== primaryDoorId &&
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          floors?.some(floor => floor.unique_id === floorId && floor.doors?.some(fd => fd.unique_id === door.unique_id))
        );
      }

      // Strategy 3: If we only have 2 doors total, assume the other one is the side door.
      if(!sideDoor && primaryDoorId && doors.length === 2) {

        this.log.debug("Side door lookup - Using fallback: only 2 doors exist, using the other one.");
        sideDoor = doors.find(door => door.unique_id !== primaryDoorId);
      }

      // Strategy 4: If primary door is unknown but we have exactly 2 doors, find the door named "Portillon" or similar
      // (common naming for pedestrian/side gates in French-speaking regions).
      if(!sideDoor && !primaryDoorId && doors.length === 2) {

        this.log.debug("Side door lookup - Primary door unknown, searching by name pattern.");

        // Look for door with a name suggesting it's a side/pedestrian gate
        sideDoor = doors.find(door => /portillon|side|pedestrian|wicket|pieton/i.test(door.name)
        );

        // If no match by name, just pick the second door in the list
        sideDoor ??= doors[1];
      }

      // Strategy 5: If we still don't have a side door but have multiple doors, try to find one that matches
      // the device's floor (if floor info is available on the device).
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if(!sideDoor && !primaryDoorId && this.uda.floor && floors) {

        const deviceFloorId = this.uda.floor.unique_id;

        this.log.debug("Side door lookup - Searching doors on device floor: %s.", deviceFloorId);

        const floor = floors.find(f => f.unique_id === deviceFloorId);

        if(floor?.doors && floor.doors.length >= 2) {

          // Find a door on this floor that looks like a side door
          sideDoor = floor.doors.find(door => /portillon|side|pedestrian|wicket|pieton/i.test(door.name));

          // Just use the second door on the floor
          sideDoor ??= floor.doors[1];
        }
      }

      if(sideDoor) {

        this.log.debug("Found side door: %s (ID: %s).", sideDoor.name, sideDoor.unique_id);
        sideDoorLocationId = sideDoor.unique_id;
      }
    }

    if(!sideDoorLocationId) {

      this.log.error("Unable to %s the side door. Side door configuration not found.", action);

      return false;
    }

    // Execute the action using the side door location.
    const endpoint = this.controller.udaApi.getApiEndpoint("location") + "/" + sideDoorLocationId + "/unlock";

    const response = await this.controller.udaApi.retrieve(endpoint, {

      body: JSON.stringify({}),
      method: "PUT"
    });

    if(!this.controller.udaApi.responseOk(response?.statusCode)) {

      this.log.error("Unable to %s the side door.", action);

      return false;
    }

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

    // Update based on door service type.
    this.updateDoorServiceState(false);
  }

  // Update door service state based on configured service type.
  private updateDoorServiceState(isSideDoor: boolean): void {

    const serviceType = isSideDoor ? this.sideDoorServiceType : this.doorServiceType;
    const subtype = isSideDoor ? AccessReservedNames.LOCK_SIDE_DOOR : AccessReservedNames.DOOR_MAIN;
    const lockState = isSideDoor ? this.hkSideDoorLockState : this.hkLockState;
    const triggerSubtype = isSideDoor ? AccessReservedNames.SWITCH_SIDEDOOR_LOCK_TRIGGER : AccessReservedNames.SWITCH_LOCK_TRIGGER;

    if(serviceType === "GarageDoorOpener") {

      const service = this.accessory.getServiceById(this.hap.Service.GarageDoorOpener, subtype);

      if(service) {

        const doorState = lockState === this.hap.Characteristic.LockCurrentState.SECURED ?
          this.hap.Characteristic.CurrentDoorState.CLOSED : this.hap.Characteristic.CurrentDoorState.OPEN;
        const targetState = lockState === this.hap.Characteristic.LockCurrentState.SECURED ?
          this.hap.Characteristic.TargetDoorState.CLOSED : this.hap.Characteristic.TargetDoorState.OPEN;

        service.updateCharacteristic(this.hap.Characteristic.TargetDoorState, targetState);
        service.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, doorState);
      }
    } else if(serviceType === "Door") {

      const service = this.accessory.getServiceById(this.hap.Service.Door, subtype);

      if(service) {

        const position = lockState === this.hap.Characteristic.LockCurrentState.SECURED ? 0 : 100;

        service.updateCharacteristic(this.hap.Characteristic.TargetPosition, position);
        service.updateCharacteristic(this.hap.Characteristic.CurrentPosition, position);
      }
    } else {

      const service = this.accessory.getServiceById(this.hap.Service.LockMechanism, subtype);

      if(service) {

        service.updateCharacteristic(this.hap.Characteristic.LockTargetState, lockState === this.hap.Characteristic.LockCurrentState.UNSECURED ?
          this.hap.Characteristic.LockTargetState.UNSECURED : this.hap.Characteristic.LockTargetState.SECURED);
        service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, lockState);
      }
    }

    // Update the lock trigger switch if enabled.
    this.accessory.getServiceById(this.hap.Service.Switch, triggerSubtype)?.updateCharacteristic(this.hap.Characteristic.On,
      lockState !== this.hap.Characteristic.LockCurrentState.SECURED);
  }

  // Return the current HomeKit side door lock state that we are tracking for this hub.
  private get hkSideDoorLockState(): CharacteristicValue {

    return this._hkSideDoorLockState;
  }

  // Set the current HomeKit side door lock state for this hub.
  private set hkSideDoorLockState(value: CharacteristicValue) {

    // If nothing is changed, we're done.
    if(this.hkSideDoorLockState === value) {

      return;
    }

    // Update the lock state.
    this._hkSideDoorLockState = value;

    // Update based on door service type.
    this.updateDoorServiceState(true);
  }

  // Return the current state of the DPS on the hub.
  private get hubDpsState(): CharacteristicValue {

    // If we don't have the wiring connected for the DPS, we report our default closed state.
    if(!this.isDpsWired) {

      return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    let relayType;

    switch(this.uda.device_type) {

      case "UA-Hub-Door-Mini":
      case "UA-ULTRA":

        relayType = "input_d1_dps";

        break;

      case "UGT":

        relayType = "input_gate_dps";

        break;

      default:

        relayType = "input_state_dps";

        break;
    }

    // Return our DPS state. If it's anything other than on, we assume it's open.
    return (this.uda.configs?.find(entry => entry.key === relayType)?.value === "on") ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED :
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // Return the current state of the relay lock on the hub.
  private get hubLockState(): CharacteristicValue {

    let relayType;

    switch(this.uda.device_type) {

      case "UA-Hub-Door-Mini":
      case "UA-ULTRA":

        relayType = "output_d1_lock_relay";

        break;

      case "UGT":

        relayType = "output_oper1_relay";

        break;

      default:

        relayType = "input_state_rly-lock_dry";

        break;
    }

    const lockRelay = this.uda.configs?.find(entry => entry.key === relayType);

    return (lockRelay?.value === "off") ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED;
  }

  // Return the current state of the side door relay lock on the UA Gate hub.
  private get hubSideDoorLockState(): CharacteristicValue {

    // Side door lock is only available on UA Gate.
    if(this.uda.device_type !== "UGT") {

      return this.hap.Characteristic.LockCurrentState.SECURED;
    }

    const lockRelay = this.uda.configs?.find(entry => entry.key === "output_oper2_relay");

    return (lockRelay?.value === "off") ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED;
  }

  // Return the current state of the REL on the hub.
  private get hubRelState(): CharacteristicValue {

    // If we don't have the wiring connected for the REL, we report our default closed state.
    if(!this.isRelWired) {

      return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    let relayType;

    switch(this.uda.device_type) {

      case "UAH":

        relayType = "input_state_rel";

        break;

      default:

        return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    // Return our REL state. If it's anything other than on, we assume it's open.
    return (this.uda.configs?.find(relay => relay.key === relayType)?.value === "on") ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED :
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // Return the current state of the REN on the hub.
  private get hubRenState(): CharacteristicValue {

    // If we don't have the wiring connected for the REN, we report our default closed state.
    if(!this.isRenWired) {

      return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    let relayType;

    switch(this.uda.device_type) {

      case "UAH":

        relayType = "input_state_ren";

        break;

      default:

        return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    // Return our REN state. If it's anything other than on, we assume it's open.
    return (this.uda.configs?.find(relay => relay.key === relayType)?.value === "on") ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED :
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // Return the current state of the REX on the hub.
  private get hubRexState(): CharacteristicValue {

    // If we don't have the wiring connected for the REX, we report our default closed state.
    if(!this.isRexWired) {

      return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    let relayType;

    switch(this.uda.device_type) {

      case "UA-Hub-Door-Mini":
      case "UA-ULTRA":

        relayType = "input_d1_button";

        break;

      case "UAH":

        relayType = "input_state_rex";

        break;

      default:

        return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    // Return our REX state. If it's anything other than on, we assume it's open.
    return (this.uda.configs?.find(relay => relay.key === relayType)?.value === "on") ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED :
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // Utility to check the wiring state of a given terminal input.
  private isWired(input: SensorInput): boolean {

    // UA-ULTRA proxies via button mode.
    if((this.uda.device_type === "UA-ULTRA") && sensorWiring[input].proxyMode) {

      return this.uda.extensions?.[0]?.target_config?.some(e => e.config_key === "rex_button_mode" && e.config_value === sensorWiring[input].proxyMode) ?? false;
    }

    // Find the wiring keys for this model.
    const wires = sensorWiring[input].wiring?.[this.uda.device_type];

    if(!wires) {

      return false;
    }

    // All wires must be on for us to return true.
    return wires.every(wire => this.uda.configs?.some(e => (e.key === wire) && (e.value === "on")));
  }

  // Utility to retrieve a contact sensor state.
  private getContactSensorState(name: AccessReservedNames): CharacteristicValue {

    return this.accessory.getServiceById(this.hap.Service.ContactSensor, name)?.getCharacteristic(this.hap.Characteristic.ContactSensorState).value ??
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // Utility to set a contact sensor state.
  private setContactSensorState(name: AccessReservedNames, value: CharacteristicValue): void {

    this.accessory.getServiceById(this.hap.Service.ContactSensor, name)?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, value);
  }

  // Utility to validate hub capabilities.
  private hasCapability(capability: string | string[]): boolean {

    return Array.isArray(capability) ? capability.some(c => this.uda.capabilities.includes(c)) : this.uda.capabilities.includes(capability);
  }

  // Handle hub-related events.
  private eventHandler(packet: AccessEventPacket): void {

    const terminalInputs = [

      { input: "Dps", label: "Door position sensor", topic: "dps" },
      { input: "Rel", label: "Remote release", topic: "rel" },
      { input: "Ren", label: "Request to enter sensor", topic: "ren" },
      { input: "Rex", label: "Request to exit sensor", topic: "rex" }
    ];

    switch(packet.event) {

      case "access.data.device.remote_unlock":

        // Process an Access unlock event.
        this.hkLockState = this.hap.Characteristic.LockCurrentState.UNSECURED;

        // Publish to MQTT, if configured to do so.
        this.controller.mqtt?.publish(this.id, "lock", "false");

        if(this.hints.logLock) {

          this.log.info("Unlocked.");
        }

        break;

      case "access.data.device.update":

        // Process a lock update event if our state has changed.
        if(this.hubLockState !== this.hkLockState) {

          this.hkLockState = this.hubLockState;

          this.controller.mqtt?.publish(this.id, "lock", this.hkLockState === this.hap.Characteristic.LockCurrentState.SECURED ? "true" : "false");

          if(this.hints.logLock) {

            this.log.info(this.hkLockState === this.hap.Characteristic.LockCurrentState.SECURED ? "Locked." : "Unlocked.");
          }
        }

        // Process a side door lock update event if our state has changed (UA Gate only).
        if(this.hints.hasSideDoor && (this.hubSideDoorLockState !== this.hkSideDoorLockState)) {

          this.hkSideDoorLockState = this.hubSideDoorLockState;

          this.controller.mqtt?.publish(this.id, "sidedoorlock", this.hkSideDoorLockState === this.hap.Characteristic.LockCurrentState.SECURED ? "true" : "false");

          if(this.hints.logSideDoorLock) {

            this.log.info("Side door " + (this.hkSideDoorLockState === this.hap.Characteristic.LockCurrentState.SECURED ? "locked." : "unlocked."));
          }
        }

        // Process any terminal input update events if our state has changed.
        for(const { input, topic, label } of terminalInputs) {

          const hasKey = ("hasWiring" + input) as HasWiringHintKey;
          const hkKey = ("hk" + input + "State") as HkStateKey;
          const hubKey = ("hub" + input + "State") as HubStateKey;
          const logKey = ("log" + input) as LogHintKey;
          const wiredKey = ("is" + input + "Wired") as WiredKey;

          if(this.hints[hasKey] && this[hubKey] !== this[hkKey]) {

            this[hkKey] = this[hubKey];

            if(this[wiredKey]) {

              const contactDetected = this[hkKey] === this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;

              this.controller.mqtt?.publish(this.id, topic, contactDetected ? "false" : "true");

              if(this.hints[logKey]) {

                this.log.info(label + " " + (contactDetected ? "closed" : "open") + ".");
              }
            }
          }
        }

        // Process any changes to terminal input configuration.
        if((packet.data as AccessDeviceConfig).extensions?.[0]?.target_config && (this.uda.display_model === "UA Ultra")) {

          // Ensure we sync our state with HomeKit.
          this.checkUltraInputs();
          this.configureTerminalInputs();
        }

        // Process any changes to our online status.
        if((packet.data as AccessDeviceConfig).is_online !== undefined) {

          for(const sensor of Object.keys(AccessReservedNames).filter(key => key.startsWith("CONTACT_"))) {

            this.accessory.getServiceById(this.hap.Service.ContactSensor, AccessReservedNames[sensor as keyof typeof AccessReservedNames])?.
              updateCharacteristic(this.hap.Characteristic.StatusActive, !!(packet.data as AccessDeviceConfig).is_online);
          }
        }

        break;

      case "access.data.v2.device.update":

        if((packet.data as AccessEventDeviceUpdateV2).access_method) {

          const accessMethodData = (packet.data as AccessEventDeviceUpdateV2).access_method as { [K in AccessMethodKey]?: "yes" | "no" };

          // Process access method updates.
          for(const [ key, value ] of Object.entries(accessMethodData) as [AccessMethodKey, "yes" | "no"][]) {

            const accessMethod = accessMethods.find(entry => entry.key === key);

            if(!accessMethod) {

              continue;
            }

            // Update any access method switches we have enabled with the current value.
            this.accessory.getServiceById(this.hap.Service.Switch, accessMethod.subtype)?.updateCharacteristic(this.hap.Characteristic.On, value === "yes");
          }
        }

        break;

      case "access.remote_view":

        // Process an Access ring event if we're the intended target.
        if(((packet.data as AccessEventDoorbellRing).connected_uah_id !== this.uda.unique_id) || !this.hasCapability("door_bell")) {

          break;
        }

        this.doorbellRingRequestId = (packet.data as AccessEventDoorbellRing).request_id;

        // Trigger the doorbell event in HomeKit.
        this.accessory.getService(this.hap.Service.Doorbell)?.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
          ?.sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

        // Update our doorbell trigger, if needed.
        this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, true);

        // Publish to MQTT, if configured to do so.
        this.controller.mqtt?.publish(this.id, "doorbell", "true");

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

        // Publish to MQTT, if configured to do so.
        this.controller.mqtt?.publish(this.id, "doorbell", "false");

        if(this.hints.logDoorbell) {

          this.log.info("Doorbell ring cancelled.");
        }

        break;

      default:

        break;
    }
  }

  // We dynamically define our getters and setters for terminal inputs so we can streamline redundancies. Yes, this is fancy...but it's meant to future-proof a bit
  // against whatever Ubiquiti may do in the future given the inconsistencies in their API implementation for Access across devices of even similar types.
  static {

    // We define the specific sensor input properties we need.
    for(const input of sensorInputs) {

      let propName = "hk" + input + "State";
      const enumKey = "CONTACT_" + input.toUpperCase();

      Object.defineProperty(AccessHub.prototype, propName, {

        configurable: true,
        enumerable: true,
        get(this: AccessHub) {

          // Delegate to our individual helper functions.
          return this.getContactSensorState(AccessReservedNames[enumKey as keyof typeof AccessReservedNames]);
        },

        set(this: AccessHub, value: CharacteristicValue) {

          this.setContactSensorState(AccessReservedNames[enumKey as keyof typeof AccessReservedNames], value);
        }
      });

      // Now define our wiring getters.
      propName = "is" + input + "Wired";

      Object.defineProperty(AccessHub.prototype, propName, {

        configurable: true,
        enumerable: true,
        get(this: AccessHub) {

          return this.isWired(input);
        }
      });
    }
  }
}
