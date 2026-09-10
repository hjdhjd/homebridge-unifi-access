/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * policy.test.ts: Tests for the Access controller's pure decision logic.
 *
 * The membership and classification fixtures drive the library's real reducer through createStateStore rather than hand-mirroring its fold, so what they assert is the
 * behavior the plugin actually gets rather than a test's idea of it.
 */
/* eslint-disable camelcase */
import { ACCESS_DOORBELL_REASON_CODES, AccessAuthError, AccessClient, createStateStore, selectDoorStates } from "unifi-access";
import { ACCESS_WEBHOOK_EVENTS, ACCESS_WEBHOOK_EVENT_LIST, ACCESS_WEBHOOK_PATH_PREFIX } from "./settings.ts";
import type { AccessDoorStateEntry, AccessEventPacket, AccessOfficialUser, AccessOfficialWebhookEndpoint, AccessStateDevice, AccessStateDoor } from "unifi-access";
import { ROOT_ID, buildingTopology, configRows, doorsTopology, hubRecord, readerRecord } from "./testing.helpers.ts";
import { accessMethodChoices, accessMethodValuesFromConfigRows, accessMethodValuesFromOfficialSettings, accessMethodWriteFollowup, accessMethodWriteVerdict,
  accessMethods, accessoryOwnership, accessoryStranded, canTransition, composeAccessMethodUpdate, composeConnectIdentity, createConnectRetryPolicy,
  createMembershipIdsSelector, describeUnlock, deviceHasCapability, deviceModel, deviceRecord, deviceSerial, discoverDoorLocations, doorGuardChoices, doorServiceChoices,
  doorbellOutcome, doorbellReaderId, doorbellRingAllowed, doorbellTriggerAction, dpsSensorEligible, entPortSuffix, hasDpsEvidence, isManagedRecord,
  isSupportedAccessDevice, lockCommandRule, membershipRecords, officialDeviceModel, orphanedWebhookRegistrations, projectedRecords, reclaimFenceOpen,
  recordByMac, resolveDoorService, resolveWebhookPort, serialForm, unlockAttribution, webhookDeliveryFresh, webhookEndpointPath,
  webhookEndpointUrl, webhookRegistrationPlan, webhookRegistrations, webhookSignatureHeader } from "./policy.ts";
import assert from "node:assert/strict";
import test from "node:test";

/* A record carrying exactly the members every census establishes and nothing else - no configuration rows, no port extensions, no embedded door snapshot, no
 * display model, no address. This is the shape the official API's device inventory projects into, and the fixture every degrade-by-absence arm below reads.
 *
 * The values are the live capture's own: a UA Hub whose official identifier is address-shaped, so the projection restores the address form from it.
 */
function coreRecord(overrides: Record<string, unknown> = {}): AccessStateDevice {

  return {

    alias: "",
    capabilities: ["is_hub"],
    connected_uah_id: "",
    device_type: "UAH",
    is_adopted: true,
    is_connected: true,
    is_managed: true,
    is_online: true,
    location_id: "door1",
    mac: "74:ac:b9:d5:5b:9c",
    name: "UA-HUB-5B9C",
    unique_id: "74acb9d55b9c",
    ...overrides
  };
}

// Drive one refresh through a real store and hand back its resulting state.
function applyTopology(store: ReturnType<typeof createStateStore>, devices: Record<string, unknown>[]): void {

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(devices) });
}

/* The plain UA Hub of the capture corpus, carrying the unprefixed wiring and input key forms, with its door position wiring flipped on. The captured record reads
 * all three of those keys off; a hub whose sensor is actually wired is a real configuration this plugin must classify correctly, so the fixture supplies one.
 */
function plainHubRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {

  return hubRecord({

    capabilities: [ "is_hub", "dps_alarm" ],
    configs: configRows({ entries: { "input_state_dps": "on", "input_state_rly-lock_dry": "off", "wiring_state_dps-neg": "on",
      "wiring_state_dps-pos": "on" } }),
    device_type: "UAH",
    display_model: "UA Hub",
    ...overrides
  });
}

test("the membership selector holds its array reference across non-membership churn", () => {

  const store = createStateStore({});
  const selector = createMembershipIdsSelector();

  applyTopology(store, [hubRecord({})]);

  const first = selector(store.snapshot());

  assert.deepEqual([...first], ["device1"]);

  // A record field with nothing to do with membership advances, which mints a fresh devices map but must not mint a fresh membership array.
  applyTopology(store, [hubRecord({ firmware: "v2.0.0" })]);

  const second = selector(store.snapshot());

  assert.equal(second, first, "record churn must not wake a membership observer");

  // A genuine membership change must mint a new array, or the observer would never wake at all.
  applyTopology(store, [ hubRecord({}), hubRecord({ mac: "aabbccddee02", unique_id: "device2" }) ]);

  const third = selector(store.snapshot());

  assert.notEqual(third, second);
  assert.deepEqual([...third], [ "device1", "device2" ]);
});

test("an is_managed flip changes the membership array in both directions", () => {

  const store = createStateStore({});
  const selector = createMembershipIdsSelector();

  applyTopology(store, [hubRecord({ is_managed: false })]);

  const unmanaged = selector(store.snapshot());

  assert.deepEqual([...unmanaged], []);

  // Adoption: the device becomes managed, so its identity enters membership and the observer must wake.
  applyTopology(store, [hubRecord({ is_managed: true })]);

  const adopted = selector(store.snapshot());

  assert.notEqual(adopted, unmanaged);
  assert.deepEqual([...adopted], ["device1"]);

  // The reverse edge: unadoption takes the identity back out again.
  applyTopology(store, [hubRecord({ is_managed: false })]);

  const unadopted = selector(store.snapshot());

  assert.notEqual(unadopted, adopted);
  assert.deepEqual([...unadopted], []);
});

test("two selector instances keep their own stability over independent stores", () => {

  const storeOne = createStateStore({});
  const storeTwo = createStateStore({});
  const selectorOne = createMembershipIdsSelector();
  const selectorTwo = createMembershipIdsSelector();

  applyTopology(storeOne, [hubRecord({ unique_id: "one" })]);
  applyTopology(storeTwo, [hubRecord({ unique_id: "two" })]);

  const firstOne = selectorOne(storeOne.snapshot());
  const firstTwo = selectorTwo(storeTwo.snapshot());

  // Interleave churn across both stores. A single shared memo slot would be overwritten by the other store's answer and neither would stay stable.
  applyTopology(storeOne, [hubRecord({ firmware: "v2.0.0", unique_id: "one" })]);
  applyTopology(storeTwo, [hubRecord({ firmware: "v2.0.0", unique_id: "two" })]);

  assert.equal(selectorOne(storeOne.snapshot()), firstOne);
  assert.equal(selectorTwo(storeTwo.snapshot()), firstTwo);
  assert.deepEqual([...firstOne], ["one"]);
  assert.deepEqual([...firstTwo], ["two"]);
});

test("a malformed device record reaches classification rather than crashing discovery", () => {

  const store = createStateStore({});
  const selector = createMembershipIdsSelector();

  // One record arrives carrying no capabilities array at all, the other a device type this plugin has never heard of. Both are managed.
  applyTopology(store, [

    { device_type: "UAH", is_managed: true, mac: "aabbccddee01", name: "No Capabilities", unique_id: "malformed" },
    { capabilities: [], device_type: "SOMETHING-NEW", is_managed: true, mac: "aabbccddee02", name: "Unknown Type", unique_id: "unknown" },
    { capabilities: ["is_hub"], device_type: "UAH", is_managed: false, mac: "aabbccddee03", name: "Unmanaged", unique_id: "unmanaged" }
  ]);

  const state = store.snapshot();
  const malformed = state.devices.get("malformed");
  const unknown = state.devices.get("unknown");

  // The library admits both and normalizes the missing array, which is what keeps every capability read below total.
  assert.ok(malformed, "a record with no capabilities array must still be admitted to state");
  assert.deepEqual(malformed.capabilities, []);
  assert.ok(unknown);

  // Membership gates on managedness, not on capability, so both stay in the identity list and reach the classification gate.
  const ids = selector(state);

  assert.deepEqual([...ids], [ "malformed", "unknown" ]);

  // The classification answers false rather than throwing, which is the path that reaches the unsupported-device log instead of crashing.
  assert.equal(isSupportedAccessDevice(malformed), false);
  assert.equal(isSupportedAccessDevice(unknown), false);
});

test("classification follows the capability, not the device type", () => {

  const store = createStateStore({});

  // A device type nothing has ever seen, carrying the hub capability. It must classify as supported, or a classification quietly regressed onto a type list.
  applyTopology(store, [{ capabilities: ["is_hub"], device_type: "SOMETHING-NEW", is_managed: true, mac: "aabbccddee01", name: "New", unique_id: "device1" }]);

  const record = store.snapshot().devices.get("device1");

  assert.ok(record);
  assert.deepEqual([...createMembershipIdsSelector()(store.snapshot())], ["device1"]);
  assert.equal(isSupportedAccessDevice(record), true);
});

test("a reader that drives no door of its own is still hardware this plugin projects", () => {

  const store = createStateStore({});

  /* A managed device carrying the reader capability and not the hub one. No other fixture here constructs a reader without a hub beside it, so this is the only
   * input that tells a classification covering both roles apart from one that answers on the hub alone.
   */
  applyTopology(store, [{ capabilities: ["is_reader"], device_type: "UA-G3-Reader", is_managed: true, mac: "aabbccddee01", name: "Reader", unique_id: "device1" }]);

  const record = store.snapshot().devices.get("device1");

  assert.ok(record);
  assert.equal(isSupportedAccessDevice(record), true);

  // Membership must account for it too, or the classification would be answering about a device discovery never reaches.
  assert.deepEqual([...createMembershipIdsSelector()(store.snapshot())], ["device1"]);
});

test("an Enterprise hub is represented by its ports rather than itself", () => {

  const store = createStateStore({});
  const selector = createMembershipIdsSelector();

  applyTopology(store, [hubRecord({

    device_type: "UAH-Ent",
    display_model: "UA Hub Enterprise",
    extensions: [{

      device_id: "device1",
      extension_name: "port_setting",
      source_id: "port1",
      target_config: [],
      target_name: "Front Door",
      target_type: "door",
      target_value: "door1",
      unique_id: "port-unique-1"
    }],
    location_id: ROOT_ID,
    unique_id: "device1"
  })]);

  const ids = selector(store.snapshot());

  // The building-hosted parent answers through its ports alone, so its own identity must not appear while the port's must.
  assert.ok(!ids.includes("device1"), "the building-hosted Enterprise parent must be excluded from membership");
  assert.ok(ids.includes("port-unique-1"), "each Enterprise port must be a member in its own right");
});

test("the membership statement names exactly the devices this plugin projects, and the record lookup resolves each of them", () => {

  const store = createStateStore({});

  /* Four records, of which exactly two are devices this plugin projects: a building-hosted Enterprise hub, which answers through its one port rather than itself;
   * a plain managed hub carrying its own identity; an unmanaged record; and a managed record the census established no hardware identity for. The last of those
   * is the fixture a membership statement that dropped the hardware-identity half of its narrowing fails, because every consumer downstream composes an identity
   * for whatever the walk yields.
   */
  const enterprise = hubRecord({

    device_type: "UAH-Ent",
    display_model: "UA Hub Enterprise",
    extensions: [{ device_id: "device1", extension_name: "port_setting", source_id: "port1", target_config: [], target_name: "Front Door", target_type: "door",
      target_value: "door1", unique_id: "port-unique-1" }],
    location_id: ROOT_ID,
    unique_id: "device1"
  });
  const plainHub = hubRecord({ mac: "aabbccddee02", unique_id: "device2" });
  const unmanaged = { capabilities: ["is_hub"], device_type: "UAH", is_managed: false, mac: "aabbccddee03", name: "Unmanaged", unique_id: "unmanaged" };
  const unaddressed = { capabilities: ["is_hub"], device_type: "UAH", is_managed: true, name: "Unaddressed Hub", unique_id: "device3" };

  applyTopology(store, [ enterprise, plainHub, unmanaged, unaddressed ]);

  // The plain records first and the Enterprise ports after them, which is the order the walk reaches them in.
  assert.deepEqual([...membershipRecords(store.snapshot())].map(device => device.unique_id), [ "device2", "port-unique-1" ]);

  const plain = deviceRecord("device2", store.snapshot());
  const port = deviceRecord("port-unique-1", store.snapshot());

  assert.ok(plain, "a plain member must resolve to the record the devices map holds");
  assert.equal(plain.unique_id, "device2");

  // The port's record lives in the expansion rather than in the devices map, which is the half a lookup reading the map alone answers nothing for. It carries its
  // hub's MAC address and its own port key, which is exactly what makes the two halves of its identity.
  assert.ok(port, "a port must resolve to the record the expansion synthesizes");
  assert.equal(port.source_id, "port1");
  assert.equal(port.mac, "AABBCCDDEE01");
  assert.equal(deviceRecord("nothing-here", store.snapshot()), undefined, "an identity the state holds nothing under must resolve to nothing");

  // The library memoizes the expansion against the hub record it was built from, so churn on an unrelated record hands back the identical port object and the
  // status feed's per-device observation stays asleep through it.
  applyTopology(store, [ enterprise, hubRecord({ firmware: "v2.0.0", mac: "aabbccddee02", unique_id: "device2" }), unmanaged, unaddressed ]);

  assert.equal(deviceRecord("port-unique-1", store.snapshot()), port, "a port's record must survive churn that leaves its own hub's record untouched");

  // A change to the hub's own record mints its ports afresh, which is what wakes an observer that has something new to read.
  applyTopology(store, [ { ...enterprise, name: "Renamed Enterprise Hub" }, plainHub, unmanaged, unaddressed ]);

  assert.notEqual(deviceRecord("port-unique-1", store.snapshot()), port, "a change to the hub's own record must mint its ports afresh");
});

test("entPortSuffix identifies an Enterprise port and nothing else", () => {

  assert.equal(entPortSuffix({ device_type: "UAH-Ent", source_id: "port1" } as AccessStateDevice), "-PORT1");

  // A non-Enterprise record carrying a source_id must answer nothing, which is the arm a formula missing its device-type gate fails.
  assert.equal(entPortSuffix({ device_type: "UAH", source_id: "port1" } as AccessStateDevice), "");
  assert.equal(entPortSuffix({ device_type: "UAH-Ent" } as AccessStateDevice), "");
});

test("officialDeviceModel names every hub type the feature options scope on", () => {

  // These four are the display models the catalog's own model scoping compares against, so a wrong answer here would change which options a user is offered.
  assert.equal(officialDeviceModel("UAH"), "UA Hub");
  assert.equal(officialDeviceModel("UA-ULTRA"), "UA Ultra");
  assert.equal(officialDeviceModel("UA-Hub-Door-Mini"), "UA Hub Door Mini");
  assert.equal(officialDeviceModel("UGT"), "UA Gate");
});

test("officialDeviceModel answers an unmapped type with the type itself", () => {

  /* The fallback is the model designation the hardware is sold under, which is a thing a user recognizes. Readers are the everyday case - their roles classify by
   * capability rather than by model name, so they need no entry - and a device released after the map was written reads the same honest way.
   */
  assert.equal(officialDeviceModel("UA-G2-PRO"), "UA-G2-PRO");
  assert.equal(officialDeviceModel("UA-G3-Reader"), "UA-G3-Reader");
  assert.equal(officialDeviceModel("UAH-Ent"), "UAH-Ent");
  assert.equal(officialDeviceModel(""), "", "an empty type answers empty rather than inventing a placeholder");
});

test("the connect retry policy budgets authentication faults and forgives everything else", () => {

  const { shouldRetry } = createConnectRetryPolicy(3);

  assert.equal(shouldRetry(new AccessAuthError("Bad credentials.")), true);
  assert.equal(shouldRetry(new AccessAuthError("Bad credentials.")), true);
  assert.equal(shouldRetry(new AccessAuthError("Bad credentials.")), false, "the auth budget must be exhausted at the limit");

  // A non-auth fault resets the budget, so a controller that is merely slow to appear is retried without bound.
  const policy = createConnectRetryPolicy(2);

  assert.equal(policy.shouldRetry(new AccessAuthError("Bad credentials.")), true);
  assert.equal(policy.shouldRetry(new Error("Network unreachable.")), true);
  assert.equal(policy.shouldRetry(new AccessAuthError("Bad credentials.")), true, "a non-auth fault must reset the consecutive auth count");
});

test("canTransition refuses same-phase and terminal moves while permitting every legitimate one", () => {

  assert.equal(canTransition({ from: "running", to: "running" }), false);
  assert.equal(canTransition({ from: "shuttingDown", to: "running" }), false);
  assert.equal(canTransition({ from: "shuttingDown", to: "connecting" }), false);

  // Every legal move answers true, so a predicate stubbed to refuse everything fails here rather than passing quietly.
  assert.equal(canTransition({ from: "connecting", to: "running" }), true);
  assert.equal(canTransition({ from: "connecting", to: "shuttingDown" }), true);
  assert.equal(canTransition({ from: "running", to: "shuttingDown" }), true);
});

test("a wired plain hub answers the position gate from wiring facts, whatever its display model says", () => {

  /* The three display models a plain hub can present: the English string an allowlist would match, a localized one it never would, and none at all. The derived
   * facts and the gate's verdict have to be identical across all three, which is what makes eligibility a reading of the wire rather than of a label.
   */
  const readings = [ "UA Hub", "Concentrateur UA", undefined ].map(displayModel => {

    const store = createStateStore({});

    store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [plainHubRecord({ display_model: displayModel })], id: "door1" }]) });

    const entry = selectDoorStates(store.snapshot()).get("door1");

    return { dps: entry?.dps, lock: entry?.lock, verdict: hasDpsEvidence(entry) };
  });

  // The wiring pair reads live and the input reads closed, so the hub's own record establishes a wired, closed door before any notification arrives.
  assert.deepEqual(readings[0], { dps: "close", lock: "locked", verdict: true });

  // Identical rather than merely all-true: a derivation that consulted the display string at all would move something between these.
  assert.deepEqual(readings[1], readings[0], "a localized display model must derive the same facts");
  assert.deepEqual(readings[2], readings[0], "an absent display model must derive the same facts");
});

test("a plain hub whose position wiring reads off answers the gate false through a positive unwired report", () => {

  const store = createStateStore({});
  const record = plainHubRecord({ configs: configRows({ entries: { "input_state_dps": "on", "input_state_rly-lock_dry": "off",
    "wiring_state_dps-neg": "off", "wiring_state_dps-pos": "off" } }) });

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [record], id: "door1" }]) });

  const entry = selectDoorStates(store.snapshot()).get("door1");

  // The controller is positively reporting an unwired sensor, which is a different answer from having established nothing, and the input reading is not consulted.
  assert.equal(entry?.dps, "none");
  assert.equal(hasDpsEvidence(entry), false);
});

test("hardware that establishes no position at all answers the gate false", () => {

  const store = createStateStore({});
  // The Ultra carries the single-door key forms and no wiring pair whatsoever, so what its record establishes about the door is the lock and nothing else.
  const record = hubRecord({ configs: configRows({ entries: { "input_d1_dps": "on", "output_d1_lock_relay": "off" } }), device_type: "UA-ULTRA",
    display_model: "UA Ultra" });

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [record], id: "door1" }]) });

  const entry = selectDoorStates(store.snapshot()).get("door1");

  assert.equal(entry?.dps, undefined, "an unreadable wiring pair must establish no position at all");
  assert.equal(entry?.lock, "locked", "the lock half stands on its own evidence");
  assert.equal(hasDpsEvidence(entry), false);

  // The literal absence the signature admits: hardware that drives no door of its own reaches the predicate with nothing whatsoever.
  assert.equal(hasDpsEvidence(undefined), false);
});

test("a Door Mini's position flows from its topology seed and is corrected by a door-state notification", () => {

  const store = createStateStore({});
  /* The Door Mini of the capture corpus: the port-infixed key forms, its position wiring live throughout, and no duplicated door extras of its own. Its
   * capabilities carry the trigger-level flag rather than the alarm one, which is what keeps this arm a genuinely different hardware family from the hub above.
   */
  const record = hubRecord({

    capabilities: [ "is_hub", "dps_trigger_level" ],
    configs: configRows({ entries: { "input_d1_dps": "on", "output_d1_lock_relay": "off", "wiring_state_d1-dps-neg": "on",
      "wiring_state_d1-dps-pos": "on" } }),
    device_type: "UA-Hub-Door-Mini",
    display_model: "UA Hub Door Mini"
  });

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [record], id: "door1" }]) });
  assert.equal(selectDoorStates(store.snapshot()).get("door1")?.dps, "close", "the topology seed must establish the door before any notification arrives");

  // The captured location-update shape. Its envelope identifier is a per-notification value, so the door it speaks for is named in the metadata instead.
  const packet = {

    data: {

      id: "door1",
      location_type: "door",
      name: "Front Door",
      state: { dps: "open", dps_connected: true, emergency: { hardware: "none", software: "none" }, is_unavailable: false, lock: "unlocked" }
    },
    event: "access.data.v2.location.update",
    event_object_id: "3fe74bff-0d70-45f1-84ed-f183a3f9ff93",
    meta: { all_field: true, id: "door1", object_type: "location", source: "", target_field: null },
    receiver_id: "",
    save_to_history: false
  } as unknown as AccessEventPacket;

  const event = AccessClient.classifyPacket(packet);

  assert.ok(event, "the captured shape must classify as something the library models");
  assert.equal(event.kind, "doorStateChanged", "a door-state carrier must not degrade to a plain location update");

  store.dispatch(event);

  const flipped = selectDoorStates(store.snapshot()).get("door1");

  assert.equal(flipped?.dps, "open", "the notification must correct the seeded position");

  // The lock comes from the same report. Nothing else carries a single-door hub's lock state, so a report that dropped it would strand the lock projection entirely.
  assert.equal(flipped?.lock, "unlocked");
});

test("lockCommandRule maps every configured interval onto the verb that expresses it", () => {

  // A door left on the default has no rule governing it, so there is nothing a relock could act on and the command is refused outright.
  assert.deepEqual(lockCommandRule({ delayInterval: undefined, isLocking: true }), { kind: "refuse" });

  // The same door unlocking is the plain momentary unlock, which relocks on the door's own default rather than on any rule of ours.
  assert.deepEqual(lockCommandRule({ delayInterval: undefined, isLocking: false }), { kind: "unlock" });

  // Locking under a configured interval puts the door back on its own schedule, whatever the interval happens to be.
  assert.deepEqual(lockCommandRule({ delayInterval: 0, isLocking: true }), { kind: "rule", rule: { type: "reset" } });
  assert.deepEqual(lockCommandRule({ delayInterval: 15, isLocking: true }), { kind: "rule", rule: { type: "reset" } });

  // Zero is an unlock the user wants no end to.
  assert.deepEqual(lockCommandRule({ delayInterval: 0, isLocking: false }), { kind: "rule", rule: { type: "keep_unlock" } });

  /* A positive interval holds the door for exactly that many minutes. This is the one assertion that distinguishes the custom rule from the endless one by value:
   * a mapping that answered keep_unlock regardless of the interval would satisfy every other arm above and only fail here.
   */
  assert.deepEqual(lockCommandRule({ delayInterval: 1, isLocking: false }), { kind: "rule", rule: { interval: 1, type: "custom" } });
  assert.deepEqual(lockCommandRule({ delayInterval: 15, isLocking: false }), { kind: "rule", rule: { interval: 15, type: "custom" } });
});

test("composeConnectIdentity accepts every whole identity and names every missing half", () => {

  assert.deepEqual(composeConnectIdentity({ password: "p", username: "u" }), { identity: { password: "p", username: "u" } });
  assert.deepEqual(composeConnectIdentity({ password: "p", tokens: { access: "t" }, username: "u" }), { identity: { password: "p", token: "t", username: "u" } });
  assert.deepEqual(composeConnectIdentity({ tokens: { access: "t" } }), { identity: { token: "t" } });

  assert.equal(composeConnectIdentity({ username: "u" }).error, "A username has been configured without a password.");
  assert.equal(composeConnectIdentity({ password: "p" }).error, "A password has been configured without a username.");
  assert.equal(composeConnectIdentity({}).error, "No UniFi Access login credentials or API token have been configured.");

  // A tokens object carrying nothing describes no token, exactly as an absent one does. A hand-edited configuration can produce either, and the two must never
  // answer differently...the browser's own identity predicate follows this same rule.
  assert.equal(composeConnectIdentity({ tokens: {} }).error, "No UniFi Access login credentials or API token have been configured.");
  assert.deepEqual(composeConnectIdentity({ password: "p", tokens: {}, username: "u" }), { identity: { password: "p", username: "u" } });
});

test("the access method translations read each vocabulary through the catalog's own keys", () => {

  // The catalog as both translations take it: the key each method is held under, and the official keys its own surface names it by, primary first.
  const methods = [ { key: "pin_code", officialKeys: ["pin_code"] }, { key: "apple_pass", officialKeys: ["touch_pass"] },
    { key: "nfc", officialKeys: ["nfc"] } ] as const;

  /* The configuration rows state their own yes or no. A method the rows never mention contributes no entry at all rather than a false, because a census that did not
   * list the method has said nothing about it, and a row naming something outside the catalog is not the catalog's business.
   */
  const rows = [ { key: "pin_code", value: "yes" }, { key: "apple_pass", value: "no" }, { key: "input_door_dps", value: "on" } ];

  assert.deepEqual([...accessMethodValuesFromConfigRows({ methods, rows })], [ [ "pin_code", true ], [ "apple_pass", false ] ]);

  /* The official settings are read through each method's primary official key and keyed back under the catalog's own: TouchPass answers as touch_pass and is held as
   * apple_pass, which is the one method whose two surfaces disagree on its spelling. The map is sparse, so a method it omits contributes no entry, and the value
   * comes off the per-method object rather than the member itself.
   */
  const settings = { pin_code: { enabled: "no", pin_code_shuffle: "no" }, touch_pass: { enabled: "yes" } } as const;

  assert.deepEqual([...accessMethodValuesFromOfficialSettings({ methods, settings })], [ [ "pin_code", false ], [ "apple_pass", true ] ]);
});

test("composeAccessMethodUpdate carries the desired state onto every named key", () => {

  // A single-key method composes exactly one member under access_methods, in the wire's own vocabulary.
  assert.deepEqual(composeAccessMethodUpdate({ enabled: true, keys: ["touch_pass"] }), { access_methods: { touch_pass: { enabled: "yes" } } });

  // A multi-key method carries the same value onto each of its keys, and the off direction spells "no" rather than dropping the member.
  assert.deepEqual(composeAccessMethodUpdate({ enabled: false, keys: [ "bt_button", "bt_tap" ] }),
    { access_methods: { bt_button: { enabled: "no" }, bt_tap: { enabled: "no" } } });
});

test("accessMethodWriteVerdict judges the primary key alone and reads absence as a verdict of its own", () => {

  // The primary key agreeing confirms the write even when a secondary key the write also carried disagrees in the read-back...the secondaries are best-effort
  // riders, and aggregating them would turn a hardware class that lacks one into a permanent decline.
  assert.equal(accessMethodWriteVerdict({ enabled: "yes", primaryKey: "bt_button", readBack: { bt_button: { enabled: "yes" }, bt_tap: { enabled: "no" } } }),
    "confirmed");

  // A present primary key disagreeing with the written value means the controller answered success while refusing the change.
  assert.equal(accessMethodWriteVerdict({ enabled: "yes", primaryKey: "face", readBack: { face: { enabled: "no" } } }), "declined");

  // A sparse read-back carrying other methods but not the primary key means the official surface cannot see this method on this device...a verdict that has to
  // come from the primary key's own absence rather than from the map being empty.
  assert.equal(accessMethodWriteVerdict({ enabled: "yes", primaryKey: "bt_button", readBack: { nfc: { enabled: "yes" } } }), "absent");

  // A hardware class offering no methods at all answers with an empty map, which reads absent too.
  assert.equal(accessMethodWriteVerdict({ enabled: "no", primaryKey: "pin_code", readBack: {} }), "absent");
});

test("accessMethodWriteFollowup routes every verdict onto the action that serves it", () => {

  assert.equal(accessMethodWriteFollowup({ transport: true, verdict: "confirmed" }), "complete");

  // A decline is final in both transport directions: the controller answered and refused, so the raw endpoint must never be asked to second-guess it.
  assert.equal(accessMethodWriteFollowup({ transport: true, verdict: "declined" }), "decline");
  assert.equal(accessMethodWriteFollowup({ transport: false, verdict: "declined" }), "decline");

  // Absence and a thrown failure both fall back where a transport can carry the raw write, and revert the switch where none can.
  assert.equal(accessMethodWriteFollowup({ transport: true, verdict: "absent" }), "fallback");
  assert.equal(accessMethodWriteFollowup({ transport: false, verdict: "absent" }), "revert");
  assert.equal(accessMethodWriteFollowup({ transport: true, verdict: "failed" }), "fallback");
  assert.equal(accessMethodWriteFollowup({ transport: false, verdict: "failed" }), "revert");
});

test("doorbellTriggerAction rings and cancels only through an official path and never repeats what is already true", () => {

  // Without an official path a disagreeing write is unavailable in both directions, so the caller can say why rather than silently ignoring the ask...and asserting
  // both directions is what keeps a decision reading the value alone from passing.
  assert.equal(doorbellTriggerAction({ officialAvailable: false, ringing: false, value: true }), "unavailable");
  assert.equal(doorbellTriggerAction({ officialAvailable: false, ringing: true, value: false }), "unavailable");

  // Without an official path an agreeing write is a quiet no-op, again in both directions.
  assert.equal(doorbellTriggerAction({ officialAvailable: false, ringing: false, value: false }), "none");
  assert.equal(doorbellTriggerAction({ officialAvailable: false, ringing: true, value: true }), "none");

  // The manual direction: on while quiet rings, and off while ringing cancels.
  assert.equal(doorbellTriggerAction({ officialAvailable: true, ringing: false, value: true }), "ring");
  assert.equal(doorbellTriggerAction({ officialAvailable: true, ringing: true, value: false }), "cancel");

  /* A write agreeing with the mirror asks for what is already true. The off-while-quiet arm is deliberate design rather than an oversight: a flip-off issued
   * inside the ring round trip reads the still-off mirror and sends nothing, the ring event then flips the switch on, and a second flip-off cancels normally.
   */
  assert.equal(doorbellTriggerAction({ officialAvailable: true, ringing: true, value: true }), "none");
  assert.equal(doorbellTriggerAction({ officialAvailable: true, ringing: false, value: false }), "none");
});

test("doorbellRingAllowed passes everything an empty filter or an unclassifiable ring offers and drops only a disjoint match", () => {

  // An empty filter means no filtering, whatever the ring carries.
  assert.equal(doorbellRingAllowed({ filter: [], guardIds: [] }), true);
  assert.equal(doorbellRingAllowed({ filter: [], guardIds: ["guard1"] }), true);

  // An intersecting pair passes; a disjoint pair is the one shape a configured filter drops.
  assert.equal(doorbellRingAllowed({ filter: [ "guard1", "guard2" ], guardIds: [ "guard2", "guard3" ] }), true);
  assert.equal(doorbellRingAllowed({ filter: ["guard1"], guardIds: ["guard3"] }), false);

  // The fail-open contract: a ring carrying no guard ids at all is unclassifiable, and a filter must never silence it.
  assert.equal(doorbellRingAllowed({ filter: ["guard1"], guardIds: [] }), true);
});

test("doorbellReaderId resolves a hub to the reader carrying its call surface and answers nothing where none is attached", () => {

  const store = createStateStore({});

  // The rig's own topology: a ringable reader and a plain one hanging off the same hub. Only the one carrying the ring rail's capability may answer.
  applyTopology(store, [ hubRecord({ connected_uah_id: "" }),
    readerRecord({ capabilities: [ "is_reader", "remote_view", "remote_call" ], connected_uah_id: "device1" }),
    readerRecord({ connected_uah_id: "device1", mac: "aabbccddee03", unique_id: "reader2" }) ]);

  assert.equal(doorbellReaderId({ devices: store.snapshot().devices.values(), hubId: "device1" }), "reader1");

  // A hub whose only linked reader carries no ring capability has nothing to ring, and saying so is what keeps the resolution from handing back a reader the
  // controller would refuse.
  applyTopology(store, [ hubRecord({ connected_uah_id: "" }), readerRecord({ connected_uah_id: "device1" }) ]);

  assert.equal(doorbellReaderId({ devices: store.snapshot().devices.values(), hubId: "device1" }), null);

  // A ringable reader hanging off some other hub answers to that hub's trigger, never to this one.
  applyTopology(store, [ hubRecord({ connected_uah_id: "" }), readerRecord({ capabilities: [ "is_reader", "remote_view" ], connected_uah_id: "device9" }) ]);

  assert.equal(doorbellReaderId({ devices: store.snapshot().devices.values(), hubId: "device1" }), null);

  // Nothing to search resolves to nothing, rather than to whatever a walk defaulting the other way would have volunteered.
  assert.equal(doorbellReaderId({ devices: [], hubId: "device1" }), null);

  // Two ringable readers on one hub is hardware nobody has observed; the resolution still answers the same id every time, taking the first the topology offers.
  applyTopology(store, [ hubRecord({ connected_uah_id: "" }), readerRecord({ capabilities: [ "is_reader", "remote_view" ], connected_uah_id: "device1" }),
    readerRecord({ capabilities: [ "is_reader", "remote_view" ], connected_uah_id: "device1", mac: "aabbccddee03", unique_id: "reader2" }) ]);

  assert.equal(doorbellReaderId({ devices: store.snapshot().devices.values(), hubId: "device1" }), "reader1");
});

test("serialForm lands every identity spelling on the decorated convention", () => {

  // The topology document's colon-bearing lowercase MAC and the official API's colon-free lowercase id both land on the one spelling the runtime keys on.
  assert.equal(serialForm("aa:bb:cc:dd:ee:ff"), "AABBCCDDEEFF");
  assert.equal(serialForm("aabbccddeeff"), "AABBCCDDEEFF");

  // An already-normalized identity passes through unchanged, and the empty string answers itself rather than inventing anything.
  assert.equal(serialForm("AABBCCDDEEFF"), "AABBCCDDEEFF");
  assert.equal(serialForm(""), "");

  // The composed device form: the record's normalized identity with the Enterprise port suffix where one applies - the exact spelling the webUI server decorates
  // its device lists with.
  assert.equal(deviceSerial({ device_type: "UAH-Ent", mac: "aa:bb:cc:dd:ee:ff", source_id: "port1" } as AccessStateDevice & { mac: string }), "AABBCCDDEEFF-PORT1");
  assert.equal(deviceSerial({ device_type: "UAH", mac: "aa:bb:cc:dd:ee:ff" } as AccessStateDevice & { mac: string }), "AABBCCDDEEFF");
});

test("projectedRecords narrows membership to what this plugin can project", () => {

  const store = createStateStore({});

  // A plain hub, a building-hosted Enterprise hub whose single port the expansion synthesizes, a managed record carrying a device type this plugin cannot project,
  // and a managed record with no hardware identity. Membership yields the first three less the Enterprise parent; projection drops the one it cannot project.
  applyTopology(store, [

    { alias: "", capabilities: ["is_hub"], device_type: "UAH", is_managed: true, mac: "aabbccddee01", name: "Plain Hub", unique_id: "plain" },
    {

      alias: "",
      capabilities: ["is_hub"],
      device_type: "UAH-Ent",
      extensions: [{ device_id: "ent", extension_name: "port_setting", source_id: "port1", target_config: [], target_name: "Front Door", target_type: "door",
        target_value: "door1", unique_id: "entPort1" }],
      is_managed: true,
      location_id: ROOT_ID,
      mac: "aabbccddee02",
      name: "Enterprise Hub",
      unique_id: "ent"
    },
    { alias: "", capabilities: [], device_type: "SOMETHING-NEW", is_managed: true, mac: "aabbccddee03", name: "Unsupported", unique_id: "unsupported" },
    { alias: "", capabilities: ["is_hub"], device_type: "UAH", is_managed: true, name: "Unaddressed", unique_id: "unaddressed" }
  ]);

  const state = store.snapshot();

  assert.deepEqual([...membershipRecords(state)].map(device => device.unique_id), [ "plain", "unsupported", "entPort1" ]);
  assert.deepEqual([...projectedRecords(state)].map(device => device.unique_id), [ "plain", "entPort1" ], "the record this plugin cannot project is not projected");
});

test("recordByMac resolves a record from any spelling of its address and matches nothing that has none", () => {

  // The record with no hardware identity is listed first deliberately: the walk returns on its first match, so a mac-less record placed after the matching one
  // is never visited and a dropped guard would go unexercised.
  const unaddressed = { device_type: "UAH", unique_id: "device0" } as AccessStateDevice;
  const stored = { device_type: "UAH", mac: "AABBCCDDEE01", unique_id: "device1" } as AccessStateDevice;
  const other = { device_type: "UAH", mac: "AABBCCDDEE02", unique_id: "device2" } as AccessStateDevice;
  const records = [ unaddressed, stored, other ];

  assert.equal(recordByMac("aa:bb:cc:dd:ee:01", records), stored, "the colon-bearing lowercase spelling a cached context carries names the stored record");
  assert.equal(recordByMac("AA:BB:CC:DD:EE:01", records), stored);
  assert.equal(recordByMac("AABBCCDDEE01", records), stored);
  assert.equal(recordByMac("aabbccddee02", records), other, "the first record naming the hardware answers, not merely the first record");
  assert.equal(recordByMac("aa:bb:cc:dd:ee:99", records), undefined);
  assert.equal(recordByMac("aa:bb:cc:dd:ee:01", []), undefined);
});

// A minimal topology door for the discovery heuristic, which reads a door's identity and name and nothing else.
function stateDoor(uniqueId: string, name: string): AccessStateDoor {

  return { name, unique_id: uniqueId } as unknown as AccessStateDoor;
}

test("discoverDoorLocations resolves the main door through each strategy in order", () => {

  const doors = [ stateDoor("door1", "Utility"), stateDoor("door2", "Main Entrance") ];

  // Strategy 1: a bound door wins outright, whatever the names say.
  assert.deepEqual(discoverDoorLocations({ device: { door: { unique_id: "door9" } } as unknown as AccessStateDevice, doors, sideDoorEligible: false }),
    { mainDoorLocationId: "door9" });

  // Strategy 2: an unbound device resolves the door whose name reads as the main entrance.
  assert.deepEqual(discoverDoorLocations({ device: {} as AccessStateDevice, doors, sideDoorEligible: false }), { mainDoorLocationId: "door2" });

  // Strategy 3: with no name matching either way, the first door answers.
  assert.deepEqual(discoverDoorLocations({ device: {} as AccessStateDevice, doors: [ stateDoor("door1", "Alpha"), stateDoor("door2", "Beta") ],
    sideDoorEligible: false }), { mainDoorLocationId: "door1" });
});

test("discoverDoorLocations resolves the side door through each strategy in order", () => {

  // Strategy 1: the oper2 port-setting extension names the side door directly.
  const extended = {

    door: { unique_id: "door1" },
    extensions: [{ extension_name: "port_setting", target_name: "oper2", target_value: "door7" }]
  } as unknown as AccessStateDevice;

  assert.deepEqual(discoverDoorLocations({ device: extended, doors: [stateDoor("door1", "Gate")], sideDoorEligible: true }),
    { mainDoorLocationId: "door1", sideDoorLocationId: "door7" });

  // Strategy 2: without the extension, a door whose name reads as the side answers - and never the main door itself.
  assert.deepEqual(discoverDoorLocations({ device: {} as AccessStateDevice, doors: [ stateDoor("door1", "Main Gate"), stateDoor("door2", "Pedestrian Gate") ],
    sideDoorEligible: true }), { mainDoorLocationId: "door1", sideDoorLocationId: "door2" });

  // Strategy 3: with exactly two doors and no side name, the door that is not the main one answers.
  assert.deepEqual(discoverDoorLocations({ device: {} as AccessStateDevice, doors: [ stateDoor("door1", "Alpha"), stateDoor("door2", "Beta") ],
    sideDoorEligible: true }), { mainDoorLocationId: "door1", sideDoorLocationId: "door2" });
});

test("discoverDoorLocations computes a side door only where one is in scope", () => {

  /* The fixture deliberately contains a door that genuinely qualifies as the side door, so an extraction that never computes a side door at all and a correct
   * gate cannot pass the same pair: eligible answers the side door, ineligible answers none, and only a real gate satisfies both.
   */
  const doors = [ stateDoor("door1", "Main Gate"), stateDoor("door2", "Pedestrian Gate") ];

  const eligible = discoverDoorLocations({ device: {} as AccessStateDevice, doors, sideDoorEligible: true });
  const ineligible = discoverDoorLocations({ device: {} as AccessStateDevice, doors, sideDoorEligible: false });

  assert.equal(eligible.sideDoorLocationId, "door2", "the side arm must find the qualifying door when it is in scope");
  assert.equal(ineligible.sideDoorLocationId, undefined, "the side arm must compute nothing when it is out of scope");
  assert.equal(ineligible.mainDoorLocationId, "door1", "the main resolution stands regardless of the side arm");
});

/* An Ultra whose record carries the multiplex, in whichever mode, alongside the port row the library keys its position family on. An arm hands `[]` for the rows to
 * withhold that row, which leaves the library no family to read a verdict from at all.
 *
 * @param mode - What the record says the multiplexed terminal input is configured for.
 * @param rows - The configuration rows the record carries.
 *
 * @returns The record.
 */
function multiplexed(mode: string, rows = configRows({ entries: { "input_d1_dps": "on" }, tag: "input" })): AccessStateDevice {

  return hubRecord({

    configs: rows,
    device_type: "UA-ULTRA",
    extensions: [{ extension_name: "port_setting", target_config: [{ config_key: "rex_button_mode", config_tag: "device_setting", config_value: mode }],
      target_name: "port1" }]
  });
}

test("dpsSensorEligible answers each hardware family from its own evidence", () => {

  const withDps = { dps: "close", location_id: "door1" } as AccessDoorStateEntry;
  const withoutDps = { location_id: "door1" } as AccessDoorStateEntry;

  // The UA Gate refuses regardless of the entry - two contrasting entries are what prove the regardless-of-entry claim.
  assert.equal(dpsSensorEligible({ device: hubRecord({ device_type: "UGT" }), entry: withDps }), false);
  assert.equal(dpsSensorEligible({ device: hubRecord({ device_type: "UGT" }), entry: withoutDps }), false);

  // The Ultra answers from its input multiplex in both directions, never from the entry: a request-to-exit input refuses even beside dps evidence, and a
  // door-position input accepts even before the entry establishes anything.
  assert.equal(dpsSensorEligible({ device: multiplexed("rex"), entry: withDps }), false);
  assert.equal(dpsSensorEligible({ device: multiplexed("dps"), entry: withoutDps }), true);

  // Every other family answers from the door-state model through hasDpsEvidence: established position accepts, a positive unwired report refuses, and an absent
  // entry refuses.
  const plainHub = hubRecord({});

  assert.equal(dpsSensorEligible({ device: plainHub, entry: withDps }), true);
  assert.equal(dpsSensorEligible({ device: plainHub, entry: { dps: "none", location_id: "door1" } }), false);
  assert.equal(dpsSensorEligible({ device: plainHub, entry: undefined }), false);
});

test("accessoryOwnership tells this controller's own accessories from every other kind", () => {

  const mac = "11:22:33:44:55:66";

  // A credentialed controller's accessories, keyed by the MAC address it answers by now.
  assert.equal(accessoryOwnership({ contextKey: mac, currentKey: mac, priorKey: "1.2.3.4" }), "current");

  // The transition case: an accessory adopted while the controller held only a token carries the configured address, and is still this controller's own.
  assert.equal(accessoryOwnership({ contextKey: "1.2.3.4", currentKey: mac, priorKey: "1.2.3.4" }), "prior");

  // A controller that never learns a MAC address answers by its configured address alone, and its accessories are current rather than prior.
  assert.equal(accessoryOwnership({ contextKey: "1.2.3.4", currentKey: "1.2.3.4", priorKey: undefined }), "current");

  // Another controller's accessory is never ours to reclaim.
  assert.equal(accessoryOwnership({ contextKey: "5.6.7.8", currentKey: "1.2.3.4", priorKey: undefined }), "foreign");

  /* An accessory carrying no key at all names no controller, so it is nobody's. This is the input a direct comparison against the controller's own key silently
   * claimed - both sides read undefined and matched - and it is also the row an implementation ordered as "current, else prior" gets wrong, for the same reason.
   */
  assert.equal(accessoryOwnership({ contextKey: undefined, currentKey: "1.2.3.4", priorKey: undefined }), "foreign");

  /* A MAC address key is the controller's spelling of the day, so each row below needs the fold on one side of one comparison: a cached context carrying the
   * colon-bearing spelling against the library's, and the same pair the other way around.
   */
  assert.equal(accessoryOwnership({ contextKey: "aa:bb:cc:dd:ee:ff", currentKey: "AABBCCDDEEFF", priorKey: "1.2.3.4" }), "current");
  assert.equal(accessoryOwnership({ contextKey: "AABBCCDDEEFF", currentKey: "aa:bb:cc:dd:ee:ff", priorKey: "1.2.3.4" }), "current");

  // A hostname is case-insensitive by definition, and the prior key is folded on both sides for the same reason the current one is.
  assert.equal(accessoryOwnership({ contextKey: "hubble.i.snw.net", currentKey: "AABBCCDDEEFF", priorKey: "HUBBLE.I.SNW.NET" }), "prior");
  assert.equal(accessoryOwnership({ contextKey: "HUBBLE.I.SNW.NET", currentKey: "AABBCCDDEEFF", priorKey: "hubble.i.snw.net" }), "prior");

  /* An IPv6 literal is not a MAC address, so the normalizer leaves its colons alone and only its case folds. The second row is the one a fold that stripped colons
   * gets wrong: two different addresses whose digits coincide once the separators are gone.
   */
  assert.equal(accessoryOwnership({ contextKey: "fe80::1", currentKey: "FE80::1", priorKey: undefined }), "current");
  assert.equal(accessoryOwnership({ contextKey: "1:23::4", currentKey: "12:3::4", priorKey: undefined }), "foreign");
});

test("an accessory answering any controller's key in any spelling is never stranded", () => {

  const keys = [ { currentKey: "AA:BB:CC:DD:EE:99", priorKey: "192.168.1.10" }, { currentKey: "1.2.3.5", priorKey: undefined } ];

  // The context spelling and the key spelling differ only in case and colons, which the ownership fold reconciles.
  assert.equal(accessoryStranded({ claims: [], contextKey: "aabbccddee99", keys, mac: undefined, uuid: "uuid-1" }), false);

  // The prior key names the address a credentialed controller adopted under before it learned its MAC address.
  assert.equal(accessoryStranded({ claims: [], contextKey: "192.168.1.10", keys, mac: undefined, uuid: "uuid-2" }), false);

  // A key nothing answers by strands the accessory when no claim speaks for its device either.
  assert.equal(accessoryStranded({ claims: [], contextKey: "00:11:22:33:44:55", keys, mac: undefined, uuid: "uuid-3" }), true);

  // The SECOND configured controller's key answers too...the walk must read past the first entry, so a first-entry-only implementation fails here.
  assert.equal(accessoryStranded({ claims: [], contextKey: "1.2.3.5", keys, mac: undefined, uuid: "uuid-4" }), false);
});

test("an accessory whose device any controller projects is never stranded", () => {

  const claims = [{ serials: new Set([serialForm("aa:bb:cc:dd:ee:01")]), uuids: new Set(["uuid-AABBCCDDEE02"]) }];

  // The hardware claim reads the context MAC address against the projected serials, in any spelling.
  assert.equal(accessoryStranded({ claims, contextKey: "00:11:22:33:44:55", keys: [], mac: "AA:BB:CC:DD:EE:01", uuid: "uuid-x" }), false);

  // The identity claim reads the accessory UUID against what membership accounts for.
  assert.equal(accessoryStranded({ claims, contextKey: "00:11:22:33:44:55", keys: [], mac: undefined, uuid: "uuid-AABBCCDDEE02" }), false);

  // An accessory carrying no context at all is nobody's even with real keys on offer...an undefined key matches no controller, and nothing projects it.
  assert.equal(accessoryStranded({ claims, contextKey: undefined, keys: [{ currentKey: "1.2.3.5", priorKey: undefined }], mac: undefined,
    uuid: "uuid-y" }), true);
});

test("the reclaim fence opens only when every configured controller reported an authoritative identity", () => {

  // Every configured entry produced a controller and each of them serves membership, so there is nothing missing to weigh an accessory against.
  assert.equal(reclaimFenceOpen({ configuredControllers: 2, constructedControllers: 2, outcomes: [ "reporting", "reporting" ] }), true);

  // A controller the user turned off in HomeKit connected first, so it knows exactly who it is and its keys are evidence like any other's.
  assert.equal(reclaimFenceOpen({ configuredControllers: 2, constructedControllers: 2, outcomes: [ "disabled", "reporting" ] }), true);

  // One identity nobody can attribute closes it, because that controller's own accessories would otherwise read as belonging to nothing.
  assert.equal(reclaimFenceOpen({ configuredControllers: 2, constructedControllers: 2, outcomes: [ "reporting", "unavailable" ] }), false);

  // A configuration entry that produced no controller at all is the same gap, arriving before the login rather than after it.
  assert.equal(reclaimFenceOpen({ configuredControllers: 2, constructedControllers: 1, outcomes: ["reporting"] }), false);

  // With nothing configured there is no evidence at all, and the predicate closes on that itself rather than trusting a caller never to ask.
  assert.equal(reclaimFenceOpen({ configuredControllers: 0, constructedControllers: 0, outcomes: [] }), false);
});

test("deviceModel answers from the richest thing the record carries and reads an empty string as absent", () => {

  // The topology document answers a display model, which is what a credentialed install shows today.
  assert.equal(deviceModel({ device_type: "UAH", display_model: "UA Hub", model: "UAH" } as AccessStateDevice), "UA Hub");

  // An empty display model is no display model, so the hardware model answers rather than a blank where a model belongs.
  assert.equal(deviceModel({ device_type: "UAH", display_model: "", model: "UAH-Door" } as AccessStateDevice), "UAH-Door");

  // The official API's inventory carries neither, so the type mapping answers - which is every record that surface projects.
  assert.equal(deviceModel({ device_type: "UAH" } as AccessStateDevice), "UA Hub");

  // Both members empty falls through the same way, and a type the mapping does not name answers itself.
  assert.equal(deviceModel({ device_type: "XYZ", display_model: "", model: "" } as AccessStateDevice), "XYZ");
});

test("isManagedRecord admits only a managed record whose hardware identity is established", () => {

  assert.equal(isManagedRecord(coreRecord()), true);

  // A device the controller does not manage is not ours to project, whatever else its record carries.
  assert.equal(isManagedRecord(coreRecord({ is_managed: false })), false);

  /* The official API names a device by an identifier that is not always address-shaped, and the projection leaves the hardware identity absent where it is not.
   * Such a record has nothing an accessory identity could be derived from, so membership skips it exactly as it skips an unmanaged one.
   */
  const unaddressed = { alias: "", capabilities: ["is_hub"], connected_uah_id: "", device_type: "UAH", is_adopted: true, is_connected: true, is_managed: true,
    is_online: true, location_id: "door1", name: "Named Hub", unique_id: "not-an-address" } as unknown as AccessStateDevice;

  assert.equal(isManagedRecord(unaddressed), false);

  // The predicate carries a type, which is what lets a caller inside its narrowing compose the decorated serial with no assertion of its own.
  const candidate: AccessStateDevice = coreRecord();

  if(!isManagedRecord(candidate)) {

    throw new Error("The core record must be addressable.");
  }

  assert.equal(deviceSerial(candidate), "74ACB9D55B9C");
});

test("a UA Ultra record carrying no extensions answers position eligibility from the door-state model", () => {

  const open = { dps: "open", location_id: "door1" } as AccessDoorStateEntry;
  const unwired = { dps: "none", location_id: "door1" } as AccessDoorStateEntry;

  const projected = coreRecord({ device_type: "UA-ULTRA" });

  /* Carrying no extensions at all is not the same as carrying a multiplex set to the exit button, and the contrasting pair is what tells the two apart: the same
   * established position answers false where the record says the input serves the exit button, and true where the record offers no multiplex to read.
   */
  assert.equal(dpsSensorEligible({ device: multiplexed("rex"), entry: open }), false);
  assert.equal(dpsSensorEligible({ device: projected, entry: open }), true);

  // The multiplex still outranks an absent entry in the other direction, and an absent multiplex still refuses a positive unwired report.
  assert.equal(dpsSensorEligible({ device: multiplexed("dps"), entry: undefined }), true);
  assert.equal(dpsSensorEligible({ device: projected, entry: unwired }), false);
});

test("a UA Ultra whose record establishes no duty answers its position eligibility from the door-state model", () => {

  const open = { dps: "open", location_id: "door1" } as AccessDoorStateEntry;
  const unwired = { dps: "none", location_id: "door1" } as AccessDoorStateEntry;

  /* A duty outside the two the library knows establishes nothing in either direction, so the entry is what answers. Reading both entries against it is what tells
   * a fallback apart from a read that refused outright, which answers false whatever the entry says.
   */
  assert.equal(dpsSensorEligible({ device: multiplexed("unknown"), entry: open }), true);
  assert.equal(dpsSensorEligible({ device: multiplexed("unknown"), entry: unwired }), false);

  // A duty the library does know is a verdict of its own, and it outranks whatever the entry establishes.
  assert.equal(dpsSensorEligible({ device: multiplexed("rex"), entry: open }), false);

  // The duty reads here, but a record carrying no reading row offers no family for it to qualify, so there is no verdict to outrank the entry with.
  assert.equal(dpsSensorEligible({ device: multiplexed("dps", []), entry: open }), true);
  assert.equal(dpsSensorEligible({ device: multiplexed("dps", []), entry: unwired }), false);
});

test("discoverDoorLocations ranks the controller's own live binding above the name heuristics", () => {

  const doors = [ stateDoor("door1", "Side Gate"), stateDoor("door2", "Utility") ];

  // The embedded door member wins over every fallback below it, as the binding the topology document states about this device directly, and only a published port
  // binding outranks it.
  assert.deepEqual(discoverDoorLocations({ device: { door: { unique_id: "d1" }, location_id: "d2" } as unknown as AccessStateDevice,
    doors: [ stateDoor("d1", "Alpha"), stateDoor("d2", "Beta") ], sideDoorEligible: false }), { mainDoorLocationId: "d1" });

  // A record carrying no embedded door resolves through the location the controller binds it to, which both censuses carry.
  assert.deepEqual(discoverDoorLocations({ device: { location_id: "door2" } as AccessStateDevice, doors, sideDoorEligible: false }),
    { mainDoorLocationId: "door2" });

  // A binding naming no door we were handed falls through to the name heuristics exactly as before.
  assert.deepEqual(discoverDoorLocations({ device: { location_id: "elsewhere" } as AccessStateDevice, doors: [ stateDoor("door1", "Utility"),
    stateDoor("door2", "Main Entrance") ], sideDoorEligible: false }), { mainDoorLocationId: "door2" });

  /* The two picks move together: the side arm excludes whatever the main arm chose, so a main door resolved from the live binding rather than from a name shifts
   * the side pick with it. Pinning the pair is what makes that coupling a stated outcome rather than an incidental one.
   */
  assert.deepEqual(discoverDoorLocations({ device: { location_id: "door2" } as AccessStateDevice, doors, sideDoorEligible: true }),
    { mainDoorLocationId: "door2", sideDoorLocationId: "door1" });
});

test("discoverDoorLocations ranks a port binding above every fallback, whichever order the controller delivered the bindings in", () => {

  const binding = (name: string, doorId: string): Record<string, string> => ({ extension_name: "port_setting", target_name: name, target_value: doorId });
  const doors = [ stateDoor("door1", "Main Gate"), stateDoor("door2", "Pedestrian Gate") ];

  /* A record whose every fallback points somewhere else: its embedded door member names door1, its location names door2, and the topology carries a door named
   * like a main gate and a door named like a side one. Only the published bindings answer with doorA and doorB, so nothing but the bindings can produce this pair.
   */
  const bound = (extensions: Record<string, string>[]): AccessStateDevice => ({ door: { unique_id: "door1" }, extensions,
    location_id: "door2" } as unknown as AccessStateDevice);

  assert.deepEqual(discoverDoorLocations({ device: bound([ binding("oper1", "doorA"), binding("oper2", "doorB") ]), doors, sideDoorEligible: true }),
    { mainDoorLocationId: "doorA", sideDoorLocationId: "doorB" });
  assert.deepEqual(discoverDoorLocations({ device: bound([ binding("oper1", "doorA"), binding("oper2", "doorB") ]), doors, sideDoorEligible: false }),
    { mainDoorLocationId: "doorA" });

  // The controller delivers its bindings in whatever order it likes, so the ports name the roles rather than the positions do.
  assert.deepEqual(discoverDoorLocations({ device: bound([ binding("oper2", "doorB"), binding("oper1", "doorA") ]), doors, sideDoorEligible: true }),
    { mainDoorLocationId: "doorA", sideDoorLocationId: "doorB" });

  // A record binding the side door's port alone names its side door and lets the main door fall through to the arms below, which is the embedded member here.
  assert.deepEqual(discoverDoorLocations({ device: bound([binding("oper2", "doorB")]), doors, sideDoorEligible: true }),
    { mainDoorLocationId: "door1", sideDoorLocationId: "doorB" });

  // A binding naming no port is still a binding, and it is the main door's: the side door then falls to the names, which is where it always fell.
  assert.deepEqual(discoverDoorLocations({ device: bound([{ extension_name: "port_setting", target_value: "doorA" }]), doors, sideDoorEligible: true }),
    { mainDoorLocationId: "doorA", sideDoorLocationId: "door2" });
});

test("a record carrying only the members every census establishes degrades by absence rather than throwing", () => {

  const projected = coreRecord();

  // No port extensions means no multiplex, so the position sensor answers from the door-state model in both directions.
  assert.equal(dpsSensorEligible({ device: projected, entry: undefined }), false);
  assert.equal(dpsSensorEligible({ device: projected, entry: { dps: "open", location_id: "door1" } }), true);

  // No embedded door snapshot means the live binding is what resolves the door.
  assert.deepEqual(discoverDoorLocations({ device: projected, doors: [stateDoor("door1", "Front Door")], sideDoorEligible: false }),
    { mainDoorLocationId: "door1" });

  // No display model and no hardware model means the type mapping answers.
  assert.equal(deviceModel(projected), "UA Hub");
});

// The registration this plugin wants to hold for a controller configured at 1.2.3.4, and the pieces the plan arms compare against it.
const DESIRED_PATH = "/unifi-access/1.2.3.4";
const DESIRED_NAME = "Homebridge UniFi Access (1.2.3.4)";
const DESIRED_URL = "http://10.0.0.7:10120" + DESIRED_PATH;

// One registration as the controller lists it back, with the members an arm does not care about filled in consistently.
function endpointRecord(overrides: { endpoint: string; events?: readonly typeof ACCESS_WEBHOOK_EVENT_LIST[number][]; id: string;
  name?: string; }): AccessOfficialWebhookEndpoint {

  return { endpoint: overrides.endpoint, events: overrides.events ?? ACCESS_WEBHOOK_EVENT_LIST, id: overrides.id, name: overrides.name ?? DESIRED_NAME,
    secret: "secret-" + overrides.id };
}

/* The live unlock delivery from the library's own capture corpus, rebuilt here from the values that capture recorded.
 *
 * The library ships its fixtures as test material rather than through its published entry point, so the values travel rather than the module. The parameter type
 * is read off the function under test, which is what keeps this fixture honest without restating the delivery's shape.
 */
function unlockDelivery(overrides: { actor?: Record<string, string> | null; object?: Record<string, unknown> } = {}): Parameters<typeof unlockAttribution>[0] {

  return {

    data: {

      actor: (overrides.actor === undefined) ? { id: "b3e2d4f6-0000-4000-8000-000000000002", name: "webhook delivery probe", type: "open-api" } : overrides.actor,
      device: { connected_hub_id: "", id: "74acb9d55b9c", mac: "74:ac:b9:d5:5b:9c", name: "UA-HUB-5B9C" },
      location: { id: "740785e0-ef1d-4a2b-a720-3c8804feea9c", location_type: "door", name: "Door Hub", up_id: "4fb613ed-ba9d-49fb-b729-44b6d574d07b" },
      object: overrides.object ?? {

        actor_id: "b3e2d4f6-0000-4000-8000-000000000002",
        actor_name: "webhook delivery probe",
        authentication_type: "REMOTE_THROUGH_UAH",
        authentication_value: "",
        policy_id: "",
        policy_name: "",
        reader_id: "",
        result: "Access Granted",
        time: "2026-08-15 16:03:48 -0500 CDT"
      }
    },
    event: ACCESS_WEBHOOK_EVENTS.doorUnlock,
    event_object_id: "86a9fa88-e1cd-4363-b2ba-8a867ef754b5"
  } as unknown as Parameters<typeof unlockAttribution>[0];
}

test("the webhook port setting resolves to the port as written, the default when absent or off, and the default with the rejected value otherwise", () => {

  // A setting nobody stated: absent, turned off, or configured as nothing at all. Each is the default, said silently, because nothing was said.
  for(const value of [ undefined, null, "", "  " ]) {

    assert.deepEqual(resolveWebhookPort(value), { port: 10120, source: "default" }, "a setting of " + JSON.stringify(value) + " states no port");
  }

  /* Every whole number from 1 to 65535 as written, surrounding whitespace included. 65535 is the last port there is, so the upper bound is stated rather than assumed
   * to be inside. "00080" is five digits, which the length cap admits and parseInt reads as 80 - the documented reading of a padded port, and the row that puts the
   * cap's own limit next to it.
   */
  for(const [ value, port ] of [ [ "10120", 10120 ], [ "65535", 65535 ], [ " 10130 ", 10130 ], [ "00080", 80 ] ] as [string, number][]) {

    assert.deepEqual(resolveWebhookPort(value), { port, source: "configured" }, "a setting of " + JSON.stringify(value) + " is that port");
  }

  /* Everything else present: over the bound, signed, fractional, trailing rubbish, not a number at all, and the spellings a looser numeric parse would take.
   * "0" and "00000" are inside the length cap and below the first port a registration can name - 0 asks the kernel for an ephemeral port no controller could be
   * told - and "00000" is the row that tells the lower bound apart from the cap the way "000080" tells the cap apart from the upper bound. "1e3" and "+80" are what
   * a bare Number() would read as 1000 and 80, and the digits-only rule is what refuses them. "000080" is six digits: over the length cap however small the number
   * it spells, which is the one row that tells the cap apart from the numeric bound.
   */
  for(const value of [ "0", "00000", "65536", "-1", "1.5", "10120x", "abc", "1e3", "+80", "000080" ]) {

    assert.deepEqual(resolveWebhookPort(value), { port: 10120, source: "invalid", value: value.trim() },
      "a setting of " + JSON.stringify(value) + " is not a port, and the value it was is carried back for the reader to name");
  }
});

test("webhookEndpointPath keys a controller's path on its configured address, encoded for a path", () => {

  assert.equal(webhookEndpointPath("192.168.1.5"), "/unifi-access/192.168.1.5");
  assert.equal(webhookEndpointPath("access.example.com"), "/unifi-access/access.example.com");

  // An IPv6 literal's colons are not path characters, so they encode.
  assert.equal(webhookEndpointPath("fe80::1"), "/unifi-access/fe80%3A%3A1");
});

test("webhookEndpointUrl composes an authority a controller can parse, brackets included", () => {

  assert.equal(webhookEndpointUrl({ host: "10.0.0.7", path: "/unifi-access/a", port: 10120 }), "http://10.0.0.7:10120/unifi-access/a");

  // Without brackets an IPv6 literal's own colons would read as the port separator, so the authority would not parse at all.
  assert.equal(webhookEndpointUrl({ host: "fd00::7", path: "/unifi-access/a", port: 10120 }), "http://[fd00::7]:10120/unifi-access/a");
});

test("webhookRegistrations matches on the path alone and skips a record it cannot parse", () => {

  const existing = [

    endpointRecord({ endpoint: "http://h1:1/p", id: "one" }),
    endpointRecord({ endpoint: "http://h2:1/q", id: "two" }),
    endpointRecord({ endpoint: "http://h3:2/p", id: "three" }),
    endpointRecord({ endpoint: "not a url", id: "four" })
  ];

  /* Both records at the path answer, in the order the controller listed them, whichever host or port they name - which is what lets a moved Homebridge host find
   * its own registration again. The unparseable record carries no path to compare and answers to nothing.
   */
  assert.deepEqual(webhookRegistrations({ existing, path: "/p" }).map(record => record.id), [ "one", "three" ]);
});

test("webhookRegistrationPlan decides on the first record at our path and calls every other one stale", () => {

  const desired = { endpoint: DESIRED_URL, events: ACCESS_WEBHOOK_EVENT_LIST, name: DESIRED_NAME };
  const plan = (existing: AccessOfficialWebhookEndpoint[]): ReturnType<typeof webhookRegistrationPlan> => {

    return webhookRegistrationPlan({ desired, existing, path: DESIRED_PATH });
  };

  // Nothing at our path: one must be minted.
  assert.deepEqual(plan([]), { kind: "create", stale: [] });

  // An exact match is taken as it stands, which is what keeps the secret the controller minted and makes a restart cost it nothing. The event order is the
  // controller's to choose, so it is not a difference worth a rewrite.
  const matching = endpointRecord({ endpoint: DESIRED_URL, events: [...ACCESS_WEBHOOK_EVENT_LIST].reverse(), id: "match" });

  assert.deepEqual(plan([matching]), { endpoint: matching, kind: "reuse", stale: [] });

  // A narrower event set, a different name, and a different host each describe something other than what we want, so each is rewritten in place.
  for(const record of [

    endpointRecord({ endpoint: DESIRED_URL, events: [ACCESS_WEBHOOK_EVENTS.doorUnlock], id: "narrow" }),
    endpointRecord({ endpoint: DESIRED_URL, id: "renamed", name: "other" }),
    endpointRecord({ endpoint: "http://10.9.9.9:10120" + DESIRED_PATH, id: "moved" })
  ]) {

    assert.deepEqual(plan([record]), { endpoint: record, kind: "update", stale: [] });
  }

  // Records at other paths belong to other controllers and are none of our business.
  assert.deepEqual(plan([endpointRecord({ endpoint: "http://10.0.0.7:10120/unifi-access/5.6.7.8", id: "sibling" })]), { kind: "create", stale: [] });

  // Two at our path: the first decides, and the rest are cleared. An implementation sweeping every match instead would delete the one it is about to reuse.
  const second = endpointRecord({ endpoint: "http://10.9.9.9:10120" + DESIRED_PATH, id: "leftover" });

  assert.deepEqual(plan([ matching, second ]), { endpoint: matching, kind: "reuse", stale: [second] });
});

test("orphanedWebhookRegistrations selects a leftover of ours and nothing that belongs to anyone else", () => {

  // The path a controller configured at 9.9.9.9 registered under, before the user re-addressed it to the 1.2.3.4 this plugin now answers for.
  const abandoned = webhookEndpointPath("9.9.9.9");
  const ours = "http://10.0.0.7:10120";

  const existing = [

    // Ours by every test: our prefix, our authority, and a path no configured controller claims.
    endpointRecord({ endpoint: ours + abandoned, id: "orphan" }),
    // The same abandoned path at another authority. A second Homebridge install serving this controller looks exactly like this, so neither is ours to delete.
    endpointRecord({ endpoint: "http://10.0.0.7:10121" + abandoned, id: "otherPort" }),
    endpointRecord({ endpoint: "http://10.0.0.9:10120" + abandoned, id: "otherHost" }),
    // Our authority, but nothing under our prefix is another application's business on the same host and port.
    endpointRecord({ endpoint: ours + "/some-other-plugin/9.9.9.9", id: "foreignPrefix" }),
    // A sibling controller this plugin is configured for, and this controller's own current path. Both are claimed, and a claimed path is never an orphan.
    endpointRecord({ endpoint: ours + webhookEndpointPath("5.6.7.8"), id: "sibling" }),
    endpointRecord({ endpoint: ours + DESIRED_PATH, id: "current" }),
    // No path and no authority to judge, so it answers to nothing - the same reading the path search gives it.
    endpointRecord({ endpoint: "not a url", id: "unparseable" })
  ];

  const selected = orphanedWebhookRegistrations({ configuredAddresses: [ "1.2.3.4", "5.6.7.8" ], existing, host: "10.0.0.7", port: 10120 });

  assert.deepEqual(selected.map(record => record.id), ["orphan"]);
});

test("orphanedWebhookRegistrations reads an IPv6 authority through the composers, and an empty configured address claims no path", () => {

  const abandoned = webhookEndpointPath("9.9.9.9");

  /* The endpoint an IPv6-reachable install wrote, composed the way the plugin composes one rather than spelled here. Comparing the authorities through the parse
   * is what makes the brackets a detail of the composer instead of a spelling every caller has to agree on.
   */
  const bracketed = endpointRecord({ endpoint: webhookEndpointUrl({ host: "fd00::7", path: abandoned, port: 10120 }), id: "v6orphan" });

  assert.deepEqual(orphanedWebhookRegistrations({ configuredAddresses: ["1.2.3.4"], existing: [bracketed], host: "fd00::7",
    port: 10120 }).map(record => record.id), ["v6orphan"], "an IPv6 authority composed through the builder matches the one read back off it");

  // And the same record read against an install at another IPv6 host stays put.
  assert.deepEqual(orphanedWebhookRegistrations({ configuredAddresses: ["1.2.3.4"], existing: [bracketed], host: "fd00::8", port: 10120 }), []);

  /* An empty configured address describes no controller, so it contributes no claimed path rather than claiming the bare prefix. A record sitting at that bare
   * prefix is therefore still judged on its own merits - it is under our prefix at our authority and nothing claims it.
   */
  const bare = endpointRecord({ endpoint: "http://10.0.0.7:10120" + ACCESS_WEBHOOK_PATH_PREFIX, id: "bare" });

  assert.deepEqual(orphanedWebhookRegistrations({ configuredAddresses: [ "1.2.3.4", "" ], existing: [bare], host: "10.0.0.7",
    port: 10120 }).map(record => record.id), ["bare"]);
});

test("webhookSignatureHeader hands back the header a sender actually wrote, unchanged", () => {

  /* Node comma-joins an ordinary header sent more than once into one string, so the second value below is the round-trip shape of a repeated `signature` rather
   * than anything a sender composed. It passes through here and is refused at verification, where a malformed code belongs...an implementation that went looking
   * for a separator and answered `undefined` on finding one would refuse it a step too early and for the wrong reason.
   */
  const joined = "t=1000000000,v1=aaaa, t=1000000000,v1=bbbb";

  assert.equal(webhookSignatureHeader({ signature: "t=1000000000,v1=abcdef" }), "t=1000000000,v1=abcdef");
  assert.equal(webhookSignatureHeader({ signature: joined }), joined);
});

test("webhookSignatureHeader reads the array shape as no signature at all", () => {

  /* The value is what this asserts and not merely its falsiness: an implementation reaching for `String(header)` would answer the comma-joined `"a,b"` here,
   * which is a string and would go on to be verified as one. Comparing against `undefined` itself is what that coercion cannot pass.
   */
  assert.equal(webhookSignatureHeader({ signature: [ "a", "b" ] }), undefined);
});

test("webhookSignatureHeader reads an absent header as no signature", () => {

  /* An unsigned delivery, and one carrying headers that say nothing about a signature. An implementation defaulting to an empty string would answer `""` for
   * both, and the caller tests for `undefined`, so an empty string would reach verification as a signature nobody sent.
   */
  assert.equal(webhookSignatureHeader({}), undefined);
  assert.equal(webhookSignatureHeader({ "content-type": "application/json" }), undefined);
});

test("webhookDeliveryFresh refuses a delivery on both sides of the window", () => {

  const windowMs = 300000;
  const timestampSeconds = 1000000000;

  assert.equal(webhookDeliveryFresh({ nowMs: 1000000000000, timestampSeconds, windowMs }), true);

  // Exactly the window behind is still fresh, and one millisecond past it is not.
  assert.equal(webhookDeliveryFresh({ nowMs: 1000000300000, timestampSeconds, windowMs }), true);
  assert.equal(webhookDeliveryFresh({ nowMs: 1000000300001, timestampSeconds, windowMs }), false);

  /* The future side, which a one-sided past-only check would accept without limit: a controller whose clock runs ahead of this host's produces exactly this, and
   * so does anyone dating a forgery forward.
   */
  assert.equal(webhookDeliveryFresh({ nowMs: 999999700000, timestampSeconds, windowMs }), true);
  assert.equal(webhookDeliveryFresh({ nowMs: 999999699999, timestampSeconds, windowMs }), false);
});

test("unlockAttribution reads the live capture's own values and treats an empty wire string as absent", () => {

  // The API-caller unlock: attributed, and its actor kind folded onto the library's one spelling from the hyphenated form this channel uses.
  assert.deepEqual(unlockAttribution(unlockDelivery()), {

    actor: "webhook delivery probe",
    actorType: "open_api",
    method: "REMOTE_THROUGH_UAH",
    policy: null,
    reader: null,
    result: "Access Granted",
    time: "2026-08-15 16:03:48 -0500 CDT"
  });

  // The unlock a person performed answering a doorbell call, which carries a reader and a different method and nothing else new.
  const answered = unlockAttribution(unlockDelivery({ actor: { id: "49dd3ea1-8320-44b4-a104-f89e4101389c", name: "H Dihu", type: "user" }, object: {

    authentication_type: "CALL", authentication_value: "", policy_id: "", policy_name: "", reader_id: "d8b3706bb73b", result: "Access Granted",
    time: "2026-08-15 16:09:58 -0500 CDT"
  } }));

  assert.equal(answered.reader, "d8b3706bb73b");
  assert.equal(answered.method, "CALL");
  assert.equal(answered.actorType, "user");

  // An unattributed unlock answers null for both halves of the actor, through the one null check, and reports everything else identically.
  assert.deepEqual(unlockAttribution(unlockDelivery({ actor: null })), {

    actor: null,
    actorType: null,
    method: "REMOTE_THROUGH_UAH",
    policy: null,
    reader: null,
    result: "Access Granted",
    time: "2026-08-15 16:03:48 -0500 CDT"
  });
});

test("describeUnlock says who opened a door and how, and drops cleanly to what it knows", () => {

  // The fixture-derived row: granted, attributed, no policy, and the method rendered through the library's plain-English gloss.
  assert.equal(describeUnlock({ attribution: unlockAttribution(unlockDelivery()), door: "Door Hub" }),
    "Door Hub unlocked by webhook delivery probe (remote command through the hub).");

  // Granted and unattributed: the actor clause goes entirely rather than naming an empty someone, and a policy joins the glossed method in the parenthetical.
  assert.equal(describeUnlock({ attribution: { actor: null, actorType: null, method: "NFC", policy: "Front Door", reader: "r1", result: "Access Granted",
    time: "t" }, door: "Front Door" }), "Front Door unlocked (NFC credential, policy: Front Door).");

  // Refused: the verb and the preposition move together, because an unlock that did not happen was attempted for someone rather than performed by them. PIN is
  // deliberately outside the library's glossed vocabulary, so these two arms also hold the raw-token fallback in place.
  assert.equal(describeUnlock({ attribution: { actor: "Alice", actorType: "user", method: "PIN", policy: null, reader: null, result: "Access Denied", time: "t" },
    door: "Side Door" }), "Side Door unlock refused for Alice (PIN).");

  assert.equal(describeUnlock({ attribution: { actor: null, actorType: null, method: "PIN", policy: null, reader: null, result: "Access Denied", time: "t" },
    door: "Side Door" }), "Side Door unlock refused (PIN).");
});

test("doorbellOutcome reads the library's own glosses and still says something honest about a code it has none for", () => {

  const timedOut = ACCESS_DOORBELL_REASON_CODES[105];
  const elsewhere = ACCESS_DOORBELL_REASON_CODES[400];

  assert.ok(timedOut, "the library should carry a gloss for the call-timeout code");
  assert.ok(elsewhere, "the library should carry a gloss for the answered-elsewhere code");

  // Asserted against the table rather than against retyped strings, so a gloss revised upstream reaches the log without this test having to be edited too.
  assert.equal(doorbellOutcome(105), timedOut);
  assert.equal(doorbellOutcome(400), elsewhere);

  // A code the table does not carry still reports that the call ended, and what the controller called it.
  assert.equal(doorbellOutcome(999), "The call ended (reason code 999).");
});

test("doorGuardChoices labels a door's guards by name where the census knows them and offers the whole census where no door names them", () => {

  const users = [

    { alias: "", full_name: "Zed Guard", id: "guard-z", status: "ACTIVE", username: "zed" },
    { alias: "Annie", full_name: "", id: "guard-a", status: "PENDING", username: "annie" },
    { alias: "", full_name: "", id: "guard-d", status: "DEACTIVATED", username: "" }
  ] as unknown as AccessOfficialUser[];

  // A door naming guards keeps the door's order, labels a known guard by the first name the census carries, and falls back to the identifier for an unknown one.
  assert.deepEqual(doorGuardChoices({ guardIds: [ "guard-z", "guard-x", "guard-z", "guard-d", "" ], users }), [

    { label: "Zed Guard", value: "guard-z" },
    { label: "guard-x", value: "guard-x" },
    { label: "guard-d", value: "guard-d" }
  ]);

  // No census at all leaves every guard labeled by its identifier, which is what a credentialed controller without a token offers.
  assert.deepEqual(doorGuardChoices({ guardIds: ["guard-z"], users: [] }), [{ label: "guard-z", value: "guard-z" }]);

  // A door whose guards nothing lists offers every active or pending user, sorted by label, and never a deactivated one.
  assert.deepEqual(doorGuardChoices({ guardIds: undefined, users }), [ { label: "Annie", value: "guard-a" }, { label: "Zed Guard", value: "guard-z" } ]);

  // An empty door and an empty census each offer nothing.
  assert.deepEqual(doorGuardChoices({ guardIds: [], users }), []);
  assert.deepEqual(doorGuardChoices({ guardIds: undefined, users: [] }), []);
});

test("resolveDoorService takes an explicit service as chosen and defers everything else to the hardware", () => {

  for(const deviceType of [ "UGT", "UAH", "UA-Ultra", "UAH-Ent" ]) {

    assert.equal(resolveDoorService({ choice: "Lock", deviceType }), "Lock");
    assert.equal(resolveDoorService({ choice: "GarageDoorOpener", deviceType }), "GarageDoorOpener");
  }

  // The automatic choice, nothing configured, and text the catalog does not offer all read as the hardware's own default.
  for(const choice of [ "Automatic", undefined, null, "", "Sideways" ]) {

    assert.equal(resolveDoorService({ choice, deviceType: "UGT" }), "GarageDoorOpener", "a gate defaults to an opener for " + String(choice));
    assert.equal(resolveDoorService({ choice, deviceType: "UAH" }), "Lock", "a hub defaults to a lock for " + String(choice));
  }

  // The offered values are the two services and the automatic choice, spelled as the configuring log line spells the services.
  assert.deepEqual(doorServiceChoices.map(choice => choice.value), [ "Automatic", "Lock", "GarageDoorOpener" ]);
});

test("accessMethodChoices offers the whole catalog with no device and only what a device reports with one, from the one catalog the switches read", () => {

  // The whole catalog, in its own order, labeled by display name and valued by the choice spelling a selection stores.
  assert.deepEqual(accessMethodChoices(), accessMethods.map(method => ({ label: method.name, value: method.choice })));

  // A device narrows the list to the capabilities it reports, a family capability counting on any member.
  const device = { capabilities: [ "is_reader", "pin_code", "support_mobile_unlock" ] } as unknown as AccessStateDevice;

  assert.deepEqual(accessMethodChoices(device).map(choice => choice.value), [ "Mobile", "PIN" ]);
  assert.equal(deviceHasCapability(device, [ "mobile_unlock_ver2", "support_mobile_unlock" ]), true);
  assert.equal(deviceHasCapability(device, "qr_code"), false);
});
