/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-device.ts: Base class for all UniFi Access devices.
 */
import { ACCESS_MOTION_DURATION, ACCESS_OCCUPANCY_DURATION } from "./settings.js";
import type { API, CharacteristicValue, HAP, PlatformAccessory } from "homebridge";
import type { AccessApi, AccessDeviceConfig, AccessEventPacket } from "unifi-access";
import { type HomebridgePluginLogging, type Nullable, sanitizeName } from "homebridge-plugin-utils";
import type { AccessController } from "./access-controller.js";
import type { AccessPlatform } from "./access-platform.js";
import { AccessReservedNames } from "./access-types.js";
import util from "node:util";

// Device-specific options and settings.
export interface AccessHints {

  enabled: boolean;
  hasMethodFace: boolean;
  hasMethodHand: boolean;
  hasMethodMobile: boolean;
  hasMethodNfc: boolean;
  hasMethodPin: boolean;
  hasMethodQr: boolean;
  hasMethodTwoStep: boolean;
  hasSideDoor: boolean;
  hasWiringDps: boolean;
  hasWiringRel: boolean;
  hasWiringRen: boolean;
  hasWiringRex: boolean;
  hasWiringSideDoorDps: boolean;
  ledStatus: boolean;
  logDoorbell: boolean;
  logDps: boolean;
  logLock: boolean;
  logMotion: boolean;
  logRel: boolean;
  logRen: boolean;
  logRex: boolean;
  motionDuration: number;
  occupancyDuration: number;
  syncName: boolean;
}

export abstract class AccessBase {

  public readonly api: API;
  private debug: (message: string, ...parameters: unknown[]) => void;
  protected readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
  public readonly controller: AccessController;
  public udaApi: AccessApi;
  public readonly platform: AccessPlatform;

  // The constructor initializes key variables and calls configureDevice().
  constructor(controller: AccessController) {

    this.api = controller.platform.api;
    this.debug = controller.platform.debug.bind(this);
    this.hap = this.api.hap;
    this.controller = controller;
    this.udaApi = controller.udaApi;
    this.platform = controller.platform;

    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => controller.platform.debug(util.format(this.name + ": " + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => controller.platform.log.error(util.format(this.name + ": " + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => controller.platform.log.info(util.format(this.name + ": " + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => controller.platform.log.warn(util.format(this.name + ": " + message, ...parameters))
    };
  }

  // Configure the device information for HomeKit.
  protected setInfo(accessory: PlatformAccessory, device: AccessDeviceConfig): boolean {

    // Update the manufacturer information for this device.
    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Ubiquiti Inc.");

    // Update the model information for this device.
    const deviceModel = device.display_model ?? device.model;

    if(deviceModel.length) {

      accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model, deviceModel);
    }

    // Update the serial number for this device.
    if(device.mac.length) {

      accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.SerialNumber,
        device.mac.replace(/:/g, "").toUpperCase());
    }

    // Update the firmware revision for this device.
    if(device.firmware.length) {

      // Capture the version of the device firmware, ensuring we get major, minor, and patch levels if they exist.
      const versionRegex = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(.+))?$/;
      const match: Nullable<(string | undefined)[]> = versionRegex.exec(device.firmware);

      // Update our firmware revision.
      accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision,
        match ? match[1] + "." + (match[2] ?? "0") + "." + (match[3] ?? "0") : device.firmware);
    }

    return true;
  }

  // Utility function to return the fully enumerated name of this device.
  public get name(): string {

    return this.controller.udaApi.name;
  }
}

export abstract class AccessDevice extends AccessBase {

  public accessory!: PlatformAccessory;
  public hints: AccessHints;
  protected listeners: { [index: string]: (packet: AccessEventPacket) => void };
  public abstract uda: AccessDeviceConfig;

  // The constructor initializes key variables and calls configureDevice().
  constructor(controller: AccessController, accessory: PlatformAccessory) {

    // Call the constructor of our base class.
    super(controller);

    this.hints = {} as AccessHints;
    this.listeners = {};

    // Set the accessory.
    this.accessory = accessory;
  }

  // Configure device-specific settings.
  protected configureHints(): boolean {

    this.hints.enabled = this.hasFeature("Device");
    this.hints.logMotion = this.hasFeature("Log.Motion");
    this.hints.motionDuration = this.getFeatureNumber("Motion.Duration") ?? ACCESS_MOTION_DURATION;
    this.hints.occupancyDuration = this.getFeatureNumber("Motion.OccupancySensor.Duration") ?? ACCESS_OCCUPANCY_DURATION;
    this.hints.syncName = this.hasFeature("Device.SyncName");

    // Sanity check motion detection duration. Make sure it's never less than 2 seconds so we can actually alert the user.
    if(this.hints.motionDuration < 2) {

      this.hints.motionDuration = 2;
    }

    // Sanity check occupancy detection duration. Make sure it's never less than 60 seconds so we can actually alert the user.
    if(this.hints.occupancyDuration < 60) {

      this.hints.occupancyDuration = 60;
    }

    // Inform the user if we've opted for something other than the defaults.
    if(this.hints.syncName) {

      this.log.info("Syncing Access device name to HomeKit.");
    }

    if(this.hints.motionDuration !== ACCESS_MOTION_DURATION) {

      this.log.info("Motion event duration set to %s seconds.", this.hints.motionDuration);
    }

    if(this.hints.occupancyDuration !== ACCESS_OCCUPANCY_DURATION) {

      this.log.info("Occupancy event duration set to %s seconds.", this.hints.occupancyDuration);
    }

    return true;
  }

  // Configure the device information details for HomeKit.
  public configureInfo(): boolean {

    // Sync the Access name with HomeKit, if configured.
    if(this.hints.syncName && this.uda.alias) {

      this.accessoryName = this.uda.alias;
    }

    return this.setInfo(this.accessory, this.uda);
  }

  // Cleanup our event handlers and any other activities as needed.
  public cleanup(): void {

    for(const eventName of Object.keys(this.listeners)) {

      this.controller.events.removeListener(eventName, this.listeners[eventName]);
      delete this.listeners[eventName];
    }
  }

  // Configure the Access motion sensor for HomeKit.
  protected configureMotionSensor(isEnabled = true, isInitialized = false): boolean {

    // Find the motion sensor service, if it exists.
    let motionService = this.accessory.getService(this.hap.Service.MotionSensor);

    // Have we disabled the motion sensor?
    if(!isEnabled) {

      if(motionService) {

        this.accessory.removeService(motionService);
        this.controller.mqtt?.unsubscribe(this.id, "motion/trigger");
        this.log.info("Disabling motion sensor.");
      }

      this.configureMotionSwitch(isEnabled);
      this.configureMotionTrigger(isEnabled);

      return false;
    }

    // We don't have a motion sensor, let's add it to the device.
    if(!motionService) {

      // We don't have it, add the motion sensor to the device.
      motionService = new this.hap.Service.MotionSensor(this.accessoryName);

      this.accessory.addService(motionService);
      isInitialized = false;

      this.log.info("Enabling motion sensor.");
    }

    // Have we previously initialized this sensor? We assume not by default, but this allows for scenarios where you may be dynamically reconfiguring a sensor at
    // runtime (e.g. UniFi sensors can be reconfigured for various sensor modes in realtime).
    if(!isInitialized) {

      // Initialize the state of the motion sensor.
      motionService.displayName = this.accessoryName;
      motionService.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName);
      motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      motionService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

      motionService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

        return this.isOnline;
      });

      // Configure our MQTT support.
      this.configureMqttMotionTrigger();

      // Configure any motion switches or triggers the user may have enabled or disabled.
      this.configureMotionSwitch(isEnabled);
      this.configureMotionTrigger(isEnabled);
    }

    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  private configureMotionSwitch(isEnabled = true): boolean {

    // Find the switch service, if it exists.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_MOTION_SENSOR);

    // Motion switches are disabled by default unless the user enables them.
    if(!isEnabled || !this.hasFeature("Motion.Switch")) {

      if(switchService) {

        this.accessory.removeService(switchService);
      }

      // If we disable the switch, make sure we fully reset it's state. Otherwise, we can end up in a situation (e.g. liveview switches) where we have
      // disabled motion detection with no meaningful way to enable it again.
      this.accessory.context.detectMotion = true;

      return false;
    }

    this.log.info("Enabling motion sensor switch.");

    const switchName = this.accessoryName + " Motion Events";

    // Add the switch to the device, if needed.
    if(!switchService) {

      switchService = new this.hap.Service.Switch(switchName, AccessReservedNames.SWITCH_MOTION_SENSOR);

      switchService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      this.accessory.addService(switchService);
    }

    // Activate or deactivate motion detection.
    switchService.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

      return this.accessory.context.detectMotion === true;
    });

    switchService.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      if(this.accessory.context.detectMotion !== value) {

        this.log.info("Motion detection %s.", (value === true) ? "enabled" : "disabled");
      }

      this.accessory.context.detectMotion = value === true;
    });

    // Initialize the switch state.
    if(!("detectMotion" in this.accessory.context)) {

      this.accessory.context.detectMotion = true;
    }

    switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, switchName);
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.detectMotion as boolean);

    return true;
  }

  // Configure a switch to manually trigger a motion sensor event for HomeKit.
  private configureMotionTrigger(isEnabled = true): boolean {

    // Find the switch service, if it exists.
    let triggerService = this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_MOTION_TRIGGER);

    // Motion triggers are disabled by default and primarily exist for automation purposes.
    if(!isEnabled || !this.hasFeature("Motion.Trigger")) {

      if(triggerService) {

        this.accessory.removeService(triggerService);
      }

      return false;
    }

    const triggerName = this.accessoryName + " Motion Trigger";

    // Add the switch to the device, if needed.
    if(!triggerService) {

      triggerService = new this.hap.Service.Switch(triggerName, AccessReservedNames.SWITCH_MOTION_TRIGGER);

      triggerService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      this.accessory.addService(triggerService);
    }

    const motionService = this.accessory.getService(this.hap.Service.MotionSensor);
    const switchService = this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_MOTION_SENSOR);

    // Activate or deactivate motion detection.
    triggerService.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

      return motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value === true;
    });

    triggerService.getCharacteristic(this.hap.Characteristic.On).onSet((isOn: CharacteristicValue) => {

      if(isOn) {

        // Check to see if motion events are disabled.
        if(switchService && !switchService.getCharacteristic(this.hap.Characteristic.On).value) {

          setTimeout(() => triggerService.updateCharacteristic(this.hap.Characteristic.On, false), 50);

        } else {

          // Trigger the motion event.
          this.controller.events.motionEventHandler(this);

          // Inform the user.
          this.log.info("Motion event triggered.");
        }

        return;
      }

      // If the motion sensor is still on, we should be as well.
      if(motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value) {

        setTimeout(() => triggerService.updateCharacteristic(this.hap.Characteristic.On, true), 50);
      }
    });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, triggerName);
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling motion sensor automation trigger.");

    return true;
  }

  // Configure MQTT motion triggers.
  private configureMqttMotionTrigger(): boolean {

    // Trigger a motion event in MQTT, if requested to do so.
    this.controller.mqtt?.subscribe(this.id, "motion/trigger", (message: Buffer) => {

      const value = message.toString();

      // When we get the right message, we trigger the motion event.
      if(value.toLowerCase() !== "true") {

        return;
      }

      // Trigger the motion event.
      this.controller.events.motionEventHandler(this);
      this.log.info("Motion event triggered via MQTT.");
    });

    return true;
  }

  // Configure the Access occupancy sensor for HomeKit.
  protected configureOccupancySensor(isEnabled = true, isInitialized = false): boolean {

    // Find the occupancy sensor service, if it exists.
    let occupancyService = this.accessory.getService(this.hap.Service.OccupancySensor);

    // Occupancy sensors are disabled by default and primarily exist for automation purposes.
    if(!isEnabled || !this.hasFeature("Motion.OccupancySensor")) {

      if(occupancyService) {

        this.accessory.removeService(occupancyService);
        this.log.info("Disabling occupancy sensor.");
      }

      return false;
    }

    // We don't have an occupancy sensor, let's add it to the device.
    if(!occupancyService) {

      // We don't have it, add the occupancy sensor to the device.
      occupancyService = new this.hap.Service.OccupancySensor(this.accessoryName);

      this.accessory.addService(occupancyService);
    }

    // Have we previously initialized this sensor? We assume not by default, but this allows for scenarios where you may be dynamically reconfiguring a sensor at
    // runtime (e.g. UniFi sensors can be reconfigured for various sensor modes in realtime).
    if(!isInitialized) {

      // Initialize the state of the occupancy sensor.
      occupancyService.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
      occupancyService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

      occupancyService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

        return this.isOnline;
      });

      this.log.info("Enabling occupancy sensor.");
    }

    return true;
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getFloat(option, this.id, this.controller.id);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.id, this.controller.id);
  }

  // Utility function to return a configuration parameter on a device.
  public getFeatureValue(option: string): Nullable<string | undefined> {

    return this.platform.featureOptions.value(option, this.id, this.controller.id);
  }

  // Utility for checking feature options on a device.
  public hasFeature(option: string): boolean {

    return this.controller.hasFeature(option, this.uda);
  }

  // Utility function for reserved identifiers for switches.
  public isReservedName(name: string | undefined): boolean {

    return name === undefined ? false : Object.values(AccessReservedNames).map(x => x.toUpperCase()).includes(name.toUpperCase());
  }

  // Utility function to determine whether or not a device is currently online.
  public get isOnline(): boolean {

    return ([ "is_adopted", "is_connected", "is_managed", "is_online" ] as const).every(key => this.uda[key]);
  }

  // Return a unique identifier for an Access device.
  public get id(): string {

    return this.uda.mac.replace(/:/g, "") + ((this.uda.device_type === "UAH-Ent") ? "-" + this.uda.source_id.toUpperCase() : "");
  }

  // Utility function to return the fully enumerated name of this device.
  public get name(): string {

    return this.controller.udaApi.getFullName(this.uda);
  }

  // Utility function to return the current accessory name of this device.
  public get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string | undefined) ??
      (this.uda.alias ?? "Unknown");
  }

  // Utility function to set the current accessory name of this device.
  public set accessoryName(name: string) {

    const cleanedName = sanitizeName(name);

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = cleanedName;
    this.accessory._associatedHAPAccessory.displayName = cleanedName;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, cleanedName);
  }
}
