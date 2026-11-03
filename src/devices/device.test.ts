/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.test.ts: Tests for what every AccessDevice composes: the observe loop, the availability verdict and what HomeKit and MQTT read from it, the debug gate,
 * identity capture, timers and listeners bound to the device lifetime, and name synchronization.
 */
/* eslint-disable camelcase */
import { ACCESSORY_SAVE_WINDOW_MS, FeatureOptions, HAPStatus, MqttOfflineError, mqttGetTopic, mqttSetTopic, mqttTopic } from "homebridge-plugin-utils";
import type { AccessDevice as AccessDeviceProjection, AccessEventPacket, AccessStateDevice } from "unifi-access";
import { Characteristic, RESTORED_LINE, Service, hap, hubRecord, makeControllerDouble, makePlatformDouble, makeTestAccessory, makeTestApi, savesOn,
  writesOn } from "../testing.helpers.ts";
import { TestClock, TestMqttClient, settle, triggerSet } from "homebridge-plugin-utils/testing";
import { controllerIdentity, deviceSerial } from "../policy.ts";
import { featureOptionCategories, featureOptions } from "../options.ts";
import { ACCESS_WEBHOOK_EVENTS } from "../settings.ts";
import { ACCESS_WEBHOOK_EVENT_PREFIX } from "../controller/events.ts";
import type { AccessController } from "../controller/controller.ts";
import { AccessDevice } from "./device.ts";
import type { DecoratedSerial } from "../policy.ts";
import type { TestAccessAccessory } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import { format } from "node:util";
import { mqttTopics } from "../mqtt.ts";
import test from "node:test";

// The controller every device below belongs to, in the casing a controller's own identity carries.
const CONTROLLER_ID = "112233445566";

// The window the timer arm below arms against. Any value serves: what the arm is about is whether the deadline survives teardown, not how long it was.
const TIMER_DELAY_MS = 10;

// The topic the shared hub record states its availability on, as the broker double records it: the device's identity and the catalog's tail, with no prefix.
const AVAILABILITY_TOPIC = "AABBCCDDEE01/availability";

/* AccessDevice supplies every abstract member AccessBase declares and adds none of its own, so a near-bare subclass is the whole harness the loop needs. The
 * wrappers expose the protected Not Responding rule, the protected hint configuration, the protected derivation of the name the device applies, and the protected
 * rename, which is how an arm drives the real rule, the real option reads, the real deviation log, the real derivation and the real write rather than paths it wrote
 * itself.
 */
class TestDevice extends AccessDevice {

  public answer(read: () => boolean): () => boolean {

    return this.answering(read);
  }

  public configure(): boolean {

    return this.configureHints();
  }

  public homeKit(): string {

    return this.homeKitName;
  }

  public renameTo(name: string): boolean {

    return this.renameAccessory(name);
  }
}

// A device that registers for one of the webhook deliveries the plugin consumes. The registration is protected, so a subclass is what lets the test drive the real
// one rather than a registration it wrote itself.
class DeliveryDevice extends AccessDevice {

  public readonly seen: unknown[] = [];

  public listen(): void {

    this.registerDeliveryListener(ACCESS_WEBHOOK_EVENTS.doorUnlock, (delivery) => this.seen.push(delivery));
  }
}

// A device that registers a get and a set on one of its own topics under a lifetime the test hands it. The registrations are protected, so a subclass is what lets
// the test drive the real ones rather than registrations it wrote itself.
class AnsweringDevice extends AccessDevice {

  public answer(lifetime?: AbortSignal): void {

    this.mqttSubscribeGet(mqttTopics.lock, () => "true", lifetime);
    this.mqttSubscribeSet(mqttTopics.lock, () => undefined, lifetime);
  }
}

// A device that arms and reports its own timers the way a real one does. The registry is protected, so reaching it through a subclass is what lets the test exercise
// the plumbing this base actually provides rather than a registry the test stood up itself.
class TimerDevice extends AccessDevice {

  public arm(key: string, callback: () => void, ms: number): void {

    this.timers.setTimeout(key, callback, ms);
  }

  public isArmed(key: string): boolean {

    return this.timers.has(key);
  }
}

// A device record that reads as fully online.
function record(overrides: Record<string, unknown> = {}): AccessStateDevice & { mac: string } {

  return hubRecord({ alias: "", is_adopted: true, is_connected: true, is_online: true, ...overrides });
}

/* One port of a multi-door Enterprise hub, as the library synthesizes it: the hub's own record with that port's key spread over it. Two ports therefore share one
 * MAC address and are told apart by their qualifier alone, which is the whole reason a device's identity carries one.
 */
function portRecord(sourceId: string): AccessStateDevice & { mac: string } {

  return record({ device_type: "UAH-Ent", mac: "aa:bb:cc:dd:ee:02", source_id: sourceId });
}

interface Harness {

  // The accessory this harness's device is stood up on, Homebridge's own, recording every write the device makes to it.
  accessory: TestAccessAccessory;
  // The time source every timer this device arms is registered on, so an arm reads and moves the device's own timeline rather than waiting on a real one.
  clock: TestClock;
  // The admission record this device is constructed on - the narrowed record membership admits a device by, and the source of the identity a device captures once.
  construction: AccessStateDevice & { mac: string };
  // What the controller's connection answers about itself, in a holder the client double reads live so an arm can state it before the device is stood up and move it
  // afterwards: the first fault's flag, which only a blip's arm sets false, and the verdict the library reaches once it has concluded the connection lost.
  connection: { isHealthy: boolean; isLost: boolean };
  controller: AccessController;
  emissions: AccessEventPacket[];
  // The engine this harness seeded, so an arm can ask it the same question the device asks it.
  featureOptions: FeatureOptions;
  // The lines the deviation log lands on, rendered as the logger would render them. It speaks at info, which is the channel a user reads at startup.
  infoLines: string[];
  // What the device wrote to the accessory's information service, the identity stamp and a rename's names among them.
  readonly infoWrites: { characteristic: string; value: unknown }[];
  // The record the projection answers from, which an arm moves to read the verdict, undefined standing for a record that has left the state.
  live: { record: AccessStateDevice | undefined };
  loop: () => Promise<void>;
  projection: AccessDeviceProjection;
  // What the device attached to the bridge and what it later detached, by event name, so a registration and its teardown can be read as a pair.
  registrations: string[];
  removals: string[];
  // The UUIDs each save Homebridge accepted named, in the order it accepted them, which only an arm that put the accessory on the bridge can see.
  readonly saves: string[][];
  warnings: string[];
}

/* Build the harness around one scripted observation. The projection answers peek() live, as the library's does: it starts at the construction record and each scripted
 * record takes its place ahead of the yield, so an entry of undefined is a record that left the state between the yield and the read - the removal-grace window.
 *
 * The platform double carries the real feature-option engine, seeded with whatever entries the arm configures, and a warn channel that captures what it is handed.
 * That is what lets the debug arms drive a device's own gate end to end - the composition, the scope resolution, and the channel the line lands on - rather than
 * asserting against a stub that decided the answer for them.
 *
 * The controller is the shared double, told only what this suite varies: the connection holder its client reads live, the registration and emission recorders, the
 * identity, the broker double an arm reads publishes from, the platform above, and the loop capture. Its device name and its own name are separate members there,
 * so a rendered prefix an arm reads shows for itself that no controller half reached it.
 *
 * The accessory is built here, once per harness, so the writes an arm reads are the ones its own device made to it.
 *
 * @param script - The records the projection yields, in order.
 * @param init   - The accessory's name, whether it is registered so its saves reach Homebridge, the device record construction seeds this device from, the
 *                 broker double the controller publishes through where an arm reads what reached the broker, and the feature-option entries the engine resolves
 *                 against.
 */
function makeHarness(script: (AccessStateDevice | undefined)[], init: { accessoryName?: string; bridged?: boolean; construction?: AccessStateDevice & { mac: string };
  mqtt?: TestMqttClient; options?: string[]; } = {}): Harness {

  const clock = new TestClock();
  const emissions: AccessEventPacket[] = [];
  const registrations: string[] = [];
  const removals: string[] = [];
  const infoLines: string[] = [];
  const warnings: string[] = [];
  const stood = makeAccessory({ name: init.accessoryName });
  const construction = init.construction ?? record();
  const engine = new FeatureOptions(featureOptionCategories, featureOptions, init.options ?? []);
  // A connection that reads healthy unless an arm says otherwise, which is the state a device is configured under in the field.
  const connection = { isHealthy: true, isLost: false };
  const live: { record: AccessStateDevice | undefined } = { record: construction };
  let loop: () => Promise<void> = async (): Promise<void> => undefined;

  const projection = {

    config: construction,
    observe: async function *(): AsyncGenerator {

      for(const entry of script) {

        live.record = entry;

        yield projection;
      }
    },
    peek: (): AccessStateDevice | undefined => live.record
  };

  // The Homebridge API double the platform saves through, held here so the saves an arm reads are the ones this device's persistence made.
  const api = makeTestApi();
  const platform = makePlatformDouble({

    api,
    clock,
    featureOptions: engine,
    log: { error: (): void => undefined, info: (message: string, ...parameters: unknown[]): void => { infoLines.push(format(message, ...parameters)); },
      warn: (message: string, ...parameters: unknown[]): void => { warnings.push(format(message, ...parameters)); } }
  });

  // The persistence saves only an accessory the bridge holds, so an arm about what reaches Homebridge's accessory cache registers the accessory first, as adoption does.
  if(init.bridged) {

    platform.registerAccessory(stood.accessory);
  }

  const controller = makeControllerDouble({

    /* The client the availability verdict reads its controller-wide half through. The nesting is the verdict's own read path, and it matters because the shared double
     * spreads this client over a default whose connection is never lost...a holder placed anywhere else is ignored, and the verdict reads available whatever the arm
     * sets.
     */
    client: { connection },
    events: {

      emitPacket: (packet: AccessEventPacket): void => { emissions.push(packet); },
      off: (event: string): void => { removals.push(event); },
      on: (event: string): void => { registrations.push(event); }
    },
    id: controllerIdentity({ address: "1.2.3.4", mac: CONTROLLER_ID }),
    mqtt: init.mqtt,
    platform,
    spawnLoop: (_title: string, body: () => Promise<void>): void => { loop = body; }
  });

  return {

    accessory: stood.accessory,
    clock,
    connection,
    construction,
    controller,
    emissions,
    featureOptions: engine,
    infoLines,
    get infoWrites(): { characteristic: string; value: unknown }[] {

      return writesOn(stood.accessory, stood.information);
    },
    live,
    loop: (): Promise<void> => loop(),
    projection: projection as unknown as AccessDeviceProjection,
    registrations,
    removals,
    get saves(): string[][] {

      return savesOn(api);
    },
    warnings
  };
}

// The accessory a device is stood up on, and the service on it an arm reads the device's writes from.
interface DeviceAccessory {

  accessory: TestAccessAccessory;
  // The information service HAP gives every accessory at construction, which the device stamps and a rename writes into.
  information: Service;
}

/* Stand up the accessory a device is built on: Homebridge's own, so the library's reflection over the first service's constructor finds HAP's information service
 * where Homebridge places it, and every lookup and write the device makes runs through HAP as it does in the field. The name is the accessory's display name and
 * its information service's name at once, as HAP sets them together at construction, because the device reads its current name from that characteristic before it decides
 * whether a record's alias is a change.
 *
 * The accessory records from the moment each service joins it, so what an arm reads is what the device wrote after construction.
 *
 * @param options - name: the accessory's name, "Test Hub" by default.
 *
 * @returns The accessory and the service an arm reads writes from.
 */
function makeAccessory({ name = "Test Hub" }: { name?: string } = {}): DeviceAccessory {

  const accessory = makeTestAccessory(name);
  const information = accessory.getService(Service.AccessoryInformation);

  assert.ok(information, "HAP gives every accessory an information service at construction");

  return { accessory, information };
}

test("availability composes the controller's verdict with the device's own record", async () => {

  /* Both records read fully online, so what separates the two harnesses is the controller's connection alone. Each arm drives its own harness rather than one flipped
   * mid-script, because the script harness walks a single observe pass per loop call and replays nothing.
   */
  const lost = new TestMqttClient();
  const outage = makeHarness([record()], { mqtt: lost });

  outage.connection.isLost = true;

  const unavailable = new TestDevice(outage.controller, outage.projection, outage.accessory, outage.construction);

  await outage.loop();

  assert.equal(unavailable.isAvailable, false, "a device behind a lost controller is unavailable, whatever its own record last said");
  assert.deepEqual(lost.published, [{ payload: "offline", retain: true, topic: AVAILABILITY_TOPIC }], "and the loop states that verdict rather than the record's flags");

  const standing = new TestMqttClient();
  const healthy = makeHarness([record()], { mqtt: standing });
  const available = new TestDevice(healthy.controller, healthy.projection, healthy.accessory, healthy.construction);

  await healthy.loop();

  assert.equal(available.isAvailable, true, "the same record behind a connection not lost reads available");
  assert.deepEqual(standing.published, [{ payload: "online", retain: true, topic: AVAILABILITY_TOPIC }]);
});

test("a reader wrapped in the device's rule answers while the device is available and refuses with the communication-failure status while it is not, " +
  "consulting the verdict on every read", () => {

  /* The rule is driven through the device the base really bound rather than through a wrapper the arm built, which is what makes the bind site itself the thing
   * under test. Each term of the verdict is moved on its own, because a reader that consulted only one of them would pass on the other's strength.
   */
  const harness = makeHarness([record()]);
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);
  const read = device.answer(() => true);
  const refusal = { constructor: hap.HapStatusError, hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE };

  assert.equal(read(), true, "a reader answers under a connection not lost and an online record");

  harness.connection.isHealthy = false;

  assert.equal(read(), true, "and through a blip, where only the library's first-fault flag has moved");

  harness.connection.isHealthy = true;
  harness.connection.isLost = true;

  // The controller term refuses with HAP's own status error carrying the communication-failure status.
  assert.throws(() => read(), refusal);

  harness.connection.isLost = false;

  assert.equal(read(), true, "and the next read after recovery answers, because the rule consults the verdict on every read rather than capturing it once");

  // The device's own record gates the read from there, read live from the projection and never from what the device holds through a removal delay.
  harness.live.record = record({ is_online: false });

  assert.equal(device.uda.is_online, true, "the device still holds the record it last took");
  assert.throws(() => read(), refusal);

  harness.live.record = undefined;

  assert.throws(() => read(), refusal);

  harness.live.record = record();

  assert.equal(read(), true, "and a record that returns answers");
});

test("the availability statement goes on the device's own topic, retained, and only when the verdict moves", () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.publishAvailability();
  device.publishAvailability();

  /* The second call leaves the verdict where the first put it, so the client's change gate answers it with nothing sent. The record loop states availability on every
   * delivery, and a publish per delivery would repeat to the broker a word it already holds.
   */
  assert.deepEqual(mqtt.published, [{ payload: "online", retain: true, topic: AVAILABILITY_TOPIC }]);

  harness.connection.isLost = true;
  device.publishAvailability();
  device.publishAvailability();

  assert.deepEqual(mqtt.published.slice(1), [{ payload: "offline", retain: true, topic: AVAILABILITY_TOPIC }], "a move to unavailable is stated once, in the other word");

  harness.connection.isLost = false;
  device.publishAvailability();

  assert.deepEqual(mqtt.published.slice(2), [{ payload: "online", retain: true, topic: AVAILABILITY_TOPIC }], "and the way back is stated once as well");
});

test("the record loop states availability on the deliveries that move it and on no other", async () => {

  // Each reading arrives twice: the first delivery of each moves the verdict, and the one behind it restates it with an unrelated member changed.
  const mqtt = new TestMqttClient();
  const harness = makeHarness([ record(), record({ alias: "Renamed" }), record({ is_online: false }), record({ alias: "Renamed Again", is_online: false }) ],
    { mqtt });

  new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  await harness.loop();

  // The broker hears only the deliveries that moved the verdict.
  assert.deepEqual(mqtt.published, [ { payload: "online", retain: true, topic: AVAILABILITY_TOPIC }, { payload: "offline", retain: true, topic: AVAILABILITY_TOPIC } ]);
});

test("removal states offline as the device's last word, past the end of its own lifetime, and a device re-adopted under its identity states online again", async () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.publishAvailability();

  /* The removal's statement is held in flight across the abort that ends the device's lifetime, which is where a statement bound to that lifetime is withdrawn:
   * the double admits a held publish again, against the signal it carries, once it is released, as the client races its acknowledgement against that signal.
   */
  const release = mqtt.holdPublishes();

  device.cleanup();
  release();
  await settle();

  assert.deepEqual(mqtt.published, [ { payload: "online", retain: true, topic: AVAILABILITY_TOPIC }, { payload: "offline", retain: true, topic: AVAILABILITY_TOPIC } ],
    "the offline goes out once, retained, and survives the abort it was issued ahead of");

  // Nothing the removed device does afterwards reaches its topics. This call would state online over the offline if anything but the ended lifetime stopped it.
  device.publishAvailability();
  await settle();

  assert.equal(mqtt.published.length, 2, "a removed device states nothing further");

  /* A device re-adopted under the same identity states online again. The removal's statement was change-gated, which is what wrote offline into the client's
   * memory of the topic...an ungated one would have left online remembered there, and this statement would have been swallowed as unchanged.
   */
  const readopted = new TestDevice(harness.controller, harness.projection, makeAccessory().accessory, harness.construction);

  readopted.publishAvailability();

  assert.deepEqual(mqtt.published.slice(2), [{ payload: "online", retain: true, topic: AVAILABILITY_TOPIC }]);
});

/* Each final-word arm reads only what the client's end adds, sliced from the record as it stood before the end began, so a word the end never stated cannot pass on
 * the strength of an availability statement the device made earlier.
 */
test("a device's final word is its retained offline, stated through the client's end under the signal the end hands it", async () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.publishAvailability();

  const before = mqtt.published.length;

  // A word published under any signal but the one the end handed it, or through a chokepoint that supplies another, is refused, and the end resolves the refusal.
  assert.deepEqual(await mqtt.end(), [], "the end records no refusal");
  assert.deepEqual(mqtt.published.slice(before), [{ payload: "offline", retain: true, topic: AVAILABILITY_TOPIC }], "the word states offline, retained");
  assert.equal(mqtt.aborted, true, "and the end tears the client down once the word is said");
});

test("an unavailable device that has already stated offline states it again as its final word, because the word is never weighed against its last " +
  "statement", async () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  harness.connection.isLost = true;
  device.publishAvailability();

  assert.deepEqual(mqtt.published, [{ payload: "offline", retain: true, topic: AVAILABILITY_TOPIC }], "the unavailable device has stated offline already");

  const before = mqtt.published.length;

  assert.deepEqual(await mqtt.end(), [], "the end records no refusal");
  assert.deepEqual(mqtt.published.slice(before), [{ payload: "offline", retain: true, topic: AVAILABILITY_TOPIC }],
    "the word goes out all the same, where a change-gated word would find offline remembered and send nothing");
});

test("a final word the broker cannot take is the refusal the end resolves with, because the word hands the end its publish to wait on", async () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });

  new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  // The client holds no broker session, so it refuses the word. A word that issued its publish without returning it would leave the end nothing to wait on, and the
  // end would resolve as though the word had been said.
  mqtt.connected = false;

  const refusals = await mqtt.end();

  assert.equal(refusals.length, 1, "the one word is the one refusal");
  assert.ok(refusals[0] instanceof MqttOfflineError, "and it is the client's own refusal of a publish it holds no session for");
  assert.deepEqual(mqtt.publishedTo(AVAILABILITY_TOPIC), [], "nothing reaches the broker");
});

test("a device removed before shutdown states no final word, because its removal released the registration with its lifetime", async () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.publishAvailability();
  device.cleanup();
  await settle();

  const before = mqtt.published.length;

  assert.deepEqual(await mqtt.end(), [], "the end records no refusal");
  assert.deepEqual(mqtt.published.slice(before), [], "the removal stated offline already, and the end says nothing more for a device that is gone");
});

/* A contract arm over the client's own quieting, which is what keeps the word the device's last statement: once the end begins, a publish carrying any signal but the
 * one the end handed out is refused. On this side it goes red for a shutdown that states the words some way other than through the client's end. The device starts
 * unavailable, so the online it would state is a change the change gate lets through rather than one it suppresses.
 */
test("an availability change while the end states the word records no online behind it", async () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  harness.connection.isLost = true;
  device.publishAvailability();

  const before = mqtt.published.length;
  // The word is held mid-flight, which holds the end inside its grace while the device's availability comes back.
  const release = mqtt.holdPublishes();
  const ended = mqtt.end();

  harness.connection.isLost = false;
  device.publishAvailability();
  release();

  assert.deepEqual(await ended, [], "the end records no refusal");
  assert.deepEqual(mqtt.published.slice(before), [{ payload: "offline", retain: true, topic: AVAILABILITY_TOPIC }],
    "the word is the only statement the end records, with no online behind it");
});

test("a get and a set registered under a lifetime of their own leave with that lifetime while the device stays, and with the device whatever they were " +
  "handed", () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });
  const device = new AnsweringDevice(harness.controller, harness.projection, harness.accessory, harness.construction);
  const topics = (): string[] => mqtt.subscriptions.map(entry => entry.topic).sort();
  const shorter = new AbortController();

  device.answer(shorter.signal);

  assert.deepEqual(topics(), [ mqttGetTopic("AABBCCDDEE01/lock"), mqttSetTopic("AABBCCDDEE01/lock") ], "the get and the set register on the device's own topic");

  // The shorter lifetime ending releases its registrations, the set's as well as the get's, while the device itself carries on.
  shorter.abort();

  assert.deepEqual(topics(), [], "a lifetime handed to the set releases it exactly as the get's releases the get");
  assert.equal(device.signal.aborted, false, "and the device is untouched by it");

  // Registrations made under a lifetime that never ends still leave with the device, because each is composed with the device's own.
  device.answer(new AbortController().signal);
  device.cleanup();

  assert.deepEqual(topics(), [], "a removed device leaves no registration behind, whatever lifetime each was handed");
});

test("a present record yields exactly one update carrying the wire's own packet shape", async () => {

  const harness = makeHarness([record({ alias: "Renamed" })]);
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  await harness.loop();

  assert.equal(harness.emissions.length, 1, "a present-record yield must deliver exactly one update");
  assert.deepEqual(harness.emissions[0], {

    data: device.uda,
    event: "access.data.device.update",
    event_object_id: "device1",
    receiver_id: "",
    save_to_history: false
  });

  // The loop is the only writer of the held record, and it wrote the record the yield carried.
  assert.equal(device.uda.alias, "Renamed");
});

test("a record that has left the state produces no update and no statement", async () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([undefined], { mqtt });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);
  const held = device.uda;

  await harness.loop();

  assert.equal(harness.emissions.length, 0, "a departed device must never emit a stale update");
  assert.deepEqual(mqtt.published, [], "and states nothing");
  assert.equal(device.uda, held, "the held record must be left exactly as construction seeded it");
});

test("a delivered update carrying an offline record drives availability false", async () => {

  // The record rail is what carries connectivity: the newer notification dialect folds its own online field onto this member, so a device going offline reaches the
  // observe loop as an ordinary record update rather than as a signal of its own.
  const mqtt = new TestMqttClient();
  const harness = makeHarness([record({ is_online: false })], { mqtt });

  new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  await harness.loop();

  assert.deepEqual(mqtt.published, [{ payload: "offline", retain: true, topic: AVAILABILITY_TOPIC }], "a delivered offline record is stated offline");
});

test("a timer armed on a device is drained by cleanup and can never arm again afterwards", () => {

  const harness = makeHarness([]);
  const device = new TimerDevice(harness.controller, harness.projection, harness.accessory, harness.construction);
  let fired = 0;

  device.arm("relock-main", () => fired++, TIMER_DELAY_MS);
  assert.equal(device.isArmed("relock-main"), true, "an armed timer must be reported as armed");
  assert.equal(harness.clock.nextDeadline, TIMER_DELAY_MS, "and it is armed on the platform's clock, which is what makes the drain below observable at all");

  // Ending the device's own lifetime is what drains the registry - the plumbing under test is that the two are composed at all, with no explicit dispose call.
  device.cleanup();
  assert.equal(device.isArmed("relock-main"), false, "cleanup must drain a pending timer through the composed lifetime");

  /* The drained timer is off the timeline rather than merely unreported. A registry that dropped its own record while leaving the timer armed would still answer a
   * deadline here, and would fire it on the advance below - which a wait that watched nothing happen could never tell apart from a genuine drain.
   */
  assert.equal(harness.clock.nextDeadline, null, "a drained timer leaves no deadline behind it");

  harness.clock.advance(TIMER_DELAY_MS);
  assert.equal(fired, 0, "a drained timer must never fire");

  // The far side of the same composition: a registration attempted after the lifetime ended is inert, so nothing can arm against a torn-down device.
  device.arm("relock-main", () => fired++, TIMER_DELAY_MS);
  assert.equal(device.isArmed("relock-main"), false, "a registration after teardown must be inert");
  assert.equal(harness.clock.nextDeadline, null, "and an inert registration puts nothing on the timeline either");

  harness.clock.advance(TIMER_DELAY_MS);
  assert.equal(fired, 0);
});

test("a device's debug lines carry its name and answer an entry suffixed with its own identity", () => {

  const entries = ["Enable.Log.Debug.AABBCCDDEE01"];
  const owner = makeHarness([], { options: entries });
  const device = new TestDevice(owner.controller, owner.projection, owner.accessory, owner.construction);

  device.log.debug("Owner speaks.");

  // The name appears once and the line lands on warn, the channel Homebridge prints whatever its own debug switch is doing. A gate composed inside the prefix rather
  // than around it would still emit this line, but it would compose the name before asking whether anyone wanted the line at all.
  assert.deepEqual(owner.warnings, ["Test Hub [UA Hub]: Owner speaks."]);

  const sibling = makeHarness([], { construction: record({ mac: "aabbccddee02" }), options: entries });
  const quiet = new TestDevice(sibling.controller, sibling.projection, sibling.accessory, sibling.construction);

  quiet.log.debug("Sibling speaks.");

  // A sibling on the same controller is named by no entry here, so turning one device on leaves the rest of them alone.
  assert.deepEqual(sibling.warnings, []);
});

test("a device's log prefix names the device alone, with no half naming the controller it belongs to", () => {

  const harness = makeHarness([]);
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.log.info("Owner speaks.");

  /* The prefix is the device composition and nothing else. The second assertion is the one that separates this from a device answering at its owner's name: the
   * controller double carries its own name as a distinct member, so a prefix reaching for it rather than for the device composition would carry that name here.
   */
  assert.deepEqual(harness.infoLines, ["Test Hub [UA Hub]: Owner speaks."]);
  assert.ok(!harness.infoLines.some(line => line.includes("Test Controller")), "a device line must never name the controller it belongs to");
});

test("a device entry outranks the controller entry that would otherwise answer for it", () => {

  /* One device is turned on by its own entry while the controller it belongs to is turned off, which is the pair that states the resolution order out loud: the engine
   * consults the device scope before the controller scope, so the device is handed over first...a transposed pair would resolve this device against the controller's
   * disabled entry and silence a line the user asked for by name.
   */
  const entries = [ "Enable.Log.Debug.AABBCCDDEE01", "Disable.Log.Debug." + CONTROLLER_ID ];
  const owner = makeHarness([], { options: entries });
  const device = new TestDevice(owner.controller, owner.projection, owner.accessory, owner.construction);

  device.log.debug("Owner speaks.");

  assert.deepEqual(owner.warnings, ["Test Hub [UA Hub]: Owner speaks."]);

  const sibling = makeHarness([], { construction: record({ mac: "aabbccddee02" }), options: entries });
  const quiet = new TestDevice(sibling.controller, sibling.projection, sibling.accessory, sibling.construction);

  quiet.log.debug("Sibling speaks.");

  // Nothing names the sibling, so the controller entry is what answers for it, and it says no.
  assert.deepEqual(sibling.warnings, []);
});

test("a device's identity is captured at adoption and survives a record whose own identity moves", async () => {

  /* The observe loop hands this device a record naming a different address than the one it was adopted on. That cannot happen through any path the controller
   * actually drives, and it is exactly the drift the capture exists to make impossible: an accessory's identity is frozen by every cache in the field, so a
   * record moving underneath it must not move the accessory with it.
   */
  const harness = makeHarness([record({ mac: "ffeeddccbb02" })]);
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configureInfo();

  assert.deepEqual(harness.infoWrites.filter(write => write.characteristic === Characteristic.SerialNumber.UUID),
    [{ characteristic: Characteristic.SerialNumber.UUID, value: "AABBCCDDEE01" }]);
  assert.equal(device.id, "AABBCCDDEE01");

  await harness.loop();

  // The tick genuinely moved the held record, which is what makes the two assertions below mean something.
  assert.equal(device.uda.mac, "ffeeddccbb02", "the loop must have written the record the yield carried");

  assert.equal(device.id, "AABBCCDDEE01", "the identity is captured once and never re-read from the live record");

  /* The second stamp is the assertion a device information write still reading the live record fails: the identity could be captured correctly while setInfo
   * went on writing whatever the record says now.
   */
  device.configureInfo();

  assert.deepEqual(harness.infoWrites.filter(write => write.characteristic === Characteristic.SerialNumber.UUID),
    [ { characteristic: Characteristic.SerialNumber.UUID, value: "AABBCCDDEE01" }, { characteristic: Characteristic.SerialNumber.UUID, value: "AABBCCDDEE01" } ]);
});

test("an Enterprise hub port answers the option entries that name it, and its sibling answers none of them", () => {

  /* Two ports of one hub, sharing a MAC address and differing only by their qualifier. The entries name port1 by the identity the plugin addresses it with, a
   * boolean and a value, and nothing names port2, so every read below has to answer for the port it was asked about: a boolean gate reaching the engine with the
   * bare hub serial would answer true for both, and a gate whose scope carried no qualifier while the value reads carried one would leave a per-port option
   * addressable by neither.
   */
  const entries = [ "Enable.Device.SyncName.AABBCCDDEE02-PORT1", "Enable.Hub.LockDelayInterval.AABBCCDDEE02-PORT1.5" ];
  const portOne = makeHarness([], { construction: portRecord("port1"), options: entries });
  const portTwo = makeHarness([], { construction: portRecord("port2"), options: entries });
  const one = new TestDevice(portOne.controller, portOne.projection, portOne.accessory, portOne.construction);
  const two = new TestDevice(portTwo.controller, portTwo.projection, portTwo.accessory, portTwo.construction);

  assert.equal(one.hasFeature("Device.SyncName"), true, "the entry names this port, so this port's own gate must answer true");
  assert.equal(two.hasFeature("Device.SyncName"), false, "nothing names its sibling, so the sibling's gate must answer false");

  assert.equal(one.getFeatureNumber("Hub.LockDelayInterval"), 5);
  assert.equal(two.getFeatureNumber("Hub.LockDelayInterval") ?? undefined, undefined, "an option nothing configured for this port answers nothing");

  one.configure();
  two.configure();

  assert.equal(one.hints.syncName, true, "the hint the gate decides must follow the gate");
  assert.equal(two.hints.syncName, false);

  // The deviation the user is told about is the one that happened, on the port it happened to, under that port's own name.
  assert.deepEqual(portOne.infoLines, ["Test Hub [UA Hub]: Device name synchronization enabled."]);
  assert.deepEqual(portTwo.infoLines, []);

  // The control: with nothing configured at all, both ports answer the catalog default and neither has a deviation to report.
  const bareOne = makeHarness([], { construction: portRecord("port1") });
  const bareTwo = makeHarness([], { construction: portRecord("port2") });
  const plainOne = new TestDevice(bareOne.controller, bareOne.projection, bareOne.accessory, bareOne.construction);
  const plainTwo = new TestDevice(bareTwo.controller, bareTwo.projection, bareTwo.accessory, bareTwo.construction);

  plainOne.configure();
  plainTwo.configure();

  assert.equal(plainOne.hasFeature("Device.SyncName"), false);
  assert.equal(plainTwo.hasFeature("Device.SyncName"), false);
  assert.deepEqual(bareOne.infoLines, []);
  assert.deepEqual(bareTwo.infoLines, []);
});

test("one string carries a device's option scope, its MQTT topic tail, and the identity the webUI writes against", () => {

  const harness = makeHarness([], { construction: portRecord("port1"), options: ["Enable.Device.SyncName.AABBCCDDEE02-PORT1"] });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  /* The webUI server decorates its device list by calling this same function on the same record, so what a user writes an entry against in the browser is what
   * the plugin reads it back by. The literal beside it is what proves the spelling rather than agreeing with whatever the composition happens to answer.
   */
  assert.equal(device.id, deviceSerial(harness.construction));
  assert.equal(device.id, "AABBCCDDEE02-PORT1");

  // The broker sees the same string, so a topic reads exactly as the device is addressed everywhere else.
  assert.equal(mqttTopic(device.id, "lock"), "AABBCCDDEE02-PORT1/lock");

  // And the engine resolves that string at the device scope, which is what lets a device entry outrank the controller entry that would otherwise answer for it.
  assert.equal(harness.featureOptions.scope("Device.SyncName", device.id, CONTROLLER_ID), "device");

  // The brand is a compile-time statement: this declaration is what the typecheck fails on if the identity is ever widened to a plain string.
  const serial: DecoratedSerial = device.id;

  assert.equal(serial, "AABBCCDDEE02-PORT1");
});

test("an Enterprise port's identity is captured at adoption and survives a record whose port key moves", async () => {

  /* The observe loop hands this device a record carrying the sibling port's key. No path the controller drives can do that, and it is exactly the drift the
   * capture exists to make impossible: an accessory's identity is frozen by every cache in the field, and a port's qualifier is half of the identity here.
   */
  const harness = makeHarness([portRecord("port2")], { construction: portRecord("port1") });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  assert.equal(device.id, "AABBCCDDEE02-PORT1");

  await harness.loop();

  // The tick genuinely moved the held record, which is what makes the assertion below mean something.
  assert.equal(device.uda.source_id, "port2", "the loop must have written the record the yield carried");
  assert.equal(device.id, "AABBCCDDEE02-PORT1", "the identity is composed once and never re-read from the live record");
});

test("a typed delivery registration lands in the same map that cleanup drains", () => {

  const harness = makeHarness([]);
  const device = new DeliveryDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.listen();

  // The delivery rail registers under its own prefix, which is what keeps it apart from the socket vocabulary that shares its event names.
  assert.deepEqual(harness.registrations, [ACCESS_WEBHOOK_EVENT_PREFIX + ACCESS_WEBHOOK_EVENTS.doorUnlock]);
  assert.deepEqual(harness.removals, []);

  device.cleanup();

  // One map and one loop serve both kinds of handler, so a delivery listener is detached by exactly the teardown a packet listener is.
  assert.deepEqual(harness.removals, [ACCESS_WEBHOOK_EVENT_PREFIX + ACCESS_WEBHOOK_EVENTS.doorUnlock]);
});

// The writes a rename makes to the information service's names, read in the order HAP raised them.
function nameWrites(harness: Harness): { characteristic: string; value: unknown }[] {

  return harness.infoWrites.filter(write => [ Characteristic.ConfiguredName.UUID, Characteristic.Name.UUID ].includes(write.characteristic));
}

test("a device with name synchronization off leaves its accessory's name as it stands, whatever its alias reads", () => {

  const harness = makeHarness([], { construction: record({ alias: "Front Door" }) });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();
  device.configureInfo();

  assert.equal(device.homeKit(), "Front Door", "the name the device would apply is its alias");
  assert.equal(device.accessoryName, "Test Hub", "yet a user who did not ask for synchronization keeps the name the accessory carries, however plainly the alias reads");
  assert.deepEqual(nameWrites(harness), [], "so nothing is written to the information service's names");
});

test("the name a device applies is its alias as HomeKit's naming rules leave it", () => {

  const harness = makeHarness([], { construction: record({ alias: "Front Gate \u{1F6AA}" }), options: ["Enable.Device.SyncName"] });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  assert.equal(device.homeKit(), "Front Gate", "the alias carries a character HomeKit will not take, so what applies is what survives the rules");
});

test("an alias with nothing left under HomeKit's naming rules gives way to the record's own name", () => {

  const harness = makeHarness([], { construction: record({ alias: "...", name: "Gate Hub" }), options: ["Enable.Device.SyncName"] });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  assert.equal(device.homeKit(), "Gate Hub", "the rules empty this alias out, so the name that applies is the next one HomeKit can carry");
});

test("a record whose alias empties out under HomeKit's naming rules synchronizes the accessory to the record's own name, and says so once", async (t) => {

  const harness = makeHarness([record({ alias: "...", name: "Back Door" })], { accessoryName: "Front Door", construction: record({ alias: "Front Door" }),
    options: ["Enable.Device.SyncName"] });
  // Every name Homebridge's own display-name setter is handed, so the arm reads how many times the rename reached it as well as what it was handed.
  const renames = t.mock.method(harness.accessory, "updateDisplayName");
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  await harness.loop();

  /* The tick genuinely moved the held record, which is what makes the assertions below mean something. The record's own name differs from the name the accessory
   * carries, so a loop that left the accessory alone, as it would for an alias with nothing to fall back to, fails here.
   */
  assert.equal(device.uda.alias, "...", "the loop must have written the record the yield carried");

  assert.deepEqual(renames.mock.calls.map((call) => call.arguments[0]), ["Back Door"], "the record's own name stands in for the alias, handed over once");
  assert.deepEqual(nameWrites(harness), [ { characteristic: Characteristic.ConfiguredName.UUID, value: "Back Door" },
    { characteristic: Characteristic.Name.UUID, value: "Back Door" } ], "and reaches the information service's names");
  assert.deepEqual(harness.infoLines.filter(line => line.includes("Detected a name change")),
    ["Test Hub [UA Hub]: Detected a name change on the controller; updating the HomeKit name to Back Door."], "and the change is reported once");
});

// The entry storing a custom name at the harness device's own scope, in the grammar the settings page writes.
function customName(value: string): string {

  return "Enable.Device.Name.AABBCCDDEE01=" + value;
}

test("a custom name replaces the name the accessory carries at every configure pass with synchronization off, and is announced as HomeKit carries it", () => {

  const harness = makeHarness([], { construction: record({ alias: "Front Door" }), options: [customName("Porch \u{1F319}")] });
  const information = harness.accessory.getService(Service.AccessoryInformation);

  assert.ok(information, "HAP gives every accessory an information service at construction");

  /* The accessory carries a rename made in the Home app during an earlier run, which the Home app writes into the information service's configured name, and the
   * custom name always applies, so it replaces that rename when the device is configured.
   */
  information.updateCharacteristic(Characteristic.ConfiguredName, "Home App Name");

  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();
  device.configureInfo();

  assert.equal(device.hints.nameOverride, "Porch \u{1F319}", "the hint holds the custom name as homebridge-plugin-utils resolves it, trimmed rather than cleaned");
  assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, "Porch", "the custom name replaces the rename where the Home app wrote it");
  assert.equal(device.accessoryName, "Porch", "the custom name names the accessory as HomeKit carries it");
  assert.equal(harness.accessory.displayName, "Porch");
  assert.deepEqual(harness.infoLines, ["Test Hub [UA Hub]: Custom HomeKit name set to Porch."], "and the line names the name HomeKit carries");
  assert.deepEqual(harness.warnings, []);
});

test("a custom name holds through a rename on the controller with synchronization on", async (t) => {

  const harness = makeHarness([record({ alias: "Back Door" })], { accessoryName: "Porch", construction: record({ alias: "Front Door" }),
    options: [ customName("Porch"), "Enable.Device.SyncName" ] });
  const renames = t.mock.method(harness.accessory, "updateDisplayName");
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();
  device.configureInfo();

  await harness.loop();

  assert.equal(device.uda.alias, "Back Door", "the loop must have written the record the yield carried");
  assert.equal(device.accessoryName, "Porch", "the custom name comes first, so the controller's rename does not reach HomeKit");
  assert.deepEqual(renames.mock.calls.map((call) => call.arguments[0]), [], "and Homebridge's own setter is never handed another name");
  assert.deepEqual(harness.infoLines.filter(line => line.includes("Detected a name change")), [], "nor is a change reported");
});

test("a custom name with synchronization off puts a Home app rename made after the configure pass back at once, and the record loop writes nothing " +
  "after it", async () => {

  const harness = makeHarness([record({ alias: "Back Door" })], { bridged: true, construction: record({ alias: "Front Door" }), options: [customName("Porch")] });
  const information = harness.accessory.getService(Service.AccessoryInformation);
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  assert.ok(information, "HAP gives every accessory an information service at construction");

  device.configure();
  device.configureInfo();
  harness.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

  assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, "Porch", "the configure pass applied the custom name");

  /* The user renames the device in the Home app once adoption has applied the custom name. The write carries the connection it arrived on, as the Home app's
   * does, and the restore the information service's watch arranges runs on the turn after it.
   */
  await triggerSet(information.getCharacteristic(Characteristic.ConfiguredName), "Home App Name");
  await settle();

  assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, "Porch", "the custom name is put back at once");
  assert.equal(harness.infoLines.filter(line => line.includes(RESTORED_LINE)).length, 1, "and the restore is logged once");

  const saves = harness.saves.length;

  await harness.loop();
  harness.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

  assert.equal(device.uda.alias, "Back Door", "the loop must have written the record the yield carried");
  assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, "Porch", "the restored name stands through the loop");
  assert.equal(harness.saves.length, saves, "which writes nothing and has nothing to save");
  assert.deepEqual(harness.infoLines.filter(line => line.includes("Detected a name change")), [], "and no change is reported");
});

test("a cleared custom name keeps the name the accessory carries with synchronization off, and gives way to the controller's name with it on", () => {

  // Each accessory carries the name an earlier custom name applied, and the settings hold no custom name.
  const off = makeHarness([], { accessoryName: "Porch", construction: record({ alias: "Front Door" }) });
  const on = makeHarness([], { accessoryName: "Porch", construction: record({ alias: "Front Door" }), options: ["Enable.Device.SyncName"] });
  const kept = new TestDevice(off.controller, off.projection, off.accessory, off.construction);
  const synced = new TestDevice(on.controller, on.projection, on.accessory, on.construction);

  for(const device of [ kept, synced ]) {

    device.configure();
    device.configureInfo();
  }

  assert.equal(kept.accessoryName, "Porch", "with nothing in force the accessory keeps the name it carries");
  assert.equal(synced.accessoryName, "Front Door", "and with synchronization on the controller's name applies once the custom name is gone");
});

test("a custom name HomeKit can display nothing of is refused with a warning, and the device is named as if none were set", () => {

  const harness = makeHarness([], { accessoryName: "Front Door", construction: record({ alias: "Front Door" }), options: [customName("\u{1F6AA}")] });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();
  device.configureInfo();

  assert.equal(device.hints.nameOverride, null, "homebridge-plugin-utils' rule refuses a custom name HomeKit can carry nothing of");
  assert.deepEqual(harness.warnings, ["Test Hub [UA Hub]: The custom name \"\u{1F6AA}\" leaves nothing HomeKit can display, so it is not applied."],
    "the refusal is said once, naming the value as stored");
  assert.deepEqual(harness.infoLines, [], "and no custom name is announced");
  assert.equal(device.homeKit(), "Front Door", "the device's own name is the name that applies");
  assert.deepEqual(nameWrites(harness), [], "and with synchronization off nothing is written");
});

test("a custom name enabled with no value set is no custom name, and warns nothing", () => {

  // The entry enables the option at the device's own scope and carries no value, so there is no stored name for the refusal to speak about.
  const harness = makeHarness([], { construction: record({ alias: "Front Door" }), options: ["Enable.Device.Name.AABBCCDDEE01"] });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();
  device.configureInfo();

  assert.equal(device.hints.nameOverride, null, "an entry with no value resolves to no custom name");
  assert.deepEqual(harness.warnings, [], "and it is no refusal, so nothing is warned");
  assert.deepEqual(harness.infoLines, [], "nor is a custom name announced");
  assert.deepEqual(nameWrites(harness), [], "and with synchronization off nothing is written");
});

test("a name past HomeKit's length limit renames the accessory once, however many records repeat it", async (t) => {

  // The information service carries a name cut to HomeKit's length limit, so a loop comparing that cut name with the whole one would rename on every record.
  const long = "Front Door Of The Main Building Facing The North Parking Lot Entrance Gate";
  const harness = makeHarness([ record({ alias: long }), record({ alias: long }) ], { accessoryName: "Front Door", construction: record({ alias: "Front Door" }),
    options: ["Enable.Device.SyncName"] });
  const renames = t.mock.method(harness.accessory, "updateDisplayName");
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  await harness.loop();

  assert.notEqual(device.accessoryName, long, "the information service carries the name cut, which is what makes the second record the case under test");
  assert.deepEqual(renames.mock.calls.map((call) => call.arguments[0]), [long], "Homebridge's own setter is handed the name once");
  assert.equal(harness.infoLines.filter(line => line.includes("Detected a name change")).length, 1, "and the change is reported once rather than on every record");
});

test("a record whose alias changed leaves the accessory's name as it stands with name synchronization off, and reports nothing", async (t) => {

  // Name synchronization is off, its default, so the controller's rename the yield carries is one the user never asked HomeKit to follow.
  const harness = makeHarness([record({ alias: "Back Door" })], { accessoryName: "Front Door", construction: record({ alias: "Front Door" }) });
  const renames = t.mock.method(harness.accessory, "updateDisplayName");
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  await harness.loop();

  assert.equal(device.uda.alias, "Back Door", "the loop must have written the record the yield carried");
  assert.deepEqual(renames.mock.calls.map((call) => call.arguments[0]), [], "Homebridge's own setter is never handed the controller's new name");
  assert.deepEqual(nameWrites(harness), [], "nor is anything written to the information service's names");
  assert.deepEqual(harness.infoLines.filter(line => line.includes("Detected a name change")), [], "and no change is reported");
});

test("a record whose alias changed re-synchronizes the accessory name through the loop and says so once", async (t) => {

  const harness = makeHarness([record({ alias: "Back Door" })], { accessoryName: "Front Door", construction: record({ alias: "Front Door" }),
    options: ["Enable.Device.SyncName"] });
  // Every name Homebridge's own display-name setter is handed, so the arm reads how many times the rename reached it as well as what it was handed.
  const renames = t.mock.method(harness.accessory, "updateDisplayName");
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  await harness.loop();

  /* The positive half of the arm above it. The distinguishing input is the accessory's own name, which its information service answers and which differs from
   * the alias the tick writes: an accessory already named for that alias would compare equal to it, and no rename would ever be attempted.
   */
  assert.equal(device.uda.alias, "Back Door", "the loop must have written the record the yield carried");
  assert.deepEqual(renames.mock.calls.map((call) => call.arguments[0]), ["Back Door"], "the library's setter is handed the new name exactly once");
  assert.deepEqual(harness.infoWrites.filter(write => [ Characteristic.ConfiguredName.UUID, Characteristic.Name.UUID ].includes(write.characteristic)),
    [ { characteristic: Characteristic.ConfiguredName.UUID, value: "Back Door" }, { characteristic: Characteristic.Name.UUID, value: "Back Door" } ],
    "and the library writes the configured name and then the name onto the information service it found inside the accessory's own services");
  assert.deepEqual(harness.infoLines.filter(line => line.includes("Detected a name change")),
    ["Test Hub [UA Hub]: Detected a name change on the controller; updating the HomeKit name to Back Door."],
    "and the change is reported once, naming the name it settled on");
});

test("a rename the loop applies saves the accessory once, a window later, and setting the name it already carries saves nothing", async () => {

  const harness = makeHarness([record({ alias: "Back Door" })], { accessoryName: "Front Door", bridged: true, construction: record({ alias: "Front Door" }),
    options: ["Enable.Device.SyncName"] });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  await harness.loop();

  assert.equal(device.accessoryName, "Back Door", "the loop applied the alias the yield carried");
  assert.deepEqual(harness.saves, [], "and the rename waits for its window rather than saving at once");

  harness.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

  assert.deepEqual(harness.saves, [[harness.accessory.UUID]], "then saves the accessory once, when that window closes");

  // The library writes nothing for a name every place already carries, and a rename that wrote nothing has nothing to save.
  assert.equal(device.renameTo("Back Door"), false, "a rename to the name the accessory already carries answers that it wrote nothing");

  harness.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

  assert.equal(harness.saves.length, 1, "so it saves nothing more");
});

test("a record whose alias empties out to the name the accessory already shows saves the configured name it adds, and reports no change", async () => {

  const harness = makeHarness([record({ alias: "..." })], { bridged: true, construction: record({ alias: "Front Door" }), options: ["Enable.Device.SyncName"] });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  await harness.loop();
  harness.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

  assert.equal(device.uda.alias, "...", "the loop wrote the record the yield carried");
  assert.equal(device.homeKit(), harness.accessory.displayName, "the record's own name the alias gives way to is the name the accessory already shows");

  /* What the write and the line each answer to tells them apart here: the accessory has never carried a configured name, so applying the name writes one and the
   * write is saved, while the name the accessory shows did not move, so there is no change on the controller to report.
   */
  assert.deepEqual(nameWrites(harness), [{ characteristic: Characteristic.ConfiguredName.UUID, value: "Test Hub" }],
    "the only write is the configured name the accessory has never carried");
  assert.deepEqual(harness.saves, [[harness.accessory.UUID]], "which is saved once");
  assert.deepEqual(harness.infoLines.filter(line => line.includes("Detected a name change")), [], "and no change is reported");
});
