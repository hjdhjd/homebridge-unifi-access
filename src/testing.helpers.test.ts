/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Tests for the shared fixture builders.
 *
 * A builder is code, and a defect in one would corrupt every arm that seeds a document or a record through it without any of them going red for a reason a reader
 * could trace. So each builder is held to what production code is held to: the populated set it answers with, the precedence an override takes over a default, and
 * a distinguishing input per arm that a builder ignoring the option could not coincide with.
 */
/* eslint-disable camelcase */
import { ACCESS_WEBHOOK_PORT, PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { AccessBootstrapConfig, AccessDoorConfig } from "unifi-access";
import { ROOT_ID, buildingTopology, configRows, doorsTopology, hubRecord, makeControllerDouble, makePlatformDouble, readerRecord } from "./testing.helpers.ts";
import { TestClock, TestMqttClient } from "homebridge-plugin-utils/testing";
import type { AccessAccessory } from "./types.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { controllerIdentity } from "./policy.ts";
import test from "node:test";

// The doors a topology document carries, reached the way the library's own door-state derivation reaches them: through the building's single floor.
function doorsOf(topology: AccessBootstrapConfig): AccessDoorConfig[] {

  return topology.floors?.[0]?.doors ?? [];
}

test("buildingTopology places every device it is handed in the building's own device group, under the shared root", () => {

  const devices = [ { unique_id: "device1" }, { unique_id: "device2" } ];
  const topology = buildingTopology(devices);

  // Two devices rather than one: a builder that took only the first, or that gave each device a group of its own, would read differently here.
  assert.deepEqual(topology.device_groups, [devices], "every device belongs to the building's one device group, in the order it was given");

  // A building document that grew a floor would seed doors nothing asked for, and the arms that read this shape are about hardware serving no door at all.
  assert.deepEqual(topology.floors, [], "a building document carries no floors");
  assert.equal(topology.unique_id, ROOT_ID, "the document roots at the shared building identity");
});

test("doorsTopology gives each door its own device group rather than one shared slot", () => {

  const first = [{ unique_id: "device1" }];
  const second = [{ unique_id: "device2" }];

  /* Two doors, with distinct identities and distinct device lists. A single door cannot tell a per-door map from a hardcoded slot: a builder that put every
   * device under the first door, or that gave both doors the same group, passes a one-door arm and fails this one.
   */
  const doors = doorsOf(doorsTopology([ { devices: first, id: "door1" }, { devices: second, id: "door2" } ]));

  assert.deepEqual(doors.map(door => door.unique_id), [ "door1", "door2" ], "each entry becomes its own door, in the order it was given");
  assert.deepEqual(doors[0]?.device_groups, [first], "the first door serves only the hardware handed to it");
  assert.deepEqual(doors[1]?.device_groups, [second], "and the second serves only its own");
});

test("doorsTopology names a door after its identity by default and carries a supplied name into both names a door has", () => {

  const doors = doorsOf(doorsTopology([ { devices: [], id: "door1" }, { devices: [], id: "door2", name: "Side Gate" } ]));

  assert.equal(doors[0]?.name, "Door door1", "a door with no name of its own is named after its identity");
  assert.equal(doors[0]?.full_name, "Door door1", "and its full name reads the same");

  // "Side Gate" is a spelling the default cannot produce, so a builder that ignored the option would read "Door door2" on both members below.
  assert.equal(doors[1]?.name, "Side Gate", "a supplied name is what the door carries");
  assert.equal(doors[1]?.full_name, "Side Gate", "and its full name reads the same");
});

test("configRows yields one row per entry, addressed to the default device under the default tag", () => {

  // The two entries report different readings, so a builder that carried one value onto every row would go red rather than coincide with the expectation.
  assert.deepEqual(configRows({ entries: { "input_state_rel": "on", "input_state_rex": "off" } }), [

    { device_id: "device1", key: "input_state_rel", tag: "input_state", value: "on" },
    { device_id: "device1", key: "input_state_rex", tag: "input_state", value: "off" }
  ], "each entry becomes one whole row, in the order it was given");
});

test("configRows honors a supplied device and tag on every row it yields", () => {

  /* The tag is deliberately something other than the default, so an assertion expecting it can never pass by coinciding with what the builder falls back to, and
   * the device identity is likewise not the one the shared hub record carries.
   */
  assert.deepEqual(configRows({ deviceId: "74acb9d55b9c", entries: { "wiring_state_rel-neg": "on", "wiring_state_rel-pos": "on" }, tag: "wiring" }), [

    { device_id: "74acb9d55b9c", key: "wiring_state_rel-neg", tag: "wiring", value: "on" },
    { device_id: "74acb9d55b9c", key: "wiring_state_rel-pos", tag: "wiring", value: "on" }
  ], "both options reach every row");
});

test("configRows yields nothing at all for an empty set of entries", () => {

  // Deep equality against an empty list rather than a length check: a builder answering a single row of undefined members has a length of one either way.
  assert.deepEqual(configRows({ entries: {} }), [], "a census that mentioned nothing is an empty row list");
});

test("hubRecord with no overrides carries exactly the members every suite that seeds one agrees on", () => {

  /* Whole-object equality rather than a member-by-member read. The point of the default is that it is the smallest set, so a default that carried one member more
   * would silently change what an arm reads in a suite that deliberately left that member out, and only a bounded comparison catches that.
   */
  assert.deepEqual(hubRecord(), { capabilities: ["is_hub"], device_type: "UAH", is_managed: true, mac: "aabbccddee01", name: "Test Hub",
    unique_id: "device1" }, "the shared hub default is the agreed set and nothing besides");
});

test("readerRecord with no overrides carries exactly the members every suite that seeds one agrees on", () => {

  assert.deepEqual(readerRecord(), { capabilities: ["is_reader"], device_type: "UA-G2-PRO", is_managed: true, mac: "aabbccddee02", name: "Test Reader",
    unique_id: "reader1" }, "the shared reader default is the agreed set and nothing besides");

  // Absence stated as precisely as presence: a reader that carried a hub identity by default would hang every suite's readers off a hub none of them named.
  assert.ok(!("connected_uah_id" in readerRecord()), "the hub a reader hangs off is a caller's override rather than a default");
});

test("an override restates a defaulted member's value rather than being buried under the default", () => {

  /* A spelling no default carries. A builder that spread its defaults over the overrides instead of under them would answer "Test Hub" and "Test Reader" here
   * while still carrying the right number of members, so a key count could not tell the two orders apart and a value read can.
   */
  assert.equal(hubRecord({ name: "Plain Hub" }).name, "Plain Hub", "the hub record reads the name it was handed");
  assert.equal(readerRecord({ name: "Side Reader" }).name, "Side Reader", "and the reader record reads its own");
});

test("an override for a member no default carries lands on the record as a new member", () => {

  const hub = hubRecord({ connected_uah_id: "device1" });

  assert.equal(hub.connected_uah_id, "device1", "a member outside the agreed set is added rather than dropped");
  assert.equal(hub.name, "Test Hub", "and the members the default does carry are left where they were");
});

test("every call builds its own document and record, so no two callers share nested state", () => {

  const records = [ hubRecord(), hubRecord() ];
  const topologies = [ buildingTopology([]), buildingTopology([]) ];

  /* Reference inequality, which is what a module-level default spread into every result would fail. Two callers holding one array is the defect that would let an
   * arm mutating its own fixture move a fixture in a file it never reads.
   */
  assert.notEqual(records[0]?.capabilities, records[1]?.capabilities, "two records must not share one capabilities array");
  assert.notEqual(topologies[0]?.device_groups, topologies[1]?.device_groups, "and two documents must not share one device group");
});

test("makePlatformDouble with no options answers every member a suite stands its devices up over", async () => {

  const platform = makePlatformDouble();

  /* The whole defaulted set rather than the members one arm happens to name. A device suite states only what its own question is about and inherits everything
   * else from here, so a default drifting would redden an arm in a suite three files away, for a reason that file gives its reader no sign of.
   */
  assert.deepEqual(platform.accessories, [], "a bare platform has adopted nothing");
  assert.ok(platform.clock instanceof TestClock, "its clock is the virtual one every deadline an arm advances is armed on");
  assert.equal(platform.clock.now(), 0, "seeded at the clock double's own start, so an arm's cadence arithmetic begins at zero");
  assert.deepEqual(platform.config, { controllers: [], options: [] }, "the configuration names no controller and carries no option entry");
  assert.ok(platform.featureOptions instanceof FeatureOptions, "the feature engine is the plugin's own rather than a stub answering a fixed verdict");
  assert.equal(platform.featureOptions.test("Device.SyncName"), false, "and an engine seeded with nothing resolves the catalog default");
  assert.equal(await platform.localAddressFor("any host"), "10.0.0.7", "the local address answers one string whatever host it is asked about");

  /* Each channel is read through a local whose type says nothing about the answer, so what the assertion below compares is the value the default hands back
   * rather than the void the platform's own log type states.
   */
  const channels: ((message: string) => unknown)[] = [ platform.log.error, platform.log.info, platform.log.warn ];

  for(const channel of channels) {

    assert.equal(channel("swallowed"), undefined, "each of the three channels the logging composition reads swallows what it is handed and answers nothing");
  }

  assert.equal(platform.signal.aborted, false, "the plugin's lifetime is live, so nothing an arm stands up is torn down before it runs");
  assert.throws((): void => {

    platform.webhookListener();
  }, { message: "This platform double carries no webhook listener." }, "asking for a webhook listener says there is none rather than answering a silent one");
  assert.equal(platform.webhookPort, ACCESS_WEBHOOK_PORT, "and the webhook port is the plugin's own, whatever that constant is set to");
});

test("every option given to makePlatformDouble reaches the member it names, over the default that member would otherwise carry", async () => {

  const aborted = new AbortController();
  const clock = new TestClock(5);
  const engine = makePlatformDouble().featureOptions;
  const handed = { hap: { marker: "p2" } };
  const held = [{ UUID: "uuid-held" } as unknown as AccessAccessory];
  const lines: string[] = [];
  const listener = (): never => {

    throw new Error("This arm's listener.");
  };

  aborted.abort();

  /* Every value here differs from the default its member would otherwise carry, so a factory that dropped any one option could not coincide with the reading
   * below. The engine and the entries are handed over together because the one rule between them is which of the two wins.
   */
  const platform = makePlatformDouble({ accessories: held, api: handed, clock,
    config: { controllers: [{ address: "5.6.7.8" }], options: ["Enable.Device.SyncName"] }, entries: ["Enable.Device.SyncName"], featureOptions: engine,
    localAddressFor: async (): Promise<string> => "192.0.2.9",
    log: { error: (message: string): void => void lines.push("error " + message), info: (message: string): void => void lines.push("info " + message),
      warn: (message: string): void => void lines.push("warn " + message) },
    signal: aborted.signal, webhookListener: listener, webhookPort: 4242 });

  platform.log.warn("w");

  assert.equal(platform.accessories, held, "the accessory list is the arm's own object rather than a copy, so an entry made here is one the arm can read");
  assert.equal(platform.api, handed, "and the Homebridge api is that arm's object whole, so whatever it hangs a device's reads off reaches that device");
  assert.equal(platform.clock, clock, "the clock is the one the arm holds, which is what lets an advance here reach a deadline armed there");
  assert.equal(platform.clock.now(), 5, "seeded where the arm seeded it");
  assert.deepEqual(platform.config, { controllers: [{ address: "5.6.7.8" }], options: ["Enable.Device.SyncName"] }, "the configuration reads back as it was given");
  assert.equal(platform.featureOptions, engine, "an engine handed over is the engine the platform answers by");
  assert.equal(platform.featureOptions.test("Device.SyncName"), false, "and it outranks the entries beside it, which would have resolved this option true");
  assert.equal(makePlatformDouble({ entries: ["Enable.Device.SyncName"] }).featureOptions.test("Device.SyncName"), true,
    "while entries with no engine beside them reach the engine the factory builds");
  assert.equal(await platform.localAddressFor("any host"), "192.0.2.9", "the local address answers what the arm resolves rather than the default one");
  assert.deepEqual(lines, ["warn w"], "a line said at warning level reaches the arm's recorder, on the channel it was said on");
  assert.equal(platform.signal, aborted.signal, "the lifetime is the arm's own signal");
  assert.equal(platform.signal.aborted, true, "torn down already, which no freshly built default could answer");
  assert.throws((): void => {

    platform.webhookListener();
  }, { message: "This arm's listener." }, "and the webhook listener is the arm's factory rather than the one that says there is none");
  assert.equal(platform.webhookPort, 4242, "the webhook port is the number the arm named");
});

test("the accessory entry and exit of makePlatformDouble reach the api calls and the list the arm holds, in the real platform's own order", () => {

  const a = { UUID: "uuid-a" } as unknown as AccessAccessory;
  const b = { UUID: "uuid-b" } as unknown as AccessAccessory;
  const calls: { platformName: string; pluginName: string; targets: string[]; verb: string }[] = [];
  const held: AccessAccessory[] = [];
  /* What the list held at the moment Homebridge was told about it, rather than what it holds once the call has returned. The real platform announces an arrival
   * after that accessory has entered the list and a departure after it has left, and only a reading taken inside the call tells that order from the reverse one.
   */
  const updates: { count: number; sameList: boolean }[] = [];
  const platform = makePlatformDouble({ accessories: held, api: {

    registerPlatformAccessories: (pluginName: string, platformName: string, targets: AccessAccessory[]): void => {

      calls.push({ platformName, pluginName, targets: targets.map((target: AccessAccessory): string => target.UUID), verb: "register" });
    },
    unregisterPlatformAccessories: (pluginName: string, platformName: string, targets: AccessAccessory[]): void => {

      calls.push({ platformName, pluginName, targets: targets.map((target: AccessAccessory): string => target.UUID), verb: "unregister" });
    },
    updatePlatformAccessories: (accessories?: AccessAccessory[]): void => void updates.push({ count: held.length, sameList: accessories === held })
  } });

  platform.registerAccessory(a);

  assert.deepEqual(calls, [{ platformName: PLATFORM_NAME, pluginName: PLUGIN_NAME, targets: ["uuid-a"], verb: "register" }],
    "an adoption announces exactly the arriving accessory, under the plugin's own names");
  assert.deepEqual(updates.at(-1), { count: 1, sameList: true }, "and the refresh hands back the arm's own list, carrying that accessory already");
  assert.deepEqual(held, [a], "which is the list the arm reads afterward");

  platform.registerAccessory(b);

  assert.deepEqual(updates.at(-1), { count: 2, sameList: true }, "a second adoption refreshes a list carrying both");
  assert.deepEqual(held, [ a, b ], "in the order they arrived");

  platform.unregisterAccessory(a);

  assert.deepEqual(calls.at(-1), { platformName: PLATFORM_NAME, pluginName: PLUGIN_NAME, targets: ["uuid-a"], verb: "unregister" },
    "a retirement names the accessory it was handed rather than the one that arrived last");
  assert.equal(calls.length, 3, "one api call per entry and per exit, and none besides");
  assert.deepEqual(updates.at(-1), { count: 1, sameList: true }, "and the refresh hands back a list that accessory has left");
  assert.deepEqual(held, [b], "so the arm's list holds the one that stayed");

  platform.unregisterAccessory(a);

  assert.equal(calls.length, 3, "retiring an accessory the list does not hold reaches no api call at all");
  assert.equal(updates.length, 3, "and no refresh either, which is what makes a repeated retirement harmless");
  assert.deepEqual(held, [b], "with the list left where it was");

  const bare = makePlatformDouble();

  bare.registerAccessory(a);

  assert.deepEqual(bare.accessories, [a], "a double given no api and no list of its own adopts into the list it built");

  bare.unregisterAccessory(a);

  assert.deepEqual(bare.accessories, [], "and retires from that one, reaching an api it has none of rather than throwing");
});

test("makeControllerDouble with no options answers the members the plugin reads from a token-only controller", async () => {

  const controller = makeControllerDouble();

  /* The default double stands in for a controller reached with an API token alone, which never learns a serial and answers by its configured address repaired
   * into a scope identifier. Reading the derived members rather than the address alone is what proves the factory derives them the way the controller does.
   */
  assert.equal(controller.id, "1-2-3-4", "the default double answers by its configured address in the scope form, as a token-only controller does");
  assert.equal(controller.ownershipKey, "1.2.3.4", "while the key it stamps its accessories with is that same address raw");
  assert.deepEqual(controller.reclaimKeys, { currentKey: "1.2.3.4", priorKey: undefined }, "with no prior key, because it has answered by no other one");
  assert.equal(controller.reclaimClaims(), undefined, "a controller with no live client claims nothing");
  assert.equal(await controller.login(), "reporting", "and it logs in as one that serves its membership");
  assert.equal(controller.name, "Test Controller", "the name every suite's log prefix is composed from");
  assert.equal(controller.mqtt, null, "and there is no broker until an arm hands one over");

  /* The members a device reads on its own paths, which no arm names because every arm inherits them. The model derivation and the loop spawner are read against
   * inputs a default answering one fixed thing could not coincide with.
   */
  assert.equal(controller.signal.aborted, false, "the controller's own lifetime is live");
  assert.equal(controller.client.connection.isHealthy, true, "its client reports a healthy connection, which is half of what a device composes availability from");
  assert.equal(controller.client.doorStates.size, 0, "and it knows no door state until an arm seeds one");
  assert.equal(controller.platform.webhookPort, ACCESS_WEBHOOK_PORT, "the platform underneath is a default double of the plugin's own shape");
  assert.deepEqual(controller.config, { address: "1.2.3.4" }, "and the configuration a device composes its own requests from carries the default address");
  assert.equal(controller.resolveDeviceModel(hubRecord()), "UA Hub", "the model is the plugin's own derivation");
  assert.equal(controller.resolveDeviceModel(readerRecord()), "UA-G2-PRO", "which two records of different hardware prove and one could not");

  let ran = false;

  controller.spawnLoop("a loop", async (): Promise<void> => {

    ran = true;
  });

  assert.equal(ran, false, "a loop handed to the default spawner never runs, so no arm that asked for none has state moved under it");

  /* The device name is the same string whatever record it is handed, which is the point of the default: an Enterprise port resolves to another model entirely
   * through the real derivation, and every arm reading a log prefix expects this one string for the record its device was stood up on.
   */
  assert.equal(controller.getDeviceName(hubRecord({ device_type: "UAH-Ent" })), "Test Hub [UA Hub]", "the device name ignores the record and answers the fixed one");
});

test("an identity and an address given to makeControllerDouble reach the members derived from them", () => {

  const controller = makeControllerDouble({ config: { address: "5.6.7.8" }, id: controllerIdentity({ address: "5.6.7.8", mac: "aa:bb:cc:dd:ee:ff" }) });

  // An address no default carries and an identity beside it, so a factory ignoring either option could not coincide with both readings.
  assert.equal(controller.id, "AABBCCDDEEFF", "a MAC address given to the identity composition wins over the address, as the real controller resolves it");
  assert.equal(controller.ownershipKey, "5.6.7.8", "while the ownership key is the configured address whatever the identity says");
  assert.equal(controller.config.address, "5.6.7.8", "and the configuration it carries is the one handed over rather than a literal it composed");
  assert.equal(controller.reclaimKeys.currentKey, "5.6.7.8", "and the key it answers by now is that address rather than the default one");

  /* The feature test reads the platform double's own engine rather than an answer the factory decided, so one option reads both ways: the catalog default against a
   * bare platform, and the enabled answer against a platform seeded with the entry that enables it.
   */
  assert.equal(controller.hasFeature("Device.SyncName"), false, "a controller over a bare platform answers the catalog default");
  assert.equal(makeControllerDouble({ platform: makePlatformDouble({ entries: ["Enable.Device.SyncName"] }) }).hasFeature("Device.SyncName"), true,
    "and one over a seeded platform answers what that engine resolves");
});

test("a publish through makeControllerDouble reaches the broker it was given and nothing when it has none", () => {

  const mqtt = new TestMqttClient();
  const controller = makeControllerDouble({ mqtt });

  controller.mqttPublish("t", "p");

  assert.deepEqual(mqtt.published, [{ payload: "p", topic: "t" }], "the publish chokepoint hands the broker exactly what it was called with");

  // A double standing up without a broker publishes into nothing rather than throwing, which is what lets every arm that never mentions MQTT build one bare.
  makeControllerDouble().mqttPublish("t", "p");
});
