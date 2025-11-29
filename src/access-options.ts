/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-options.ts: Feature option and type definitions for UniFi Access.
 */
import { ACCESS_DEVICE_REMOVAL_DELAY_INTERVAL, ACCESS_DEVICE_UNLOCK_INTERVAL } from "./settings.js";
import type { FeatureOptionEntry } from "homebridge-plugin-utils";

// Plugin configuration options.
export interface AccessOptions {

  controllers: AccessControllerOptions[];
  debugAll: boolean;
  options: string[];
  ringDelay: number;
}

// Controller configuration options.
export interface AccessControllerOptions {

  address: string;
  mqttTopic: string;
  mqttUrl?: string;
  name?: string;
  username: string;
  password: string;
}

// HBUA's webUI makes use of additional metadata to only surface the feature options relevant for a particular device. These properties provide that metadata.
//
// hasCapability:    Properties in the capabilities array that must be enabled for this option to be exposed.
interface AccessFeatureOption extends FeatureOptionEntry {

  hasCapability?: string[];
  modelKey?: string[];
}

// Feature option categories.
export const featureOptionCategories = [

  { description: "Device feature options.", modelKey: ["all"], name: "Device" },
  { description: "Controller feature options.", modelKey: ["controller"], name: "Controller" },
  { description: "Hub feature options.", hasCapability: ["is_hub"], modelKey: ["all"], name: "Hub" },
  { description: "Access method feature options.", hasCapability: ["is_reader"], modelKey: ["all"], name: "AccessMethod" },
  { description: "Logging feature options.", modelKey: ["all"], name: "Log" }
];

/* eslint-disable @stylistic/max-len */
// Individual feature options, broken out by category.
export const featureOptions: { [index: string]: AccessFeatureOption[] } = {

  // Access method options.
  "AccessMethod": [

    { default: true, description: "Add a switch accessory to control the face unlock access method.", hasCapability: ["identity_face_unlock"], name: "Face" },
    { default: true, description: "Add a switch accessory to control the hand wave unlock access method.", hasCapability: ["hand_wave"], name: "Hand" },
    { default: true, description: "Add a switch accessory to control the mobile unlock access method.", hasCapability: ["mobile_unlock_ver2"], name: "Mobile" },
    { default: true, description: "Add a switch accessory to control the NFC card access method.", hasCapability: ["nfc_card_easy_provision"], name: "NFC" },
    { default: true, description: "Add a switch accessory to control the PIN unlock access method.", hasCapability: ["pin_code"], name: "PIN" },
    { default: true, description: "Add a switch accessory to control the QR unlock access method.", hasCapability: ["qr_code"], name: "QR" }
  ],

  // Controller options.
  "Controller": [

    { default: true, defaultValue: ACCESS_DEVICE_REMOVAL_DELAY_INTERVAL, description: "Delay, in seconds, before removing devices that are no longer detected on the Access controller. By default, devices are added and removed in realtime.", name: "DelayDeviceRemoval" },
    { default: false, description: "Publish all the realtime telemetry received from the Access controller to MQTT.", name: "Publish.Telemetry" }
  ],

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: false, description: "Synchronize the UniFi Access name of this device with HomeKit. Synchronization is one-way only, syncing the device name from UniFi Access to HomeKit.", name: "SyncName" }
  ],

  // Hub options.
  "Hub": [

    { default: false, defaultValue: ACCESS_DEVICE_UNLOCK_INTERVAL, description: "Delay, in minutes, before locking the door lock relay, once it's been unlocked by HomeKit. If set to 0, it will remain unlocked indefinitely. By default, the door lock relay will lock five seconds after unlocking.", name: "LockDelayInterval" },
    { default: false, description: "Add a switch accessory to control the lock. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling locks and triggering events when a lock or unlock event occurs.", name: "Lock.Trigger" },
    { default: true, description: "Add a doorbell accessory to handle doorbell ring events in HomeKit.", hasCapability: ["door_bell"], name: "Doorbell" },
    { default: false, description: "Add a switch accessory for automation scenarios to reflect (but not trigger) doorbell ring events on an Access doorbell.", hasCapability: ["door_bell"], name: "Doorbell.Trigger" },
    { default: true, description: "Add a contact sensor accessory for the door position sensor.", modelKey: ["UA Ultra", "UA Hub", "UA Hub Door Mini"], name: "DPS" },
    { default: true, description: "Add a contact sensor accessory for the remote release.", modelKey: ["UA Hub"], name: "REL" },
    { default: true, description: "Add a contact sensor accessory for the request to enter sensor.", modelKey: ["UA Hub"], name: "REN" },
    { default: true, description: "Add a contact sensor accessory for the request to exit sensor.", modelKey: ["UA Ultra", "UA Hub", "UA Hub Door Mini"], name: "REX" },
    { default: true, description: "Add a lock accessory for the side door (pedestrian gate) on UniFi Access Gate Hub devices.", modelKey: ["UA Gate"], name: "SideDoor" },
    { default: false, defaultValue: ACCESS_DEVICE_UNLOCK_INTERVAL, description: "Delay, in minutes, before locking the side door lock relay, once it's been unlocked by HomeKit. If set to 0, it will remain unlocked indefinitely. By default, the side door lock relay will lock five seconds after unlocking.", modelKey: ["UA Gate"], name: "SideDoor.LockDelayInterval" },
    { default: false, description: "Add a switch accessory to control the side door lock. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling locks.", modelKey: ["UA Gate"], name: "SideDoor.Lock.Trigger" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log doorbell ring events in Homebridge.", hasCapability: ["door_bell"], name: "Doorbell" },
    { default: true, description: "Log door position sensor events in Homebridge.", modelKey: ["UA Ultra", "UA Hub", "UA Hub Door Mini"], name: "DPS" },
    { default: true, description: "Log door remote release events in Homebridge.", modelKey: ["UA Hub"], name: "REL" },
    { default: true, description: "Log door request to enter events in Homebridge.", modelKey: ["UA Hub"], name: "REN" },
    { default: true, description: "Log door request to exit events in Homebridge.", modelKey: ["UA Ultra", "UA Hub", "UA Hub Door Mini"], name: "REX" },
    { default: true, description: "Log lock events in Homebridge.", hasCapability: ["is_hub"], name: "Lock" },
    { default: true, description: "Log side door lock events in Homebridge.", modelKey: ["UA Gate"], name: "SideDoorLock" }
  ]
};
/* eslint-enable @stylistic/max-len */
