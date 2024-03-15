/* Copyright(C) 2020-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-options.ts: Feature option and type definitions for UniFi Access.
 */
import { ACCESS_DEVICE_REMOVAL_DELAY_INTERVAL, ACCESS_DEVICE_UNLOCK_INTERVAL } from "./settings.js";
import { AccessControllerConfig, AccessDeviceConfig } from "unifi-access";

// Plugin configuration options.
export interface AccessOptions {

  controllers: AccessControllerOptions[],
  debugAll: boolean,
  options: string[],
  ringDelay: number
}

// Controller configuration options.
export interface AccessControllerOptions {

  address: string,
  mqttTopic: string,
  mqttUrl: string,
  name: string,
  username: string,
  password: string
}

// Feature option categories.
export const featureOptionCategories = [

  { description: "Device feature options.", modelKey: [ "all" ], name: "Device" },
  { description: "Controller feature options.", modelKey: [ "controller" ], name: "Controller" },
  { description: "Hub feature options.", modelKey: [ "UA Hub" ], name: "Hub" },
  { description: "Logging feature options.", modelKey: [ "all" ], name: "Log" }
];

/* eslint-disable @stylistic/max-len */
// Individual feature options, broken out by category.
export const featureOptions: { [index: string]: FeatureOption[] } = {

  // Controller options.
  "Controller": [

    { default: false, defaultValue: ACCESS_DEVICE_REMOVAL_DELAY_INTERVAL, description: "Delay, in seconds, before removing devices that are no longer detected on the Access controller. By default, devices are added and removed in realtime.", name: "DelayDeviceRemoval" },
    { default: false, description: "Publish all the realtime telemetry received from the Access controller to MQTT.", name: "Publish.Telemetry" }
  ],

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: false, description: "Synchronize the UniFi Access name of this device with HomeKit. Synchronization is one-way only, syncing the device name from UniFi Access to HomeKit.",  name: "SyncName" }
  ],

  // Hub options.
  "Hub": [

    { default: false, defaultValue: ACCESS_DEVICE_UNLOCK_INTERVAL, description: "Delay, in minutes, before locking the door lock relay, once it's been unlocked by HomeKit. If set to 0, it will remain unlocked indefinitely. By default, the door lock relay will lock five seconds after unlocking.", name: "LockDelayInterval" },
    { default: false, description: "Add a switch accessory to control the lock. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling locks and triggering events when a lock or unlock event occurs.", name: "Lock.Trigger" },
    { default: true, description: "Add a doorbell accessory to handle doorbell ring events in HomeKit.", hasFeature: [ "door_bell" ], name: "Doorbell" },
    { default: false, description: "Add a switch accessory for automation scenarios to reflect (but not trigger) doorbell ring events on an Access doorbell.", hasFeature: [ "door_bell" ], name: "Doorbell.Trigger" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log doorbell ring events in Homebridge.", hasFeature: [ "door_bell" ], name: "Doorbell" },
    { default: true, description: "Log lock events in Homebridge.", modelKey: [ "UA Hub" ], name: "Lock" }
  ]
};
/* eslint-enable max-len */

export interface FeatureOption {

  default: boolean,                   // Default feature option state.
  defaultValue?: number | string,     // Default value for value-based feature options.
  description: string,                // Description of the feature option.
  group?: string,                     // Feature option grouping for related options.
  hasFeature?: string[],              // What hardware-specific features, if any, is this feature option dependent on.
  hasProperty?: string[],             // What UFP JSON property, if any, is this feature option dependent on.
  hasSmartObjectType?: string[],      // What smart object detection capability, is any, is this feature option dependent on.
  modelKey?: string[],                // Which Access hardware is this feature option applicable to.
  name: string                        // Name of the feature option.
}

// Utility function to let us know whether a feature option should be enabled or not, traversing the scope hierarchy.
export function isOptionEnabled(configOptions: string[], controller: AccessControllerConfig | null, device: AccessControllerConfig | AccessDeviceConfig | null,
  option = "", defaultReturnValue = true): boolean {

  // There are a couple of ways to enable and disable options. The rules of the road are:
  //
  // 1. Explicitly disabling, or enabling an option on the controller propagates to all the devices that are managed by that controller. Why might you want to do this?
  //    Because...
  //
  // 2. Explicitly disabling, or enabling an option on a device by its MAC address will always override the above. This means that it's possible to disable an option for a
  //    controller, and all the devices that are managed by it, and then override that behavior on a single device that it's managing.

  // Nothing configured - we assume the default return value.
  if(!configOptions.length) {

    return defaultReturnValue;
  }

  const isOptionSet = (checkOption: string, checkMac: string | undefined = undefined): boolean | undefined => {

    // This regular expression is a bit more intricate than you might think it should be due to the need to ensure we capture values at the very end of the option.
    const optionRegex = new RegExp("^(Enable|Disable)\\." + checkOption + (!checkMac ? "" : "\\." + checkMac.replace(/:/g, "")) + "$", "gi");

    // Get the option value, if we have one.
    for(const entry of configOptions) {

      const regexMatch = optionRegex.exec(entry);

      if(regexMatch) {

        return regexMatch[1].toLowerCase() === "enable";
      }
    }

    return undefined;
  };

  // Escape out our option to ensure we have no inadvertent issues in matching the regular expression.
  option = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Check to see if we have a device-level option first.
  let deviceMac = null;

  // Let's figure out if we've been passed a controller configuration or a device one and extract the MAC.
  if(device && ("host" in device)) {

    deviceMac = device.host.mac;
  } else {

    deviceMac = device?.mac;
  }

  if(deviceMac) {

    const value = isOptionSet(option, deviceMac);

    if(value !== undefined) {

      return value;
    }
  }

  // Now check to see if we have a controller-level option.
  if(controller?.host?.mac) {

    const value = isOptionSet(option, controller.host.mac);

    if(value !== undefined) {

      return value;
    }
  }

  // Finally, we check for a global-level value.
  const value = isOptionSet(option);

  if(value !== undefined) {

    return value;
  }

  // The option hasn't been set at any scope, return our default value.
  return defaultReturnValue;
}

// Utility function to return a value-based feature option for an Access device.
export function getOptionValue(configOptions: string[], controller: AccessControllerConfig | null, device: AccessControllerConfig | AccessDeviceConfig | null,
  option: string): string | undefined {

  // Nothing configured - we assume there's nothing.
  if(!configOptions.length || !option) {

    return undefined;
  }

  const getValue = (checkOption: string, checkMac: string | undefined = undefined): string | undefined => {

    // This regular expression is a bit more intricate than you might think it should be due to the need to ensure we capture values at the very end of the option.
    const optionRegex = new RegExp("^Enable\\." + checkOption + (!checkMac ? "" : "\\." + checkMac.replace(/:/g, "")) + "\\.([^\\.]+)$", "gi");

    // Get the option value, if we have one.
    for(const entry of configOptions) {

      const regexMatch = optionRegex.exec(entry);

      if(regexMatch) {

        return regexMatch[1];
      }
    }

    return undefined;
  };

  // Escape out our option to ensure we have no inadvertent issues in matching the regular expression.
  option = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Check to see if we have a device-level option first.
  let deviceMac = null;

  // Let's figure out if we've been passed a controller configuration or a device one and extract the MAC.
  if(device && ("host" in device)) {

    deviceMac = device.host.mac;
  } else {

    deviceMac = device?.mac;
  }

  if(deviceMac) {

    const value = getValue(option, deviceMac);

    if(value !== undefined) {

      return value;
    }
  }

  // Now check to see if we have an controller-level value.
  if(controller?.host?.mac) {

    const value = getValue(option, controller.host.mac);

    if(value) {

      return value;
    }
  }

  // Finally, we check for a global-level value.
  return getValue(option);
}

// Utility function to parse and return a numeric configuration parameter.
function parseOptionNumeric(optionValue: string | undefined, convert: (value: string) => number): number | undefined {

  // We don't have the option configured -- we're done.
  if(optionValue === undefined) {

    return undefined;
  }

  // Convert it to a number, if needed.
  const convertedValue = convert(optionValue);

  // Let's validate to make sure it's really a number.
  if(isNaN(convertedValue) || (convertedValue < 0)) {

    return undefined;
  }

  // Return the value.
  return convertedValue;
}

// Utility function to return a floating point configuration parameter.
export function getOptionFloat(optionValue: string | undefined): number | undefined {

  return parseOptionNumeric(optionValue, (value: string) => {

    return parseFloat(value);
  });
}

// Utility function to return an integer configuration parameter on a device.
export function getOptionNumber(optionValue: string | undefined): number | undefined {

  return parseOptionNumeric(optionValue, (value: string) => {

    return parseInt(value);
  });
}
