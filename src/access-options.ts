/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
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
    { default: true, description: "Add a switch accessory to control the mobile unlock access method.", hasCapability: [ "mobile_unlock_ver2", "support_mobile_unlock" ], name: "Mobile" },
    { default: true, description: "Add a switch accessory to control the NFC card access method.", hasCapability: ["nfc_card_easy_provision"], name: "NFC" },
    { default: true, description: "Add a switch accessory to control the PIN unlock access method.", hasCapability: ["pin_code"], name: "PIN" },
    { default: true, description: "Add a switch accessory to control the QR unlock access method.", hasCapability: ["qr_code"], name: "QR" },
    { default: true, description: "Add a switch accessory to control the Touch Pass access method.", hasCapability: ["support_apple_pass"], name: "TouchPass" }
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

    { default: false, description: "Use a lock accessory instead of a garage door opener accessory for the gate.", modelKey: ["UA Gate"], name: "Door.UseLock" },
    { default: false, description: "Use a garage door opener accessory instead of a lock accessory. This is a visual preference only within HomeKit; the underlying lock behavior and feature options remain the same.", modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini" ], name: "Door.UseGarageOpener" },
    { default: false, defaultValue: ACCESS_DEVICE_UNLOCK_INTERVAL, description: "Delay, in minutes, before locking the door lock relay once it's been unlocked by HomeKit. If set to 0, it will remain unlocked indefinitely. This applies regardless of whether you use a lock or garage door opener accessory. By default, the door lock relay will lock five seconds after unlocking.", name: "LockDelayInterval" },
    { default: false, description: "Add a switch accessory to control the door lock relay. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions and trigger events when a lock or unlock event occurs. This works with both lock and garage door opener accessories.", name: "Lock.Trigger" },
    { default: true, description: "Add a doorbell accessory to handle doorbell ring events in HomeKit.", hasCapability: ["door_bell"], name: "Doorbell" },
    { default: false, description: "Add a switch accessory for automation scenarios to reflect (but not trigger) doorbell ring events on an Access doorbell.", hasCapability: ["door_bell"], name: "Doorbell.Trigger" },
    { default: true, description: "Add a contact sensor accessory for the door position sensor.", modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini", "UA Gate" ], name: "DPS" },
    { default: true, description: "Add a contact sensor accessory for the remote release.", modelKey: ["UA Hub"], name: "REL" },
    { default: true, description: "Add a contact sensor accessory for the request to enter sensor.", modelKey: ["UA Hub"], name: "REN" },
    { default: true, description: "Add a contact sensor accessory for the request to exit sensor.", modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini" ], name: "REX" },
    { default: true, description: "Add a lock accessory for the side door (pedestrian gate) on UniFi Access Gate Hub devices.", modelKey: ["UA Gate"], name: "SideDoor" },
    { default: true, description: "Add a contact sensor accessory for the side door position sensor.", group: "SideDoor", modelKey: ["UA Gate"], name: "SideDoor.DPS" },
    { default: false, description: "Add a switch accessory to control the side door lock. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling locks.", group: "SideDoor", modelKey: ["UA Gate"], name: "SideDoor.Lock.Trigger" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log doorbell ring events in Homebridge.", hasCapability: ["door_bell"], name: "Doorbell" },
    { default: true, description: "Log door position sensor events in Homebridge.", modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini", "UA Gate" ], name: "DPS" },
    { default: true, description: "Log door remote release events in Homebridge.", modelKey: ["UA Hub"], name: "REL" },
    { default: true, description: "Log door request to enter events in Homebridge.", modelKey: ["UA Hub"], name: "REN" },
    { default: true, description: "Log door request to exit events in Homebridge.", modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini" ], name: "REX" },
    { default: true, description: "Log lock events in Homebridge.", hasCapability: ["is_hub"], name: "Lock" }
  ]
};
/* eslint-enable @stylistic/max-len */
