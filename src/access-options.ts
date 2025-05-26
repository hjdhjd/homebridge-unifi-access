/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-options.ts: Feature option and type definitions for UniFi Access.
 */
import { ACCESS_DEVICE_REMOVAL_DELAY_INTERVAL, ACCESS_DEVICE_UNLOCK_INTERVAL } from "./settings.js";
import type { FeatureOptionEntry } from "homebridge-plugin-utils";

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

// HBUA's webUI makes use of additional metadata to only surface the feature options relevant for a particular device. These properties provide that metadata.
//
// hasCapability:    Properties in the capabilities array that must be enabled for this option to be exposed.
interface AccessFeatureOption extends FeatureOptionEntry {

  hasCapability?: string[]
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
export const featureOptions: { [index: string]: AccessFeatureOption[] } = {

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
    { default: true, description: "Add a doorbell accessory to handle doorbell ring events in HomeKit.", hasCapability: [ "door_bell" ], name: "Doorbell" },
    { default: false, description: "Add a switch accessory for automation scenarios to reflect (but not trigger) doorbell ring events on an Access doorbell.", hasCapability: [ "door_bell" ], name: "Doorbell.Trigger" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log doorbell ring events in Homebridge.", hasCapability: [ "door_bell" ], name: "Doorbell" },
    { default: true, description: "Log lock events in Homebridge.", hasCapability: [ "is_hub" ], name: "Lock" }
  ]
};
/* eslint-enable @stylistic/max-len */

