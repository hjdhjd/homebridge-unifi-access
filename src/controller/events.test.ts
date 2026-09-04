/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * events.test.ts: Tests for the Access event bridge.
 */
/* eslint-disable camelcase */
import { ACCESS_DEVICE_UPDATE_EVENT, ACCESS_WEBHOOK_EVENT_PREFIX, AccessEvents } from "./events.ts";
import { ACCESS_WEBHOOK_EVENTS } from "../settings.ts";
import type { AccessController } from "./controller.ts";
import type { AccessEventPacket } from "unifi-access";
import type { AccessWebhookEvent } from "unifi-access";
import assert from "node:assert/strict";
import test from "node:test";

// What the controller looks like from the bridge's side: a rail to subscribe to, a telemetry gate, an identity, a logger, and the publish chokepoint.
interface ControllerDouble {

  controller: AccessController;
  publishes: { payload: string; topic: string }[];
}

function makeController(options: { identity?: string; telemetry: boolean }): ControllerDouble {

  const publishes: { payload: string; topic: string }[] = [];

  const controller = {

    client: { on: (): Disposable => ({ [Symbol.dispose]: (): void => undefined }) },
    hasFeature: (): boolean => options.telemetry,
    log: { debug: (): void => undefined, error: (): void => undefined, info: (): void => undefined, warn: (): void => undefined },
    mqttIdentity: options.identity ?? "AABBCCDDEEFF",
    mqttPublish: (topic: string, payload: string): void => {

      publishes.push({ payload, topic });
    }
  };

  return { controller: controller as unknown as AccessController, publishes };
}

// A wire frame carrying the metadata the newer device-update dialect addresses its device with.
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
  const seen: string[] = [];

  for(const name of [ "access.data.v2.device.update", "object1", "metaDevice1", "access.data.v2.device.update.object1" ]) {

    events.on(name, () => seen.push(name));
  }

  events.emitPacket(packet("access.data.v2.device.update"));

  assert.deepEqual(seen.sort(), [ "access.data.v2.device.update", "access.data.v2.device.update.object1", "metaDevice1", "object1" ]);
});

test("the bridge forwards a newer-dialect device update and withholds the older one", () => {

  const { controller } = makeController({ telemetry: false });
  const events = new AccessEvents(controller);
  const delivered: AccessEventPacket[] = [];

  events.on("object1", (frame: AccessEventPacket) => delivered.push(frame));

  // The newer dialect bridges from the raw rail, because its handler reads the frame's own payload rather than reading through to state.
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

test("telemetry for a controller with no hardware identity publishes under its configured address", () => {

  // A controller reached with an API token alone never reads the document its MAC address comes from, so its configured address is the identity its telemetry carries.
  const { controller, publishes } = makeController({ identity: "1.2.3.4", telemetry: true });
  const events = new AccessEvents(controller);

  events.handleRawPacket(packet("access.remote_view"));

  assert.equal(publishes.length, 1, "the frame must be mirrored exactly once");
  assert.equal(publishes[0]?.topic, "1.2.3.4/telemetry", "the topic must open with the configured address and never with an empty segment");
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
