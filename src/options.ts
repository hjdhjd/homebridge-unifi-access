/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.ts: Feature option and type definitions for UniFi Access.
 */
import { ACCESS_DEVICE_REMOVAL_DELAY_INTERVAL, ACCESS_DEVICE_UNLOCK_INTERVAL, ACCESS_GARAGE_TRANSITION_DURATION, ACCESS_MQTT_TOPIC,
  ACCESS_WEBHOOK_PORT } from "./settings.ts";
import type { FeatureCategoryEntry, FeatureOptionChoice, FeatureOptionEntry } from "homebridge-plugin-utils";
import { accessMethodChoices, doorServiceChoices } from "./policy.ts";
import { mqttFeatureOptions } from "homebridge-plugin-utils";

// Plugin configuration options.
export interface AccessOptions {

  controllers: AccessControllerOptions[];
  options: string[];
}

/* Controller configuration options. Credentials and a token are each optional and at least one identity is required, which is a rule the configuration type cannot
 * express and composeConnectIdentity states instead.
 *
 * verifyTls lives here rather than in the feature options because TLS verification is a connection-establishment fact that must be known before the connect, while
 * feature-option controller scoping resolves against the controller's MAC address, which exists only after one. An absent or false value means no verification,
 * which is what a controller presenting a self-signed certificate requires; turn it on where a trusted certificate has been installed.
 *
 * mqttTopic and mqttUrl are the transition fallback the MQTT resolution reads where the feature options carry no broker or topic for a controller, so a
 * configuration nobody has opened the webUI on keeps working exactly as it did.
 */
export interface AccessControllerOptions {

  address: string;
  mqttTopic?: string;
  mqttUrl?: string;
  name?: string;
  password?: string;
  tokens?: AccessControllerTokens;
  username?: string;
  verifyTls?: boolean;
}

/* The API tokens a controller is reached with. An object rather than a property per token, so a second kind of token joins as a member here instead of as another
 * top-level controller property, and an existing configuration keeps its shape when one does. This is the spelling the Access command line tools record their tokens
 * under, which is what lets a user carry a token between the two without translating it.
 *
 * The library's own connect identity carries a flat token instead. That is its wire contract rather than this plugin's configuration vocabulary, and
 * composeConnectIdentity is the single place the two are bridged.
 */
export interface AccessControllerTokens {

  access?: string;
}

/* The device models a feature option or category can be scoped to, plus the two sentinels that scope to something other than a model: "all" for any device type, and
 * "controller" for the controller itself.
 *
 * The union is closed because the model vocabulary is this plugin's own rather than the controller's - the webUI compares these keys against a device's
 * display_model, and the documentation renderer expands them into prose - so a misspelling or an invented sentinel is a compile error here rather than a silently
 * wrong visibility verdict in the browser or a raw key leaking into the published reference.
 */
export type AccessModelKey = "UA Gate" | "UA Hub" | "UA Hub Door Mini" | "UA Ultra" | "all" | "controller";

/* The webUI and the documentation renderer make use of additional metadata to surface only the feature options relevant for a particular device. These properties
 * are carried in the opaque `meta` channel that homebridge-plugin-utils forwards back to us without interpreting, and provide that metadata. Both the option and the
 * category channel carry the same properties, so one type serves both.
 *
 * choiceDomain:   The whole list a page-registered choice source draws from, offered where no device is in view to narrow it.
 * hasCapability:  Properties in the capabilities array that must be enabled for this option to be exposed. This stays open-ended because capability flags are the
 *                 controller's own wire vocabulary, which grows with firmware...the completeness sweep in this module's test suite is what catches a typo here.
 * modelKey:       Device models the option applies to, or the sentinels described on AccessModelKey.
 */
export interface AccessOptionMeta {

  choiceDomain?: readonly FeatureOptionChoice[];
  hasCapability?: string[];
  modelKey?: AccessModelKey[];
}

// A feature option entry carrying this plugin's meta vocabulary. It declares no members of its own: everything the plugin adds now lives in the typed meta channel.
export type AccessFeatureOption = FeatureOptionEntry<AccessOptionMeta>;

// A feature option category entry, on the same terms as the option entry above.
export type AccessFeatureCategory = FeatureCategoryEntry<AccessOptionMeta>;

// The MQTT option group, composed from the shared generator so every plugin exposing an MQTT broker offers the same options under the same names. Both entries are
// declared at controller scope: each configured Access controller reaches its own broker and publishes under its own topic prefix.
const mqtt = mqttFeatureOptions({ defaultTopic: ACCESS_MQTT_TOPIC, scopes: ["controller"] });

// Feature option categories.
export const featureOptionCategories: AccessFeatureCategory[] = [

  { description: "Device feature options.", meta: { modelKey: ["all"] }, name: "Device" },
  { description: "Controller feature options.", meta: { modelKey: ["controller"] }, name: "Controller" },
  { description: "Hub feature options.", meta: { hasCapability: ["is_hub"], modelKey: ["all"] }, name: "Hub" },
  { description: "Access method feature options.", meta: { hasCapability: ["is_reader"], modelKey: ["all"] }, name: "AccessMethod" },
  { description: "Logging feature options.", meta: { modelKey: ["all"] }, name: "Log" },
  // The generated category is given a meta channel of its own, since the webUI's category filter reads modelKey. Controller scope is the right answer for it on its
  // own merits: an MQTT broker is a controller-level fact, so the category belongs alongside the Controller entry above.
  { ...mqtt.category, meta: { modelKey: ["controller"] } }
];

/* eslint-disable @stylistic/max-len */
// Individual feature options, broken out by category.
export const featureOptions: Record<string, AccessFeatureOption[]> = {

  // Access method options. One selection stands for every method: the switches a reader gets are exactly the methods chosen here, from the methods that reader
  // supports, and none are chosen until a user picks them.
  "AccessMethod": [

    { choices: "accessMethods", default: true, defaultValue: "", description: "Add switch accessories to control the selected access methods from HomeKit. The list offers the methods this reader supports, and each selected method gets its own switch. None are selected by default.", meta: { choiceDomain: accessMethodChoices(), hasCapability: ["is_reader"] }, multiple: true, name: "Switches" }
  ],

  // Controller options.
  "Controller": [

    { default: true, defaultValue: ACCESS_DEVICE_REMOVAL_DELAY_INTERVAL, description: "Delay, in seconds, before removing devices that are no longer detected on the Access controller. By default, devices are added and removed in realtime.", name: "DelayDeviceRemoval" },
    { default: false, description: "Publish all the realtime telemetry received from the Access controller to MQTT.", name: "Publish.Telemetry" },
    { default: false, description: "Listen for webhook deliveries from the Access controller. Each unlock reports who unlocked the door and how, in the log and over MQTT, and each doorbell call reports how it ended in the log. Requires an API token.", name: "Webhooks" },
    { default: true, defaultValue: ACCESS_WEBHOOK_PORT, description: "Port the webhook listener binds to. One listener serves every controller configured in this plugin.", group: "Webhooks", name: "Webhooks.Port", scopes: ["global"] }
  ],

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: false, description: "Synchronize the UniFi Access name of this device with HomeKit. Synchronization is one-way only, syncing the device name from UniFi Access to HomeKit.", name: "SyncName" }
  ],

  // Hub options.
  "Hub": [

    { choices: doorServiceChoices, default: true, defaultValue: "Automatic", description: "How the door is presented in HomeKit. Automatic presents a UA Gate as a garage door opener and every other hub as a lock; choose Lock or GarageDoorOpener to present the door that way whatever the hardware. The garage door opener is a momentary operator: opening and closing both pulse the door's relay, and the lock delay setting does not apply to it.", name: "Door.Service" },
    { default: false, defaultValue: ACCESS_GARAGE_TRANSITION_DURATION, description: "Duration, in seconds, the door takes to open or close. When set, the garage door opener shows opening and closing while the door travels, and stopped when it is operated mid-travel. This setting applies to the garage door opener accessory and has no effect when the door is presented as a lock accessory.", name: "Door.TransitionDuration" },
    { default: false, defaultValue: ACCESS_DEVICE_UNLOCK_INTERVAL, description: "Delay, in minutes, before locking the door lock relay once it's been unlocked by HomeKit. If set to 0, it will remain unlocked indefinitely. This setting applies to the lock accessory and has no effect when the garage door opener accessory is selected. By default, the door lock relay will lock five seconds after unlocking.", name: "LockDelayInterval" },
    { default: false, description: "Add a switch accessory to control the door lock relay. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions and trigger events when a lock or unlock event occurs. This works with both lock and garage door opener accessories.", name: "Lock.Trigger" },
    { default: true, description: "Add a doorbell accessory to handle doorbell ring events in HomeKit.", meta: { hasCapability: ["door_bell"] }, name: "Doorbell" },
    { default: false, description: "Add a switch accessory for automation scenarios that reflects doorbell ring events, and rings or cancels the doorbell through the official Access API when an API token is configured.", meta: { hasCapability: ["door_bell"] }, name: "Doorbell.Trigger" },
    { choices: "doorGuards", default: true, defaultValue: "", description: "Restrict doorbell ring events to the selected door guards, the Access users assigned to answer this door's calls; rings for any other door guard are ignored. Guards are listed by name when the controller is configured with an API token and by identifier otherwise, and a controller reached by its token alone lists every user. Each ring's door guard IDs are logged when debug logging is enabled.", meta: { hasCapability: ["door_bell"] }, multiple: true, name: "Doorbell.DoorGuards", scopes: ["device"] },
    { default: true, description: "Add a contact sensor accessory for the door position sensor.", meta: { modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini", "UA Gate" ] }, name: "DPS" },
    { default: true, description: "Add a contact sensor accessory for the remote release.", meta: { modelKey: ["UA Hub"] }, name: "REL" },
    { default: true, description: "Add a contact sensor accessory for the request to enter sensor.", meta: { modelKey: ["UA Hub"] }, name: "REN" },
    { default: true, description: "Add a contact sensor accessory for the request to exit sensor.", meta: { modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini" ] }, name: "REX" },
    { default: true, description: "Add a lock accessory for the side door (pedestrian gate) on UniFi Access Gate Hub devices.", meta: { modelKey: ["UA Gate"] }, name: "SideDoor" },
    { default: true, description: "Add a contact sensor accessory for the side door position sensor.", group: "SideDoor", meta: { modelKey: ["UA Gate"] }, name: "SideDoor.DPS" },
    { default: false, description: "Add a switch accessory to control the side door lock. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling locks.", group: "SideDoor", meta: { modelKey: ["UA Gate"] }, name: "SideDoor.Lock.Trigger" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log doorbell ring events in Homebridge.", meta: { hasCapability: ["door_bell"] }, name: "Doorbell" },
    { default: true, description: "Log door position sensor events in Homebridge.", meta: { modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini", "UA Gate" ] }, name: "DPS" },
    { default: true, description: "Log door remote release events in Homebridge.", meta: { modelKey: ["UA Hub"] }, name: "REL" },
    { default: true, description: "Log door request to enter events in Homebridge.", meta: { modelKey: ["UA Hub"] }, name: "REN" },
    { default: true, description: "Log door request to exit events in Homebridge.", meta: { modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini" ] }, name: "REX" },
    { default: true, description: "Log lock events in Homebridge.", meta: { hasCapability: ["is_hub"] }, name: "Lock" }
  ],

  /* MQTT options, carried from the shared generator so the broker and topic entries stay identical across every plugin that offers them.
   *
   * The generator answers bare FeatureOptionEntry values - it is not generic over the meta channel - and `unknown` is not assignable to AccessOptionMeta, so the
   * entries are re-typed by structurally dropping the member they never carry. An entry with no meta at all is assignable to the narrowed type once the
   * unknown-typed member is gone, which is what makes this a re-type rather than a cast.
   */
  [mqtt.category.name]: mqtt.options.map((option): AccessFeatureOption => {

    const { meta: _meta, ...rest } = option;

    return rest;
  })
};
/* eslint-enable @stylistic/max-len */

/* Documentation presentation. The maps and scope hooks below are build-time-only doc copy, colocated with the catalog they describe so all option-related knowledge
 * lives in one module. homebridge-plugin-utils' `prepare-docs` CLI optionally imports `describeCategoryScope` / `describeOptionScope` from this module and threads
 * them into the shared documentation renderer, which owns all base-shaped scaffolding (index, headings, anchors, the key cell, the default cell, the column math)
 * and delegates only the plugin-private scope prose to these hooks. They read the typed `meta` channel directly.
 */

// Human-readable expansion of each model key, used by both hooks. "all" expands to nothing at all: it says every device type, so naming it as a scope tells a reader
// something they already have from the absence of any restriction, and the raw sentinel would read as the fragment "apply to: all". Typing the map against the
// closed union is what makes a new model a compile error here until its prose is written, so neither hook needs a fallback for a key the map does not carry.
const modelMap: Record<AccessModelKey, string> = {

  "UA Gate": "UniFi Access Gate",
  "UA Hub": "UniFi Access Hub",
  "UA Hub Door Mini": "UniFi Access Hub Door Mini",
  "UA Ultra": "UniFi Access Ultra",
  "all": "",
  "controller": "Access controllers"
};

// Human-readable expansion of each capability flag an option can be gated on, surfaced in the per-option "Supported on" line. The capability vocabulary is the
// controller's rather than ours, so completeness against the live catalog is swept by this module's test suite rather than enforced by the compiler.
const capabilityMap: Record<string, string> = {

  "door_bell": "UniFi Access hubs that have a doorbell",
  "hand_wave": "UniFi Access readers that support hand wave authentication",
  "identity_face_unlock": "UniFi Access readers that support face unlock authentication",
  "is_hub": "UniFi Access hubs",
  "is_reader": "UniFi Access readers",
  "mobile_unlock_ver2": "UniFi Access readers that support mobile authentication",
  "nfc_card_easy_provision": "UniFi Access readers that support NFC authentication",
  "pin_code": "UniFi Access readers that support PIN authentication",
  "qr_code": "UniFi Access readers that support QR code authentication",
  "support_apple_pass": "UniFi Access readers that support Touch Pass",
  "support_mobile_unlock": "UniFi Access readers that support mobile authentication"
};

// Module-scope list formatter for the category device-scope sentence. It handles "X", "X and Y", and "X, Y, and Z" uniformly.
const lf = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * Documentation hook: returns the device-scope sentence emitted under a category heading, naming the device models the category applies to, or `undefined` when the
 * category declares no model scope or every model it declares expands to nothing.
 *
 * @param category - The category entry whose `meta.modelKey` scope to describe.
 *
 * @returns The full "These option(s) apply to: ..." sentence, or `undefined` to omit the line.
 */
export function describeCategoryScope(category: AccessFeatureCategory): string | undefined {

  // A key that maps to the empty string is a sentinel with no scope to name, and drops out. A category left with nothing to name gets no sentence at all.
  const named = (category.meta?.modelKey ?? []).map(key => modelMap[key]).filter(model => model.length > 0);

  if(!named.length) {

    return undefined;
  }

  return "These option(s) apply to: " + lf.format(named) + ".";
}

/**
 * Documentation hook: returns the "Supported on ..." suffix appended to an option's description cell, naming the capability or device model the option is gated on,
 * or `undefined` when the option declares no scope worth naming. The capability gate is read first and the device model is the catch-all behind it, because an
 * option gated on both is gated on the capability in the narrower sense.
 *
 * @param option - The option entry whose `meta` scope to describe.
 *
 * @returns The full " <BR>*Supported on ...*" suffix, or `undefined` to omit it.
 */
export function describeOptionScope(option: AccessFeatureOption): string | undefined {

  const capability = option.meta?.hasCapability?.[0];

  if(capability !== undefined) {

    return " <BR>*Supported on " + (capabilityMap[capability] ?? capability) + ".*";
  }

  const model = option.meta?.modelKey?.[0];

  if(model === undefined) {

    return undefined;
  }

  const named = modelMap[model];

  return named.length ? (" <BR>*Supported on " + named + ".*") : undefined;
}
