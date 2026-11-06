/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * events.test.ts: Tests for the Access event bridge.
 */
/* eslint-disable camelcase */
import { ACCESS_DEVICE_UPDATE_EVENT, ACCESS_REMOTE_UNLOCK_EVENT, ACCESS_WEBHOOK_EVENT_PREFIX, AccessEvents } from "./events.ts";
import { ACCESS_WEBHOOK_EVENTS, ACCESS_WEBHOOK_EVENT_LIST } from "../settings.ts";
import type { AccessEventPacket, AccessWebhookEvent } from "unifi-access";
import { makeControllerDouble, makePlatformDouble } from "../testing.helpers.ts";
import type { AccessController } from "./controller.ts";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { controllerIdentity } from "../policy.ts";
import { format } from "node:util";
import { settle } from "homebridge-plugin-utils/testing";
import test from "node:test";

// The controller's own MAC in the normalized form an identity carries, which is the identity every telemetry topic here opens with.
const CONTROLLER_SERIAL = "AABBCCDDEEFF";

/* What the bridge is stood up over: the shared controller double told the two facts this suite varies - whether telemetry is on, and whether the controller ever
 * learned a hardware identity - beside the recorder standing in for the publish chokepoint. The rail the bridge subscribes to answers a disposable, because the
 * subscription is what the bridge holds for its own lifetime.
 *
 * An absent identity leaves the double to derive one from its configured address, which is what a controller reached with an API token alone answers by, so the
 * two arms differ in exactly the fact they name. The credentialed arm composes its identity through the same policy function rather than asserting a serial into
 * the brand, because the two identity brands are deliberately distinct types.
 */
function makeController(options: { telemetry: boolean; tokenOnly?: boolean }): { controller: AccessController; publishes: { payload: string; topic: string }[] } {

  const publishes: { payload: string; topic: string }[] = [];

  return {

    controller: makeControllerDouble({

      client: { on: (): Disposable => ({ [Symbol.dispose]: (): void => undefined }) },
      hasFeature: (): boolean => options.telemetry,
      id: options.tokenOnly ? undefined : controllerIdentity({ address: "1.2.3.4", mac: CONTROLLER_SERIAL }),
      mqttPublish: (topic: string, payload: string): void => void publishes.push({ payload, topic })
    }),
    publishes
  };
}

// A wire frame of the named event, addressed to one object and carrying the metadata the controller attaches to a change to a stored device.
function packet(event: string): AccessEventPacket {

  return {

    data: null,
    event,
    event_object_id: "object1",
    meta: { all_field: false, id: "metaDevice1", object_type: "device", source: "", target_field: null },
    receiver_id: "",
    save_to_history: false
  };
}

test("one packet reaches every addressing pattern a device subscribes on", () => {

  const { controller } = makeController({ telemetry: false });
  const events = new AccessEvents(controller);
  const metaHeard: AccessEventPacket[] = [];
  const seen: string[] = [];

  for(const name of [ "access.data.v2.device.update", "object1", "access.data.v2.device.update.object1" ]) {

    events.on(name, () => seen.push(name));
  }

  // The frame's metadata names a device of its own, and a listener on it hears nothing: a packet is addressed by its event and its object alone.
  events.on("metaDevice1", (frame: AccessEventPacket) => metaHeard.push(frame));

  events.emitPacket(packet("access.data.v2.device.update"));

  assert.deepEqual(seen.sort(), [ "access.data.v2.device.update", "access.data.v2.device.update.object1", "object1" ]);
  assert.deepEqual(metaHeard, [], "the device the frame's metadata names is not an addressing pattern");
});

test("the bridge forwards a newer-dialect device update and withholds the older one", () => {

  const { controller } = makeController({ telemetry: false });
  const events = new AccessEvents(controller);
  const delivered: AccessEventPacket[] = [];

  events.on("object1", (frame: AccessEventPacket) => delivered.push(frame));

  // Every frame but the original dialect's device update bridges from the raw rail, the newer dialect's device update among them.
  events.handleRawPacket(packet("access.data.v2.device.update"));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.event, "access.data.v2.device.update", "the delivered frame must be the one that was bridged");

  /* The older dialect must not bridge at all: the raw rail fires before the reducer folds, so forwarding it here would race the read-through record its handler
   * reads. Asserting both directions by exact identity is what fails an exclusion written as a substring match, which would swallow both dialects.
   */
  events.handleRawPacket(packet(ACCESS_DEVICE_UPDATE_EVENT));

  assert.equal(delivered.length, 1, "an older-dialect device update must not reach a listener from the raw rail");
});

test("telemetry mirrors every frame exactly once, the excluded one included", () => {

  const { controller, publishes } = makeController({ telemetry: true });
  const events = new AccessEvents(controller);

  events.handleRawPacket(packet("access.data.v2.device.update"));
  events.handleRawPacket(packet("access.remote_view"));

  // The mirror sits upstream of the exclusion, so a device update is republished even though it is not bridged onward.
  events.handleRawPacket(packet(ACCESS_DEVICE_UPDATE_EVENT));

  assert.equal(publishes.length, 3, "every wire frame must be mirrored exactly once");

  for(const published of publishes) {

    assert.equal(published.topic, "AABBCCDDEEFF/telemetry");
  }

  assert.deepEqual(JSON.parse(publishes[2]?.payload ?? "null"), packet(ACCESS_DEVICE_UPDATE_EVENT));
});

test("telemetry for a controller with no hardware identity publishes under its address identity", () => {

  /* A controller reached with an API token alone never reads the document its MAC address comes from, so its configured address is the identity its telemetry
   * carries - in the scope form, since that is the one identity such a controller answers by everywhere. The literal proves that spelling reaches the wire.
   */
  const { controller, publishes } = makeController({ telemetry: true, tokenOnly: true });
  const events = new AccessEvents(controller);

  events.handleRawPacket(packet("access.remote_view"));

  assert.equal(publishes.length, 1, "the frame must be mirrored exactly once");
  assert.equal(publishes[0]?.topic, "1-2-3-4/telemetry", "the topic must open with the address identity and never with an empty segment");
});

test("the telemetry line is said once at the level that set it, and a default says nothing", () => {

  const OPTION = "Controller.Publish.Telemetry";
  const levels = [

    { entries: [], expected: [], level: "the default" },
    { entries: ["Enable." + OPTION], expected: ["Access controller telemetry enabled."], level: "the plugin" },
    { entries: ["Enable." + OPTION + ".1-2-3-4"], expected: ["Controller: Access controller telemetry enabled."], level: "the controller" },
    { entries: [ "Enable." + OPTION, "Disable." + OPTION + ".1-2-3-4" ], expected: ["Controller: Access controller telemetry disabled."],
      level: "a controller off beneath a global on" }
  ];

  for(const { entries, expected, level } of levels) {

    const lines: string[] = [];
    const taking = (prefix: string) => (message: string, ...parameters: unknown[]): void => void lines.push(prefix + format(message, ...parameters));
    const platform = makePlatformDouble({ entries, log: { error: (): void => undefined, info: taking(""), warn: (): void => undefined } });

    new AccessEvents(makeControllerDouble({ log: { info: taking("Controller: ") }, platform }));

    assert.deepEqual(lines, expected, "the line reads as " + level + " wrote it");
  }
});

test("telemetry publishes nothing while the feature option is off", () => {

  const { controller, publishes } = makeController({ telemetry: false });
  const events = new AccessEvents(controller);

  events.handleRawPacket(packet("access.data.v2.device.update"));
  events.handleRawPacket(packet(ACCESS_DEVICE_UPDATE_EVENT));

  assert.equal(publishes.length, 0, "the shipped default is off, so a mirror that lost its gate fails here");
});

test("a delivery is emitted under its own prefix and never mirrored to telemetry", () => {

  // Telemetry is on for this arm, so a mirror that swallowed deliveries too would publish here.
  const { controller, publishes } = makeController({ telemetry: true });
  const events = new AccessEvents(controller);
  const deliveries: unknown[] = [];
  const socketSide: unknown[] = [];

  events.on(ACCESS_WEBHOOK_EVENT_PREFIX + ACCESS_WEBHOOK_EVENTS.doorUnlock, (delivery: unknown) => deliveries.push(delivery));

  // The same name on the socket vocabulary, where an entirely different payload arrives. Registering both is what proves the prefix keeps the two apart.
  events.on(ACCESS_WEBHOOK_EVENTS.doorUnlock, (frame: unknown) => socketSide.push(frame));

  const delivery = { data: { actor: null, device: null, location: { id: "door1", name: "Front Door" }, object: {} }, event: ACCESS_WEBHOOK_EVENTS.doorUnlock,
    event_object_id: "delivery1" } as unknown as AccessWebhookEvent;

  events.emitDelivery(delivery);

  assert.deepEqual(deliveries, [delivery]);
  assert.deepEqual(socketSide, [], "a delivery must never reach a listener registered for the socket frame of the same name");

  // The telemetry mirror republishes the controller's notification socket, and a delivery is not one of its frames.
  assert.equal(publishes.length, 0, "the telemetry mirror must carry socket frames only");
});

test("a name every adopted device registers on takes any number of listeners with no leak warning", async () => {

  const { controller } = makeController({ telemetry: false });
  const events = new AccessEvents(controller);
  const names = [ ACCESS_REMOTE_UNLOCK_EVENT, "access.remote_view", "access.remote_view.change",
    ...ACCESS_WEBHOOK_EVENT_LIST.map((event) => ACCESS_WEBHOOK_EVENT_PREFIX + event) ];
  const registered = EventEmitter.defaultMaxListeners + 1;
  const warnings: Error[] = [];
  const observe = (warning: Error): void => void warnings.push(warning);

  process.on("warning", observe);

  try {

    // Every hub registers on each of these names, so one listener past the default limit on each stands for a controller serving one hub more than that limit.
    for(const name of names) {

      for(let listener = 0; listener < registered; listener++) {

        events.on(name, (): void => undefined);
      }
    }

    // The emitter states its warning on a later turn than the registration that crossed the limit, so the read waits a turn for it.
    await settle();
  } finally {

    process.off("warning", observe);
  }

  assert.deepEqual(warnings.filter((warning) => warning.name === "MaxListenersExceededWarning").map((warning) => warning.message), [],
    "a name's listeners past the default limit must not read as a leak");

  for(const name of names) {

    assert.equal(events.listenerCount(name), registered, "every listener registered on " + name + " must stand");
  }

  // A raised cap would pass the read above at this count, so the limit itself is read: zero is the emitter's own spelling of no limit.
  assert.equal(events.getMaxListeners(), 0);
});
