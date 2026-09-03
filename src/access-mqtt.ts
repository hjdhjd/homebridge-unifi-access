/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-mqtt.ts: The MQTT topic catalog for UniFi Access.
 */
import { mqttTopicCatalog } from "homebridge-plugin-utils";

// The headings the document groups the plugin's topics under, named once here because every entry below cites one and the renderer prints them as subheadings.
const DOOR_GROUP = "Door and Lock Topics";
const SIDE_DOOR_GROUP = "Side Door Topics (UA Gate Only)";
const TELEMETRY_GROUP = "Telemetry Topics";

/* The plugin's whole MQTT topic surface, declared once and read from here by everything that spells a topic. Each publish and subscribe site takes its tail from
 * this catalog, the renderer projects it into the two marked regions of docs/MQTT.md at the docs build, and the builder validates it at import: a duplicate wire
 * topic, an entry that declares no message text at all, and a malformed placeholder each fail the load rather than reaching a broker. A tail therefore has exactly
 * one spelling in the plugin, and what the document prints cannot disagree with what the plugin publishes.
 *
 * This module imports the library and nothing else - above all nothing from the HomeKit device graph - because the documentation CLI loads it compiled and
 * standalone, exactly as it loads the feature-option catalog. A single import from the device side would drag that whole graph into the CLI's load.
 *
 * An entry's label is the word the client's get and set log lines carry: it reaches subscribeGet and subscribeSet as the name of the thing being read or written,
 * and the user sees it in the sentence the client writes. The device column is documentation alone, projected by the renderer into each row's device cell and read
 * by nothing at runtime, so its vocabulary fixes both the spelling of every device kind and the order each cell lists them in.
 */
export const mqttTopics = mqttTopicCatalog({

  doorbell: { devices: ["doorbellHub"], get: "`true` will trigger a publish event of the current doorbell ring status.", group: DOOR_GROUP, label: "doorbell",
    publish: "`true` when ringing, `false` when the ring ends.", topic: "doorbell" },
  dps: { devices: [ "ultra", "hub", "hubDoorMini", "gate", "enterprisePort" ], get: "`true` will trigger a publish event of the current door position sensor state.",
    group: DOOR_GROUP, label: "door position sensor", publish: "`true` when open, `false` when closed, `unknown` if not wired. The door position sensor.", topic: "dps" },
  lock: { devices: ["allHubs"], get: "`true` will trigger a publish event of the current lock state.", group: DOOR_GROUP, label: "lock",
    publish: "`true` when locked, `false` when unlocked.", set: "`true` to lock, `false` to unlock. On hubs other than UA Gate, locking requires a configured lock " +
      "delay interval - a door left on the default momentary unlock has no relock to perform, and the request is refused with an error in the log.", topic: "lock" },
  rel: { devices: ["hub"], group: DOOR_GROUP, label: "remote release", publish: "`true` when open, `false` when closed. The remote release sensor.", topic: "rel" },
  ren: { devices: ["hub"], group: DOOR_GROUP, label: "request to enter", publish: "`true` when open, `false` when closed. The request to enter sensor.", topic: "ren" },
  rex: { devices: [ "ultra", "hub", "hubDoorMini" ], group: DOOR_GROUP, label: "request to exit",
    publish: "`true` when open, `false` when closed. The request to exit sensor.", topic: "rex" },
  sidedoorDps: { devices: ["gate"], get: "`true` will trigger a publish event of the current side door position sensor state.", group: SIDE_DOOR_GROUP,
    label: "side door position sensor",
    publish: "`true` when open, `false` when closed, `unknown` if not wired. The side door (pedestrian gate) position sensor.", topic: "sidedoor/dps" },
  sidedoorLock: { devices: ["gate"], get: "`true` will trigger a publish event of the current side door lock state.", group: SIDE_DOOR_GROUP, label: "side door lock",
    publish: "`true` when locked, `false` when unlocked. The side door lock state.",
    set: "`true` to lock, `false` to unlock. This controls the side door lock relay.", topic: "sidedoor/lock" },
  sidedoorUnlock: { devices: ["gate"], group: SIDE_DOOR_GROUP, label: "side door unlock",
    publish: "A JSON describing who unlocked the side door and how. See [Unlock Attribution](#unlock-attribution) for additional documentation. Published only when " +
      "`Controller.Webhooks` is enabled.", topic: "sidedoor/unlock" },
  telemetry: { devices: ["controller"], group: TELEMETRY_GROUP, label: "telemetry",
    publish: "All UniFi Access telemetry from the realtime events API. This is the raw feed - you're on your own to parse through it for the messages you may be " +
      "interested in. This is published to the controller's identity rather than a device's, and only when `Controller.Publish.Telemetry` is enabled.",
    topic: "telemetry" },
  unlock: { devices: ["allHubs"], group: DOOR_GROUP, label: "unlock",
    publish: "A JSON describing who unlocked the door and how. See [Unlock Attribution](#unlock-attribution) for additional documentation. Published only when " +
      "`Controller.Webhooks` is enabled.", topic: "unlock" }
}, {

  heading: "Access Device Type",
  vocabulary: {

    allHubs: "All hubs",
    controller: "Controller",
    doorbellHub: "Hub with a doorbell",
    enterprisePort: "Access Enterprise hub ports",
    gate: "UA Gate",
    hub: "UA Hub",
    hubDoorMini: "UA Hub Door Mini",
    ultra: "UA Ultra"
  }
});
