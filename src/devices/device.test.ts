/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.test.ts: Tests for what every AccessDevice composes: the observe loop, reachability and its HomeKit and MQTT projections, the debug gate, identity capture,
 * timers and listeners bound to the device lifetime, and name synchronization.
 */
/* eslint-disable camelcase */
import type { AccessDevice as AccessDeviceProjection, AccessEventPacket, AccessStateDevice } from "unifi-access";
import { Characteristic, Service, hap, hubRecord, makeControllerDouble, makePlatformDouble, makeTestAccessory, writesOn } from "../testing.helpers.ts";
import { FeatureOptions, HAPStatus, mqttTopic } from "homebridge-plugin-utils";
import { TestClock, TestMqttClient, settle } from "homebridge-plugin-utils/testing";
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
import test from "node:test";

// The controller every device below belongs to, in the casing a controller's own identity carries.
const CONTROLLER_ID = "112233445566";

// The window the timer arm below arms against. Any value serves: what the arm is about is whether the deadline survives teardown, not how long it was.
const TIMER_DELAY_MS = 10;

// The topic the shared hub record states its availability on, as the broker double records it: the device's identity and the catalog's tail, with no prefix.
const AVAILABILITY_TOPIC = "AABBCCDDEE01/availability";

/* AccessDevice supplies every abstract member AccessBase declares and adds none of its own, so a near-bare subclass is the whole harness the loop needs. The
 * wrappers expose the protected Not Responding rule, the protected hint configuration, and the protected synchronized-name derivation, which is how an arm drives
 * the real rule, the real option reads, the real deviation log, and the real derivation rather than paths it wrote itself.
 */
class TestDevice extends AccessDevice {

  public answer(read: () => boolean): () => boolean {

    return this.answering(read);
  }

  public configure(): boolean {

    return this.configureHints();
  }

  public synced(): string | undefined {

    return this.syncedName;
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

// A device record that reads as fully online, which is what the availability sweep below writes from.
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
  controller: AccessController;
  emissions: AccessEventPacket[];
  // The engine this harness seeded, so an arm can ask it the same question the device asks it.
  featureOptions: FeatureOptions;
  // What the controller's connection answers about its own health, in a holder the client double reads live so an arm can state it before the device is stood up
  // and move it afterwards.
  health: { isHealthy: boolean };
  // The lines the deviation log lands on, rendered as the logger would render them. It speaks at info, which is the channel a user reads at startup.
  infoLines: string[];
  // What the device wrote to the accessory's information service, the identity stamp and a rename's names among them.
  readonly infoWrites: { characteristic: string; value: unknown }[];
  loop: () => Promise<void>;
  // What the device wrote to the service carrying no availability characteristic, which is nothing where the arm asked for no such service.
  readonly otherWrites: { characteristic: string; value: unknown }[];
  projection: AccessDeviceProjection;
  // What the device attached to the bridge and what it later detached, by event name, so a registration and its teardown can be read as a pair.
  registrations: string[];
  removals: string[];
  // What the device wrote to the service carrying availability, which is every availability statement HomeKit was shown.
  readonly statusWrites: { characteristic: string; value: unknown }[];
  warnings: string[];
}

/* Build the harness around one scripted observation. The projection yields once per entry in the script and answers peek() with that entry, so an entry of undefined
 * is a record that left the state between the yield and the read - the removal-grace window.
 *
 * The platform double carries the real feature-option engine, seeded with whatever entries the arm configures, and a warn channel that captures what it is handed.
 * That is what lets the debug arms drive a device's own gate end to end - the composition, the scope resolution, and the channel the line lands on - rather than
 * asserting against a stub that decided the answer for them.
 *
 * The controller is the shared double, told only what this suite varies: the health holder its client reads live, the registration and emission recorders, the
 * identity, the broker double an arm reads publishes from, the platform above, and the loop capture. Its device name and its own name are separate members there,
 * so a rendered prefix an arm reads shows for itself that no controller half reached it.
 *
 * The accessory is built here, once per harness, so the writes an arm reads are the ones its own device made to it.
 *
 * @param script - The records the projection yields, in order.
 * @param init   - The accessory's name, the device record construction seeds this device from, the broker double the controller publishes through where an arm
 *                 reads what reached the broker, the feature-option entries the engine resolves against, and whether the accessory carries a service with no
 *                 availability characteristic beside the one that has it.
 */
function makeHarness(script: (AccessStateDevice | undefined)[], init: { accessoryName?: string; construction?: AccessStateDevice & { mac: string };
  mqtt?: TestMqttClient; options?: string[]; otherService?: boolean; } = {}): Harness {

  const clock = new TestClock();
  const emissions: AccessEventPacket[] = [];
  const registrations: string[] = [];
  const removals: string[] = [];
  const infoLines: string[] = [];
  const warnings: string[] = [];
  const stood = makeAccessory({ name: init.accessoryName, other: init.otherService });
  const construction = init.construction ?? record();
  const engine = new FeatureOptions(featureOptionCategories, featureOptions, init.options ?? []);
  // A connection that reads healthy unless an arm says otherwise, which is the state a device is configured under in the field.
  const health = { isHealthy: true };
  let peekIndex = 0;
  let loop: () => Promise<void> = async (): Promise<void> => undefined;

  const projection = {

    config: construction,
    observe: async function *(): AsyncGenerator {

      for(const _entry of script) {

        yield projection;
      }
    },
    peek: (): AccessStateDevice | undefined => script[peekIndex++]
  };

  const controller = makeControllerDouble({

    /* The client the availability composition reads its controller-wide half through. The nesting is the composition's own read path, and it matters because the
     * shared double spreads this client over a default whose connection always reads healthy...a holder placed anywhere else is ignored, and the composition reads
     * healthy whatever the arm sets.
     */
    client: {

      connection: {

        get isHealthy(): boolean {

          return health.isHealthy;
        }
      }
    },
    events: {

      emitPacket: (packet: AccessEventPacket): void => { emissions.push(packet); },
      off: (event: string): void => { removals.push(event); },
      on: (event: string): void => { registrations.push(event); }
    },
    id: controllerIdentity({ address: "1.2.3.4", mac: CONTROLLER_ID }),
    mqtt: init.mqtt,
    platform: makePlatformDouble({

      clock,
      featureOptions: engine,
      log: { error: (): void => undefined, info: (message: string, ...parameters: unknown[]): void => { infoLines.push(format(message, ...parameters)); },
        warn: (message: string): void => { warnings.push(message); } }
    }),
    spawnLoop: (_title: string, body: () => Promise<void>): void => { loop = body; }
  });

  return {

    accessory: stood.accessory,
    clock,
    construction,
    controller,
    emissions,
    featureOptions: engine,
    health,
    infoLines,
    get infoWrites(): { characteristic: string; value: unknown }[] {

      return writesOn(stood.accessory, stood.information);
    },
    loop: (): Promise<void> => loop(),
    get otherWrites(): { characteristic: string; value: unknown }[] {

      return stood.other ? writesOn(stood.accessory, stood.other) : [];
    },
    projection: projection as unknown as AccessDeviceProjection,
    registrations,
    removals,
    get statusWrites(): { characteristic: string; value: unknown }[] {

      return writesOn(stood.accessory, stood.carrier);
    },
    warnings
  };
}

// The accessory a device is stood up on, and the services on it an arm reads the device's writes from.
interface DeviceAccessory {

  accessory: TestAccessAccessory;
  // The service carrying StatusActive, which is what the availability sweep writes.
  carrier: Service;
  // The information service HAP gives every accessory at construction, which the device stamps and a rename writes into.
  information: Service;
  // When asked for, a service carrying no availability characteristic, so a sweep can be read for what it left alone as well as for what it wrote.
  other?: Service;
}

/* Stand up the accessory a device is built on: Homebridge's own, so the library's reflection over the first service's constructor finds HAP's information service
 * where Homebridge places it, and every lookup and write the device makes runs through HAP as it does in the field. The name is the accessory's display name and
 * its information service's name at once, as HAP sets them together at construction, because the device reads its current name from that characteristic before it decides
 * whether a record's alias is a change.
 *
 * The carrier's StatusActive is attached here, because the sweep asks the service whether it carries the characteristic before it writes, and HAP attaches one only
 * when it is first asked for. The information service carries no availability characteristic, as the real one carries none, so the sweep passes over it. The
 * accessory records from the moment each service joins it, so what an arm reads is what the device wrote after construction.
 *
 * @param options - name: the accessory's name, "Test Hub" by default; other: whether a service carrying no availability characteristic joins the carrier.
 *
 * @returns The accessory and the services an arm reads writes from.
 */
function makeAccessory({ name = "Test Hub", other = false }: { name?: string; other?: boolean } = {}): DeviceAccessory {

  const accessory = makeTestAccessory(name);
  const information = accessory.getService(Service.AccessoryInformation);
  const carrier = accessory.addService(Service.ContactSensor, name);

  assert.ok(information, "HAP gives every accessory an information service at construction");

  carrier.getCharacteristic(Characteristic.StatusActive);

  return { accessory, carrier, information, other: other ? accessory.addService(Service.Switch, name) : undefined };
}

test("availability composes controller health with the device's own online state", async () => {

  /* Both records read fully online, so what separates the two harnesses is the controller's connection alone. Each arm drives its own harness rather than one flipped
   * mid-script, because the script harness walks a single observe pass per loop call and replays nothing.
   */
  const outage = makeHarness([record()]);

  outage.health.isHealthy = false;

  const unreachable = new TestDevice(outage.controller, outage.projection, outage.accessory, outage.construction);

  await outage.loop();

  assert.equal(unreachable.isOnline, true, "the record's own flags still read online, which is what makes controller health the term under test");
  assert.equal(unreachable.isReachable, false, "a device behind an unhealthy controller cannot be reached, whatever its own record last said");
  assert.deepEqual(outage.statusWrites, [{ characteristic: Characteristic.StatusActive.UUID, value: false }],
    "and the loop projects that composition rather than the record's flags");

  const healthy = makeHarness([record()]);
  const reachable = new TestDevice(healthy.controller, healthy.projection, healthy.accessory, healthy.construction);

  await healthy.loop();

  assert.equal(reachable.isReachable, true, "the same record behind a healthy controller reads reachable");
  assert.deepEqual(healthy.statusWrites, [{ characteristic: Characteristic.StatusActive.UUID, value: true }]);
});

test("a reader wrapped in the device's rule answers while the device can be reached and refuses with the communication-failure status while it cannot, " +
  "consulting the composition on every read", () => {

  /* The rule is driven through the device the base really bound rather than through a wrapper the arm built, which is what makes the bind site itself the thing
   * under test. Each term of the composition is moved on its own, because a reader that consulted only one of them would pass on the other's strength.
   */
  const harness = makeHarness([record()]);
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);
  const read = device.answer(() => true);

  assert.equal(read(), true, "a reader answers under a healthy controller and an online record");

  harness.health.isHealthy = false;

  // The controller term refuses with HAP's own status error carrying the communication-failure status.
  assert.throws(() => read(), { constructor: hap.HapStatusError, hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });

  harness.health.isHealthy = true;

  assert.equal(read(), true, "and the next read after recovery answers, because the rule consults the composition on every read rather than capturing it once");

  device.uda = { ...device.uda, is_online: false };

  // The device's own record gates the read from there, refusing it the same way.
  assert.throws(() => read(), { constructor: hap.HapStatusError, hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
});

test("a reachability refresh writes every service carrying availability and only those, reading the composition afresh each time", () => {

  const harness = makeHarness([], { otherService: true });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.refreshReachability();

  assert.deepEqual(harness.statusWrites, [{ characteristic: Characteristic.StatusActive.UUID, value: true }], "the service reporting the characteristic is written");
  assert.deepEqual(harness.otherWrites, [], "and the one that does not report it is left alone");

  // The push reads the composition at the moment it runs rather than a value captured when the device was built, which is what makes the controller observer's walk
  // worth anything at all. The accessory's record restarts here, so what the second refresh wrote is read on its own.
  harness.accessory.clearObservations();
  harness.health.isHealthy = false;
  device.refreshReachability();

  assert.deepEqual(harness.statusWrites, [{ characteristic: Characteristic.StatusActive.UUID, value: false }]);
  assert.deepEqual(harness.otherWrites, []);
});

test("a reachability refresh states the device's availability on its own topic, retained, and only when the reading moves", () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.refreshReachability();
  device.refreshReachability();

  /* The second refresh leaves reachability where the first put it, so the client's change gate answers it with nothing sent. A refresh runs on every record
   * delivery, and a statement per delivery would repeat to the broker a word it already holds.
   */
  assert.deepEqual(mqtt.published, [{ payload: "online", retain: true, topic: AVAILABILITY_TOPIC }]);

  harness.health.isHealthy = false;
  device.refreshReachability();
  device.refreshReachability();

  assert.deepEqual(mqtt.published.slice(1), [{ payload: "offline", retain: true, topic: AVAILABILITY_TOPIC }], "a move to unreachable is stated once, in the other word");

  harness.health.isHealthy = true;
  device.refreshReachability();

  assert.deepEqual(mqtt.published.slice(2), [{ payload: "online", retain: true, topic: AVAILABILITY_TOPIC }], "and the way back is stated once as well");
});

test("the record loop states availability on the deliveries that move it and on no other", async () => {

  // Each reading arrives twice: the first delivery of each moves reachability, and the one behind it restates it with an unrelated member changed.
  const mqtt = new TestMqttClient();
  const harness = makeHarness([ record(), record({ alias: "Renamed" }), record({ is_online: false }), record({ alias: "Renamed Again", is_online: false }) ],
    { mqtt });

  new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  await harness.loop();

  // HomeKit's availability is written on every delivery, while the broker hears only the deliveries that moved the reading.
  assert.equal(harness.statusWrites.length, 4);
  assert.deepEqual(mqtt.published, [ { payload: "online", retain: true, topic: AVAILABILITY_TOPIC }, { payload: "offline", retain: true, topic: AVAILABILITY_TOPIC } ]);
});

test("removal states offline as the device's last word, past the end of its own lifetime, and a device re-adopted under its identity states online again", async () => {

  const mqtt = new TestMqttClient();
  const harness = makeHarness([], { mqtt });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.refreshReachability();

  /* The removal's statement is held in flight across the abort that ends the device's lifetime, which is where a statement bound to that lifetime is withdrawn:
   * the double admits a held publish again, against the signal it carries, once it is released, as the client races its acknowledgement against that signal.
   */
  const release = mqtt.holdPublishes();

  device.cleanup();
  release();
  await settle();

  assert.deepEqual(mqtt.published, [ { payload: "online", retain: true, topic: AVAILABILITY_TOPIC }, { payload: "offline", retain: true, topic: AVAILABILITY_TOPIC } ],
    "the offline goes out once, retained, and survives the abort it was issued ahead of");

  // Nothing the removed device does afterwards reaches its topics. This refresh would state online over the offline if anything but the ended lifetime stopped it.
  device.refreshReachability();
  await settle();

  assert.equal(mqtt.published.length, 2, "a removed device states nothing further");

  /* A device re-adopted under the same identity states online again. The removal's statement was change-gated, which is what wrote offline into the client's
   * memory of the topic...an ungated one would have left online remembered there, and this statement would have been swallowed as unchanged.
   */
  const readopted = new TestDevice(harness.controller, harness.projection, makeAccessory().accessory, harness.construction);

  readopted.refreshReachability();

  assert.deepEqual(mqtt.published.slice(2), [{ payload: "online", retain: true, topic: AVAILABILITY_TOPIC }]);
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
  assert.equal(harness.statusWrites.length, 1);
  assert.deepEqual(harness.statusWrites[0], { characteristic: Characteristic.StatusActive.UUID, value: true });
});

test("a record that has left the state produces no update, no write, and no refresh", async () => {

  const harness = makeHarness([undefined]);
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);
  const held = device.uda;

  await harness.loop();

  assert.equal(harness.emissions.length, 0, "a departed device must never emit a stale update");
  assert.equal(harness.statusWrites.length, 0);
  assert.equal(device.uda, held, "the held record must be left exactly as construction seeded it");
});

test("a delivered update carrying an offline record drives availability false", async () => {

  // The record rail is what carries connectivity: the newer notification dialect folds its own online field onto this member, so a device going offline reaches the
  // observe loop as an ordinary record update rather than as a signal of its own.
  const harness = makeHarness([record({ is_online: false })]);

  new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  await harness.loop();

  assert.equal(harness.statusWrites.length, 1, "every delivered update must write availability once");
  assert.deepEqual(harness.statusWrites[0], { characteristic: Characteristic.StatusActive.UUID, value: false });
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

test("a device with name synchronization off derives no name to synchronize, whatever its alias reads", () => {

  const harness = makeHarness([], { construction: record({ alias: "Front Door" }) });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  assert.equal(device.synced(), undefined, "a user who did not ask for synchronization has nothing synchronized, however plainly the alias reads");
});

test("a synchronized name is the alias as HomeKit's naming rules leave it", () => {

  const harness = makeHarness([], { construction: record({ alias: "Front Gate \u{1F6AA}" }), options: ["Enable.Device.SyncName"] });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  assert.equal(device.synced(), "Front Gate", "the alias carries a character HomeKit will not take, so what is synchronized is what survives the rules");
});

test("an alias with nothing left under HomeKit's naming rules derives no name to synchronize", () => {

  const harness = makeHarness([], { construction: record({ alias: "..." }), options: ["Enable.Device.SyncName"] });
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  assert.equal(device.synced(), undefined, "the rules empty this alias out, and a write the library would refuse must never be attempted");
});

test("a record whose alias empties out under HomeKit's naming rules is neither written nor reported as a change", async (t) => {

  const harness = makeHarness([record({ alias: "..." })], { construction: record({ alias: "Front Door" }), options: ["Enable.Device.SyncName"] });
  // Every name Homebridge's own display-name setter is handed, so a rename the arm expects to be refused shows up here rather than passing silently.
  const renames = t.mock.method(harness.accessory, "updateDisplayName");
  const device = new TestDevice(harness.controller, harness.projection, harness.accessory, harness.construction);

  device.configure();

  await harness.loop();

  // The tick genuinely moved the held record, which is what makes the assertions below mean something.
  assert.equal(device.uda.alias, "...", "the loop must have written the record the yield carried");

  assert.deepEqual(harness.infoLines.filter(line => line.includes("Detected a name change")), [],
    "a name the rules empty out is not a change, so the loop has nothing to report and cannot report it on every update");
  assert.deepEqual(renames.mock.calls.map((call) => call.arguments[0]), [], "and the accessory is never handed a name HomeKit would refuse");
  assert.deepEqual(harness.infoWrites.filter(write => [ Characteristic.ConfiguredName.UUID, Characteristic.Name.UUID ].includes(write.characteristic)), [],
    "nor does the information service inside the accessory's services carry a name write, because the rename was never attempted");
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
