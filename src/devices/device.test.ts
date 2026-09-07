/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.test.ts: Tests for the per-device observe loop and the debug gate every device composes.
 */
/* eslint-disable camelcase */
import type { AccessDevice as AccessDeviceProjection, AccessEventPacket, AccessStateDevice } from "unifi-access";
import { FeatureOptions, mqttTopic } from "homebridge-plugin-utils";
import { deviceModel, deviceSerial } from "../policy.ts";
import { featureOptionCategories, featureOptions } from "../options.ts";
import { hubRecord, makePlatformDouble } from "../testing.helpers.ts";
import { ACCESS_WEBHOOK_EVENTS } from "../settings.ts";
import { ACCESS_WEBHOOK_EVENT_PREFIX } from "../controller/events.ts";
import type { AccessAccessory } from "../types.ts";
import type { AccessController } from "../controller/controller.ts";
import { AccessDevice } from "./device.ts";
import type { DecoratedSerial } from "../policy.ts";
import { TestClock } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { format } from "node:util";
import test from "node:test";

// The controller every device below belongs to, in the casing a controller's own identity carries.
const CONTROLLER_ID = "112233445566";

// The window the timer arm below arms against. Any value serves: what the arm is about is whether the deadline survives teardown, not how long it was.
const TIMER_DELAY_MS = 10;

/* The base carries no abstract members of its own, so a near-bare subclass is the whole harness the loop needs. The wrappers expose the protected hint configuration
 * and the protected synchronized-name derivation, which is how an arm drives the real option reads, the real deviation log, and the real derivation rather than
 * paths it wrote itself.
 */
class TestDevice extends AccessDevice {

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
  loop: () => Promise<void>;
  projection: AccessDeviceProjection;
  // What the device attached to the bridge and what it later detached, by event name, so a registration and its teardown can be read as a pair.
  registrations: string[];
  removals: string[];
  statusWrites: unknown[];
  warnings: string[];
}

/* Build the harness around one scripted observation. The projection yields once per entry in the script and answers peek() with that entry, so an entry of undefined
 * is a record that left the state between the yield and the read - the removal-grace window.
 *
 * The platform double carries the real feature-option engine, seeded with whatever entries the arm configures, and a warn channel that captures what it is handed.
 * That is what lets the debug arms drive a device's own gate end to end - the composition, the scope resolution, and the channel the line lands on - rather than
 * asserting against a stub that decided the answer for them.
 *
 * @param script - The records the projection yields, in order.
 * @param init   - The device record construction seeds this device from, and the feature-option entries the engine resolves against.
 */
function makeHarness(script: (AccessStateDevice | undefined)[], init: { construction?: AccessStateDevice & { mac: string }; options?: string[] } = {}): Harness {

  const clock = new TestClock();
  const emissions: AccessEventPacket[] = [];
  const registrations: string[] = [];
  const removals: string[] = [];
  const infoLines: string[] = [];
  const statusWrites: unknown[] = [];
  const warnings: string[] = [];
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

  const controller = {

    /* The client the availability composition reads its controller-wide half through. The nesting is the composition's own read path, so a double flattened to a
     * sibling member here would leave the client undefined and throw on every tick of the loop below.
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
    // The composition a device's log prefix reads, answering the device-only form the controller's own composes. The controller's name is a separate member here, so
    // an arm can read a rendered prefix and see for itself that no controller half reached it.
    getDeviceName: (): string => "Test Hub [UA Hub]",
    id: CONTROLLER_ID,
    name: "Test Controller",
    platform: makePlatformDouble({

      api: { hap: { Characteristic: { FirmwareRevision: "FirmwareRevision", Manufacturer: "Manufacturer", Model: "Model", Name: "Name",
        SerialNumber: "SerialNumber", StatusActive: "StatusActive" }, Service: { AccessoryInformation: "AccessoryInformation" } } },
      clock,
      featureOptions: engine,
      log: { error: (): void => undefined, info: (message: string, ...parameters: unknown[]): void => { infoLines.push(format(message, ...parameters)); },
        warn: (message: string): void => { warnings.push(message); } }
    }),
    resolveDeviceModel: (device: AccessStateDevice): string => deviceModel(device),
    signal: new AbortController().signal,
    spawnLoop: (_title: string, body: () => Promise<void>): void => { loop = body; }
  };

  return { clock, construction, controller: controller as unknown as AccessController, emissions, featureOptions: engine, health, infoLines,
    loop: (): Promise<void> => loop(), projection: projection as unknown as AccessDeviceProjection, registrations, removals, statusWrites, warnings };
}

/* An accessory carrying one service that reports the availability characteristic, so the sweep has somewhere to write, and an information service that records
 * what the device stamps on it. The information sink is optional because most arms below have no interest in it, and so is the rename sink, which records every
 * name Homebridge's own display-name setter is handed - the method the library's accessory rename writes through, so a rename an arm expects to be refused shows
 * up here as a recorded name rather than as a silent pass.
 */
function makeAccessory(statusWrites: unknown[], infoWrites: { characteristic: string; value: unknown }[] = [], renames: string[] = []): AccessAccessory {

  const information = {

    getCharacteristic: (): { value: undefined } => ({ value: undefined }),
    updateCharacteristic: (characteristic: string, value: unknown): void => { infoWrites.push({ characteristic, value }); }
  };

  return {

    UUID: "uuid1",
    context: {},
    displayName: "Test Hub",
    getService: (service: string): unknown => (service === "AccessoryInformation") ? information : undefined,
    services: [{

      testCharacteristic: (characteristic: string): boolean => characteristic === "StatusActive",
      updateCharacteristic: (characteristic: string, value: unknown): void => { statusWrites.push({ characteristic, value }); }
    }],
    updateDisplayName: (name: string): void => { renames.push(name); }
  } as unknown as AccessAccessory;
}

/* An accessory carrying one service that reports the availability characteristic and one that does not, so a sweep can be read both for what it wrote and for what it
 * left alone. The single-service fixture above makes the second half true by construction, which is exactly what this one exists to avoid.
 */
function makeMixedAccessory(statusWrites: unknown[], otherWrites: unknown[]): AccessAccessory {

  return {

    UUID: "uuid1",
    context: {},
    displayName: "Test Hub",
    getService: (): undefined => undefined,
    services: [
      {

        testCharacteristic: (characteristic: string): boolean => characteristic === "StatusActive",
        updateCharacteristic: (characteristic: string, value: unknown): void => { statusWrites.push({ characteristic, value }); }
      },
      {

        testCharacteristic: (): boolean => false,
        updateCharacteristic: (characteristic: string, value: unknown): void => { otherWrites.push({ characteristic, value }); }
      }
    ]
  } as unknown as AccessAccessory;
}

test("availability composes controller health with the device's own online state", async () => {

  /* Both records read fully online, so what separates the two harnesses is the controller's connection alone. Each arm drives its own harness rather than one flipped
   * mid-script, because the script harness walks a single observe pass per loop call and replays nothing.
   */
  const outage = makeHarness([record()]);

  outage.health.isHealthy = false;

  const unreachable = new TestDevice(outage.controller, outage.projection, makeAccessory(outage.statusWrites), outage.construction);

  await outage.loop();

  assert.equal(unreachable.isOnline, true, "the record's own flags still read online, which is what makes controller health the term under test");
  assert.equal(unreachable.isReachable, false, "a device behind an unhealthy controller cannot be reached, whatever its own record last said");
  assert.deepEqual(outage.statusWrites, [{ characteristic: "StatusActive", value: false }], "and the loop projects that composition rather than the record's flags");

  const healthy = makeHarness([record()]);
  const reachable = new TestDevice(healthy.controller, healthy.projection, makeAccessory(healthy.statusWrites), healthy.construction);

  await healthy.loop();

  assert.equal(reachable.isReachable, true, "the same record behind a healthy controller reads reachable");
  assert.deepEqual(healthy.statusWrites, [{ characteristic: "StatusActive", value: true }]);
});

test("a reachability refresh writes every service carrying availability and only those, reading the composition afresh each time", () => {

  const harness = makeHarness([]);
  const otherWrites: unknown[] = [];
  const device = new TestDevice(harness.controller, harness.projection, makeMixedAccessory(harness.statusWrites, otherWrites), harness.construction);

  device.refreshReachability();

  assert.deepEqual(harness.statusWrites, [{ characteristic: "StatusActive", value: true }], "the service reporting the characteristic is written");
  assert.deepEqual(otherWrites, [], "and the one that does not report it is left alone");

  // The push reads the composition at the moment it runs rather than a value captured when the device was built, which is what makes the controller observer's walk
  // worth anything at all.
  harness.health.isHealthy = false;
  device.refreshReachability();

  assert.deepEqual(harness.statusWrites.slice(1), [{ characteristic: "StatusActive", value: false }]);
  assert.deepEqual(otherWrites, []);
});

test("a present record yields exactly one update carrying the wire's own packet shape", async () => {

  const harness = makeHarness([record({ alias: "Renamed" })]);
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);

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
  assert.deepEqual(harness.statusWrites[0], { characteristic: "StatusActive", value: true });
});

test("a record that has left the state produces no update, no write, and no refresh", async () => {

  const harness = makeHarness([undefined]);
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);
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

  new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);

  await harness.loop();

  assert.equal(harness.statusWrites.length, 1, "every delivered update must write availability once");
  assert.deepEqual(harness.statusWrites[0], { characteristic: "StatusActive", value: false });
});

test("a timer armed on a device is drained by cleanup and can never arm again afterwards", () => {

  const harness = makeHarness([]);
  const device = new TimerDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);
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
  const device = new TestDevice(owner.controller, owner.projection, makeAccessory(owner.statusWrites), owner.construction);

  device.log.debug("Owner speaks.");

  // The name appears once and the line lands on warn, the channel Homebridge prints whatever its own debug switch is doing. A gate composed inside the prefix rather
  // than around it would still emit this line, but it would compose the name before asking whether anyone wanted the line at all.
  assert.deepEqual(owner.warnings, ["Test Hub [UA Hub]: Owner speaks."]);

  const sibling = makeHarness([], { construction: record({ mac: "aabbccddee02" }), options: entries });
  const quiet = new TestDevice(sibling.controller, sibling.projection, makeAccessory(sibling.statusWrites), sibling.construction);

  quiet.log.debug("Sibling speaks.");

  // A sibling on the same controller is named by no entry here, so turning one device on leaves the rest of them alone.
  assert.deepEqual(sibling.warnings, []);
});

test("a device's log prefix names the device alone, with no half naming the controller it belongs to", () => {

  const harness = makeHarness([]);
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);

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
  const device = new TestDevice(owner.controller, owner.projection, makeAccessory(owner.statusWrites), owner.construction);

  device.log.debug("Owner speaks.");

  assert.deepEqual(owner.warnings, ["Test Hub [UA Hub]: Owner speaks."]);

  const sibling = makeHarness([], { construction: record({ mac: "aabbccddee02" }), options: entries });
  const quiet = new TestDevice(sibling.controller, sibling.projection, makeAccessory(sibling.statusWrites), sibling.construction);

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
  const infoWrites: { characteristic: string; value: unknown }[] = [];
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites, infoWrites), harness.construction);

  device.configureInfo();

  assert.deepEqual(infoWrites.filter(write => write.characteristic === "SerialNumber"), [{ characteristic: "SerialNumber", value: "AABBCCDDEE01" }]);
  assert.equal(device.id, "AABBCCDDEE01");

  await harness.loop();

  // The tick genuinely moved the held record, which is what makes the two assertions below mean something.
  assert.equal(device.uda.mac, "ffeeddccbb02", "the loop must have written the record the yield carried");

  assert.equal(device.id, "AABBCCDDEE01", "the identity is captured once and never re-read from the live record");

  /* The second stamp is the assertion a device information write still reading the live record fails: the identity could be captured correctly while setInfo
   * went on writing whatever the record says now.
   */
  device.configureInfo();

  assert.deepEqual(infoWrites.filter(write => write.characteristic === "SerialNumber"),
    [ { characteristic: "SerialNumber", value: "AABBCCDDEE01" }, { characteristic: "SerialNumber", value: "AABBCCDDEE01" } ]);
});

test("an Enterprise hub port answers the option entries that name it, and its sibling answers none of them", () => {

  /* Two ports of one hub, sharing a MAC address and differing only by their qualifier. One entry names port1 by the identity the plugin addresses it with and
   * nothing names port2, so every read below has to answer for the port it was asked about: a boolean gate reaching the engine with the bare hub serial would
   * answer true for both, and a gate whose scope carried no qualifier while the value reads carried one would leave a per-port option addressable by neither.
   */
  const entries = [ "Enable.Device.SyncName.AABBCCDDEE02-PORT1", "Enable.Hub.LockDelayInterval.AABBCCDDEE02-PORT1.5" ];
  const portOne = makeHarness([], { construction: portRecord("port1"), options: entries });
  const portTwo = makeHarness([], { construction: portRecord("port2"), options: entries });
  const one = new TestDevice(portOne.controller, portOne.projection, makeAccessory(portOne.statusWrites), portOne.construction);
  const two = new TestDevice(portTwo.controller, portTwo.projection, makeAccessory(portTwo.statusWrites), portTwo.construction);

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
  const plainOne = new TestDevice(bareOne.controller, bareOne.projection, makeAccessory(bareOne.statusWrites), bareOne.construction);
  const plainTwo = new TestDevice(bareTwo.controller, bareTwo.projection, makeAccessory(bareTwo.statusWrites), bareTwo.construction);

  plainOne.configure();
  plainTwo.configure();

  assert.equal(plainOne.hasFeature("Device.SyncName"), false);
  assert.equal(plainTwo.hasFeature("Device.SyncName"), false);
  assert.deepEqual(bareOne.infoLines, []);
  assert.deepEqual(bareTwo.infoLines, []);
});

test("one string carries a device's option scope, its MQTT topic tail, and the identity the webUI writes against", () => {

  const harness = makeHarness([], { construction: portRecord("port1"), options: ["Enable.Device.SyncName.AABBCCDDEE02-PORT1"] });
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);

  /* The webUI server decorates its device list by calling this same function on the same record, so what a user writes an entry against in the browser is what
   * the plugin reads it back by. The literal beside it is what proves the spelling rather than agreeing with whatever the composition happens to answer.
   */
  assert.equal(device.id, deviceSerial(harness.construction));
  assert.equal(device.id, "AABBCCDDEE02-PORT1");

  // The broker sees the same string, so a topic reads exactly as the device is addressed everywhere else.
  assert.equal(mqttTopic(device.id, "lock"), "AABBCCDDEE02-PORT1/lock");

  // And the engine resolves that string at the device scope, which is what lets a device entry outrank the controller entry that would otherwise answer for it.
  assert.equal(harness.featureOptions.scope("Device.SyncName", device.id, CONTROLLER_ID), "device");

  // The brand is a compile-time statement: this declaration is what the typecheck fails on if the identity ever widens back into a plain string.
  const serial: DecoratedSerial = device.id;

  assert.equal(serial, "AABBCCDDEE02-PORT1");
});

test("an Enterprise port's identity is captured at adoption and survives a record whose port key moves", async () => {

  /* The observe loop hands this device a record carrying the sibling port's key. No path the controller drives can do that, and it is exactly the drift the
   * capture exists to make impossible: an accessory's identity is frozen by every cache in the field, and a port's qualifier is half of the identity here.
   */
  const harness = makeHarness([portRecord("port2")], { construction: portRecord("port1") });
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);

  assert.equal(device.id, "AABBCCDDEE02-PORT1");

  await harness.loop();

  // The tick genuinely moved the held record, which is what makes the assertion below mean something.
  assert.equal(device.uda.source_id, "port2", "the loop must have written the record the yield carried");
  assert.equal(device.id, "AABBCCDDEE02-PORT1", "the identity is composed once and never re-read from the live record");
});

test("a typed delivery registration lands in the same map that cleanup drains", () => {

  const harness = makeHarness([]);
  const device = new DeliveryDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);

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
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);

  device.configure();

  assert.equal(device.synced(), undefined, "a user who did not ask for synchronization has nothing synchronized, however plainly the alias reads");
});

test("a synchronized name is the alias as HomeKit's naming rules leave it", () => {

  const harness = makeHarness([], { construction: record({ alias: "Front Gate \u{1F6AA}" }), options: ["Enable.Device.SyncName"] });
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);

  device.configure();

  assert.equal(device.synced(), "Front Gate", "the alias carries a character HomeKit will not take, so what is synchronized is what survives the rules");
});

test("an alias with nothing left under HomeKit's naming rules derives no name to synchronize", () => {

  const harness = makeHarness([], { construction: record({ alias: "..." }), options: ["Enable.Device.SyncName"] });
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites), harness.construction);

  device.configure();

  assert.equal(device.synced(), undefined, "the rules empty this alias out, and a write the library would refuse must never be attempted");
});

test("a record whose alias empties out under HomeKit's naming rules is neither written nor reported as a change", async () => {

  const harness = makeHarness([record({ alias: "..." })], { construction: record({ alias: "Front Door" }), options: ["Enable.Device.SyncName"] });
  const renames: string[] = [];
  const device = new TestDevice(harness.controller, harness.projection, makeAccessory(harness.statusWrites, [], renames), harness.construction);

  device.configure();

  await harness.loop();

  // The tick genuinely moved the held record, which is what makes the assertions below mean something.
  assert.equal(device.uda.alias, "...", "the loop must have written the record the yield carried");

  assert.deepEqual(harness.infoLines.filter(line => line.includes("Name change detected")), [],
    "a name the rules empty out is not a change, so the loop has nothing to report and cannot report it on every update");
  assert.deepEqual(renames, [], "and the accessory is never handed a name HomeKit would refuse");
});
