/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-status.test.ts: Tests for the webUI live-status adapter - the context narrowing, the error classification, the row policy, the connect-on-view lifecycle,
 * the emit chokepoint's session guard, the frame identity convention, the resolution layer, and the connection wiring.
 *
 * The fixtures drive the library's real reducer through createStateStore rather than hand-mirroring its fold, and the client boundary is an injected stub wrapped
 * around that real store, so what the arms pin is the behavior the plugin actually gets. The device MAC addresses are deliberately colon-bearing lowercase - the
 * spelling live controllers report - so every frame-identity assertion exercises the decoration convention rather than assuming it.
 */
/* eslint-disable camelcase */
import type { AccessApiMode, AccessBootstrapConfig, AccessControllerConfig, AccessDoorStateEntry, AccessEventPacket, AccessStateDevice,
  StateStore } from "unifi-access";
import { AccessAuthError, AccessAuthorizationError, AccessClient, AccessNetworkError, AccessStallError, AccessThrottledError, AccessTimeoutError, createStateStore,
  noopLog, selectAccessPoints, selectDoorStates } from "unifi-access";
import { AccessStatusFeed, classifyStatusError, composeStatusRows, formatUptime, narrowStatusContextRequest } from "./webui-status.ts";
import type { StatusContextController, StatusContextRequest, StatusFeedClient, StatusFeedHubHandle } from "./webui-status.ts";
import type { StatusEvent, StatusRow } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import test from "node:test";

// The topology root every fixture below hangs its doors from.
const ROOT_ID = "root1";

// The two hubs' colon-bearing MAC spellings and the decorated serials the registry keys them by.
const MAC_ONE = "aa:bb:cc:dd:ee:01";
const MAC_TWO = "aa:bb:cc:dd:ee:02";
const SERIAL_ONE = "AABBCCDDEE01";
const SERIAL_TWO = "AABBCCDDEE02";

// The controller address every fixture's registry entry carries.
const ADDRESS = "192.0.2.10";

// The uptime, in seconds, that renders as "127d 14h" - the formatter's pinned arithmetic input.
const UPTIME_127D_14H = 11023200;

// Build a minimal topology document carrying doors, each with its serving devices. Only the members the reducer and the selectors read are meaningful; the rest
// satisfies the document's shape.
function doorsTopology(doors: { devices: Record<string, unknown>[]; id: string }[]): AccessBootstrapConfig {

  return {

    device_groups: [[]],
    extra_type: "building",
    extras: {},
    floors: [{

      doors: doors.map(({ devices, id }) => ({ device_groups: [devices], extras: {}, full_name: "Door " + id, level: 2, location_type: "door", name: "Door " + id,
        unique_id: id, up_id: "floor1" })),
      floor_number: 1,
      level: 1,
      name: "Test Floor",
      unique_id: "floor1",
      up_id: ROOT_ID
    }],
    full_name: "Test Building",
    level: 0,
    location_type: "building",
    name: "Test Building",
    timezone: "UTC",
    unique_id: ROOT_ID,
    up_id: "",
    work_time: "",
    work_time_id: ""
  } as unknown as AccessBootstrapConfig;
}

// The configuration rows a device record carries, in the key/tag/value shape the controller writes them as.
function configs(deviceId: string, entries: Record<string, string>): Record<string, unknown>[] {

  return Object.entries(entries).map(([ key, value ]) => ({ device_id: deviceId, key, tag: "input_state", value }));
}

// A managed, online hub whose position wiring reads live and closed and whose lock reads locked - the capture corpus's plain UA Hub shape, so the topology seed
// establishes { dps: "close", lock: "locked" } for the door it serves.
function wiredHub(uniqueId: string, mac: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {

  return {

    capabilities: [ "is_hub", "dps_alarm" ],
    configs: configs(uniqueId, { "input_state_dps": "on", "input_state_rly-lock_dry": "off", "wiring_state_dps-neg": "on", "wiring_state_dps-pos": "on" }),
    device_type: "UAH",
    is_managed: true,
    is_online: true,
    mac,
    name: "Hub " + uniqueId,
    unique_id: uniqueId,
    ...overrides
  };
}

// A managed, online hub carrying no wiring facts at all, so what its door establishes comes only from dispatched door-state events.
function bareHub(uniqueId: string, mac: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {

  return { capabilities: ["is_hub"], configs: [], device_type: "UAH", is_managed: true, is_online: true, mac, name: "Hub " + uniqueId, unique_id: uniqueId,
    ...overrides };
}

// A managed, online reader carrying whatever capabilities and configuration rows an arm hands it - the hardware whose access methods the methods row reports.
function reader(uniqueId: string, mac: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {

  return { capabilities: ["is_reader"], configs: [], device_type: "UA-G2-PRO", is_managed: true, is_online: true, mac, name: "Reader " + uniqueId,
    unique_id: uniqueId, ...overrides };
}

// Classify one captured-shape door-state notification for dispatch, so an entry moves through the real reducer exactly as a live controller would move it.
function doorEvent(doorId: string, state: Record<string, unknown>): NonNullable<ReturnType<typeof AccessClient.classifyPacket>> {

  const packet = {

    // The captured location-update shape carries the full member set; the classifier keys on it, so the defaults ride every dispatch and a caller's members
    // layer over them.
    data: { id: doorId, location_type: "door", name: "Door " + doorId,
      state: { dps_connected: true, emergency: { hardware: "none", software: "none" }, is_unavailable: false, ...state } },
    event: "access.data.v2.location.update",
    event_object_id: "3fe74bff-0d70-45f1-84ed-f183a3f9ff93",
    meta: { all_field: true, id: doorId, object_type: "location", source: "", target_field: null },
    receiver_id: "",
    save_to_history: false
  } as unknown as AccessEventPacket;

  const event = AccessClient.classifyPacket(packet);

  assert.ok(event, "the captured shape must classify as something the library models");

  return event;
}

/* Classify one captured-shape device update carrying a fresh configuration row set, which is how a method being switched on or off at the controller reaches a
 * device record. The older dialect already speaks the bootstrap vocabulary, so the classifier passes this payload through untranslated and the reducer merges it
 * onto the held record, where an array member replaces wholesale - so the rows this states are the rows the record then carries.
 */
function deviceConfigsEvent(deviceId: string, entries: Record<string, string>): NonNullable<ReturnType<typeof AccessClient.classifyPacket>> {

  const packet = {

    data: { configs: configs(deviceId, entries), unique_id: deviceId },
    event: "access.data.device.update",
    event_object_id: deviceId,
    receiver_id: "",
    save_to_history: false
  } as unknown as AccessEventPacket;

  const event = AccessClient.classifyPacket(packet);

  assert.ok(event, "the captured shape must classify as something the library models");

  return event;
}

/* A client stub over a real state store: the connection registrar the wiring arms fire directly, the two handle lookups the resolution layer reads, the capabilities
 * a connect establishes and the controller row renders, and a counted disposal. The counters-not-booleans convention is what tells a no-op from a double call. An
 * entry marked as a port is answered by the access-point lookup alone, which is how the real client separates one door-serving port of an Enterprise hub from a hub
 * that answers for itself. The stub reaches the port through a cast, so the compiler forces none of these members: the capabilities member is spelled here
 * deliberately, and the arm that reads a controller view's API row off a NON-default mode is what keeps its absence from passing silently.
 */
function makeClient(store: StateStore, hubs: { doorId?: string; port?: boolean; record?: AccessStateDevice; throwOnDoorId?: boolean }[] = [],
  mode: AccessApiMode = "dual"): { client: StatusFeedClient; connection: { fire: (event: string) => void; state: string }; disposeCount: () => number } {

  const handlers = new Map<string, Set<() => void>>();

  const connection = {

    fire: (event: string): void => {

      for(const handler of handlers.get(event) ?? []) {

        handler();
      }
    },
    on: (event: string, handler: () => void): Disposable => {

      const set = handlers.get(event) ?? new Set<() => void>();

      set.add(handler);
      handlers.set(event, set);

      return { [Symbol.dispose]: (): void => void set.delete(handler) };
    },
    state: "healthy"
  };

  let disposed = 0;

  const hubHandles = hubs.map((hub) => ({

    handle: {

      get doorId(): string {

        if(hub.throwOnDoorId) {

          throw new ReferenceError("The device is no longer present in the controller state.");
        }

        return hub.doorId ?? "";
      }
    },
    port: hub.port === true,
    recordId: hub.record?.unique_id
  }));

  // Both lookups are keyed on the identity of the record each handle was built from, which is the identity the real client answers them by.
  const handleFor = (id: string, port: boolean): StatusFeedHubHandle | undefined => {

    return hubHandles.find((entry) => (entry.port === port) && (entry.recordId === id))?.handle;
  };

  const client = {

    accessPoint: (id: string): StatusFeedHubHandle | undefined => handleFor(id, true),
    capabilities: { mode },
    connection,
    hub: (id: string): StatusFeedHubHandle | undefined => handleFor(id, false),
    state: store,
    [Symbol.asyncDispose]: async (): Promise<void> => {

      disposed++;
    }
  } as unknown as StatusFeedClient;

  return { client, connection, disposeCount: (): number => disposed };
}

// One controller's context request, in the card-values vocabulary the browser composes.
function contextRequest(serials: string[], overrides: Partial<StatusContextController> = {}): StatusContextRequest {

  return { controllers: [{ address: ADDRESS, password: "secret", serials, username: "user", ...overrides }] };
}

// Let the fire-and-forget machinery settle: the observe loops register and drain on the microtask and immediate queues, so two immediates cover a dispatch chain.
async function settle(): Promise<void> {

  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// The device-scoped frames addressed to one serial, in arrival order.
function forSerial(frames: StatusEvent[], serial: string): Exclude<StatusEvent, { kind: "hello" }>[] {

  return frames.filter((frame): frame is Exclude<StatusEvent, { kind: "hello" }> => ("serialNumber" in frame) && (frame.serialNumber === serial));
}

// The id-and-value projection of a row list, which is what most row assertions compare. A choices row states no value, so it projects its list the way the panel
// draws it - each choice's label behind a checked or unchecked box - which keeps one projection honest across both row forms rather than casting one into the other.
function idValues(rows: readonly StatusRow[]): string[][] {

  return rows.map((row) => (row.kind === "choices") ?
    [ row.id, row.choices.map((choice) => (choice.selected ? "[x] " : "[ ] ") + choice.label).join(" ") ] : [ row.id, row.value ]);
}

// Extract one frame by position, asserting its kind at runtime and narrowing it for the member assertions that follow.
function frameOf<K extends StatusEvent["kind"]>(frames: readonly StatusEvent[], index: number, kind: K): Extract<StatusEvent, { kind: K }> {

  const frame = frames[index];

  assert.ok(frame, "expected a frame at index " + String(index));
  assert.equal(frame.kind, kind);

  return frame as Extract<StatusEvent, { kind: K }>;
}

test("narrowStatusContextRequest admits the canonical payload and narrows to only the declared members", () => {

  const narrowed = narrowStatusContextRequest({ controllers: [{ address: ADDRESS, controllerSerial: "aa:bb:cc:00:00:99", extra: "dropped", password: "p",
    serials: [ "S1", 42, "S2" ], tokens: { access: "t" }, username: "u", verifyTls: true }] });

  assert.ok(narrowed);

  // Non-string serials filter out, and the undeclared member does not survive - the narrowing is never a passthrough.
  assert.deepEqual(narrowed.controllers, [{ address: ADDRESS, controllerSerial: "aa:bb:cc:00:00:99", password: "p", serials: [ "S1", "S2" ],
    tokens: { access: "t" }, username: "u", verifyTls: true }]);
});

test("narrowStatusContextRequest rejects a malformed body and drops a malformed entry", () => {

  // The request-level rejections: a non-object body and a missing or non-array controllers member.
  assert.equal(narrowStatusContextRequest(null), null);
  assert.equal(narrowStatusContextRequest("nope"), null);
  assert.equal(narrowStatusContextRequest({}), null);
  assert.equal(narrowStatusContextRequest({ controllers: "nope" }), null);

  // The entry-level rejections drop the entry without blanking the request: no address, an empty address, and no serials array all reject individually.
  const mixed = narrowStatusContextRequest({ controllers: [ { address: "", serials: [] }, { serials: [] }, { address: ADDRESS }, { address: ADDRESS, serials: [] } ] });

  assert.ok(mixed);
  assert.deepEqual(mixed.controllers, [{ address: ADDRESS, serials: [] }]);

  /* A present-but-wrong-typed optional member rejects its entry, and every optional member the contract declares is driven here: a numeric controllerSerial, a
   * numeric password, a tokens whose access is not a string, a numeric username, and a non-boolean verifyTls. The surviving entry carries a well-typed username, so
   * what the username rejection above it proves is the type test rather than the member being dropped wholesale.
   */
  const wrongTyped = narrowStatusContextRequest({ controllers: [

    { address: ADDRESS, controllerSerial: 42, serials: [] },
    { address: ADDRESS, password: 42, serials: [] },
    { address: ADDRESS, serials: [], tokens: { access: 42 } },
    { address: ADDRESS, serials: [], username: 42 },
    { address: ADDRESS, serials: [], verifyTls: "yes" },
    { address: ADDRESS, serials: [], username: "kept" }
  ] });

  assert.ok(wrongTyped);
  assert.deepEqual(wrongTyped.controllers, [{ address: ADDRESS, serials: [], username: "kept" }]);
});

test("classifyStatusError maps every typed failure onto the wire vocabulary", () => {

  assert.equal(classifyStatusError(new AccessAuthError("Bad credentials.")), "auth-invalid");
  assert.equal(classifyStatusError(new AccessAuthorizationError("Not an administrator.")), "auth-invalid");
  assert.equal(classifyStatusError(new AccessTimeoutError("The request timed out.", { elapsedMs: 5000 })), "timeout");
  assert.equal(classifyStatusError(new AccessStallError("The channel went silent.", { silentForMs: 5000 })), "timeout");
  assert.equal(classifyStatusError(new AccessNetworkError("The connection failed.")), "unreachable");
  assert.equal(classifyStatusError(new AccessThrottledError("The controller is throttled.", { cooldownMs: 1000 })), "unreachable");

  // The default arm: an unclassified throw is connectivity to a user, so it answers the same honest reason.
  assert.equal(classifyStatusError(new Error("Anything else.")), "unreachable");
});

test("formatUptime renders the two largest units that apply and degrades null to absence", () => {

  // The pinned day-tier arithmetic: a wrong day divisor must go red here, not render plausibly.
  assert.equal(formatUptime(UPTIME_127D_14H), "127d 14h");

  assert.equal(formatUptime(3660), "1h 1m");
  assert.equal(formatUptime(90), "1m");
  assert.equal(formatUptime(59), "59s");
  assert.equal(formatUptime(null), "");
});

test("the row policy answers a wired hub's rows from the entry the store established", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const state = store.snapshot();
  const device = state.devices.get("device1");

  assert.ok(device);

  const entry = selectDoorStates(state).get("door1");

  // The wiring pair reads live and the input reads closed, so the seeded entry answers both rows - and no tamper row rides a hub without the capability.
  assert.deepEqual(idValues(composeStatusRows({ device, entries: { main: { entry } }, kind: "device", state })), [ [ "lock", "Locked" ], [ "door", "Closed" ] ]);
});

test("the row policy degrades each absent or unwired reading to the placeholder dash", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const state = store.snapshot();
  const device = state.devices.get("device1");

  assert.ok(device);

  const entryOf = (members: Partial<AccessDoorStateEntry>): { entry: AccessDoorStateEntry } => ({ entry: { location_id: "door1", ...members } });

  // An absent lock member degrades the lock row while the established position stands.
  assert.deepEqual(idValues(composeStatusRows({ device, entries: { main: entryOf({ dps: "close" }) }, kind: "device", state })),
    [ [ "lock", "" ], [ "door", "Closed" ] ]);

  // A dps of "none" - the controller positively reporting an unwired sensor - answers the door row exactly as an absent dps does: the two independent no-evidence
  // readings degrade identically.
  assert.deepEqual(idValues(composeStatusRows({ device, entries: { main: entryOf({ dps: "none", lock: "locked" }) }, kind: "device", state })),
    [ [ "lock", "Locked" ], [ "door", "" ] ]);
  assert.deepEqual(idValues(composeStatusRows({ device, entries: { main: entryOf({ lock: "locked" }) }, kind: "device", state })),
    [ [ "lock", "Locked" ], [ "door", "" ] ]);
});

test("the row policy refuses a rex-configured Ultra's door row and serves a dps-configured one", () => {

  const store = createStateStore({});
  const ultra = (mode: string): Record<string, unknown> => bareHub("device1", MAC_ONE, {

    device_type: "UA-ULTRA",
    extensions: [{ extension_name: "port_setting", target_config: [{ config_key: "rex_button_mode", config_tag: "device_setting", config_value: mode }],
      target_name: "port1" }]
  });

  // The entry deliberately CARRIES dps evidence in both arms, so a uniform evidence read - one that ignores the input multiplex - would answer the rex arm live
  // and go red here rather than diverging silently.
  const entry = { dps: "open", location_id: "door1" } as never;

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [ultra("rex")], id: "door1" }]) });

  const rexState = store.snapshot();
  const rexDevice = rexState.devices.get("device1");

  assert.ok(rexDevice);
  assert.deepEqual(idValues(composeStatusRows({ device: rexDevice, entries: { main: { entry } }, kind: "device", state: rexState })),
    [ [ "lock", "" ], [ "door", "" ] ]);

  const dpsStore = createStateStore({});

  dpsStore.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [ultra("dps")], id: "door1" }]) });

  const dpsState = dpsStore.snapshot();
  const dpsDevice = dpsState.devices.get("device1");

  assert.ok(dpsDevice);
  assert.deepEqual(idValues(composeStatusRows({ device: dpsDevice, entries: { main: { entry } }, kind: "device", state: dpsState })),
    [ [ "lock", "" ], [ "door", "Open" ] ]);
});

test("the row policy answers the tamper row all three ways", () => {

  const store = createStateStore({});
  const tamperHub = (rows: Record<string, string>): Record<string, unknown> => bareHub("device1", MAC_ONE, {

    capabilities: [ "is_hub", "tamper_proofing" ],
    configs: configs("device1", rows)
  });

  const rowsFor = (record: Record<string, unknown>): string[][] => {

    store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [record], id: "door1" }]) });

    const state = store.snapshot();
    const device = state.devices.get("device1");

    assert.ok(device);

    return idValues(composeStatusRows({ device, entries: {}, kind: "device", state }));
  };

  // Reported tampering, reported none, and never reported: the third state is tamperState's own boolean-or-undefined contract and renders the dash.
  assert.deepEqual(rowsFor(tamperHub({ "tamper_event": "true" })), [ [ "lock", "" ], [ "door", "" ], [ "tamper", "Detected" ] ]);
  assert.deepEqual(rowsFor(tamperHub({ "tamper_event": "false" })), [ [ "lock", "" ], [ "door", "" ], [ "tamper", "Normal" ] ]);
  assert.deepEqual(rowsFor(tamperHub({})), [ [ "lock", "" ], [ "door", "" ], [ "tamper", "" ] ]);
});

test("the row policy assigns a UA Gate's four rows to the doors their roles name", () => {

  const store = createStateStore({});
  const gate = bareHub("device1", MAC_ONE, { device_type: "UGT" });

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [gate], id: "door1" }]) });

  const state = store.snapshot();
  const device = state.devices.get("device1");

  assert.ok(device);

  // The main and side doors carry DIFFERENT lock and dps values, so a main/side swap is a red test rather than an invisible pass.
  const rows = composeStatusRows({ device, entries: {

    main: { entry: { dps: "open", location_id: "door1", lock: "unlocked" } },
    side: { entry: { dps: "close", location_id: "door2", lock: "locked" } }
  }, kind: "device", state });

  assert.deepEqual(idValues(rows), [ [ "lock", "Unlocked" ], [ "door", "Open" ], [ "sidelock", "Locked" ], [ "sidedoor", "Closed" ] ]);

  // The gate's labels name what the hardware drives.
  assert.deepEqual(rows.map((row) => row.label), [ "Lock", "Gate", "Side door lock", "Side door" ]);

  // Without a discovered side door, the side pair is absent rather than dashed.
  assert.deepEqual(idValues(composeStatusRows({ device, entries: { main: { entry: undefined } }, kind: "device", state })),
    [ [ "lock", "" ], [ "door", "" ] ]);
});

test("the row policy answers a reader its access methods row alone and the API and uptime rows for the controller", () => {

  const store = createStateStore({});
  const record = reader("reader1", MAC_TWO);

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [record], id: "door1" }]) });

  const state = store.snapshot();
  const device = state.devices.get("reader1");

  assert.ok(device);

  // A reader carries no door state, so the methods row is the whole of its row set - here composed for hardware offering no method at all, which renders as the
  // placeholder dash rather than as no row.
  assert.deepEqual(composeStatusRows({ device, entries: {}, kind: "device", state }),
    [{ choices: [], id: "methods", kind: "choices", label: "Access Methods" }]);

  // The controller arm before any controller document answers the API row followed by the uptime row's honest absence, and the order is asserted rather than
  // incidental: the API row leads the controller's row set.
  assert.deepEqual(idValues(composeStatusRows({ kind: "controller", mode: "dual", state })), [ [ "api", "Credentials + API token" ], [ "uptime", "" ] ]);

  // ...and a fetched document answers the rendered uptime.
  store.applyRefreshDocuments({ controller: { host: { uptime: UPTIME_127D_14H } } as unknown as AccessControllerConfig,
    topology: doorsTopology([{ devices: [record], id: "door1" }]) });
  assert.deepEqual(idValues(composeStatusRows({ kind: "controller", mode: "dual", state: store.snapshot() })),
    [ [ "api", "Credentials + API token" ], [ "uptime", "127d 14h" ] ]);
});

test("the access methods row states what the record's configuration rows say, in the catalog's own order", () => {

  const store = createStateStore({});

  /* The capabilities are deliberately out of catalog order and the configuration rows are reversed out of it, so the rendered order proves it comes from the
   * catalog rather than from whatever order the record happened to list.
   */
  const record = reader("reader1", MAC_TWO, { capabilities: [ "qr_code", "is_reader", "pin_code", "nfc_card_easy_provision" ],
    configs: configs("reader1", { "nfc": "yes", "pin_code": "yes", "qr_code": "no" }).reverse() });

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [record], id: "door1" }]) });

  const state = store.snapshot();
  const device = state.devices.get("reader1");

  assert.ok(device);

  // The whole row rather than a projection of it: the label the panel renders, the tag that makes it the choices form, and no width reservation at all - the
  // rendered list is its own.
  assert.deepEqual(composeStatusRows({ device, entries: {}, kind: "device", state }), [{

    choices: [ { label: "NFC", selected: true }, { label: "PIN", selected: true }, { label: "QR Code", selected: false } ],
    id: "methods",
    kind: "choices",
    label: "Access Methods"
  }]);
});

test("the access methods row lists only the methods the hardware's capabilities carry", () => {

  const store = createStateStore({});
  const rowsFor = (record: Record<string, unknown>): string[][] => {

    store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [record], id: "door1" }]) });

    const state = store.snapshot();
    const device = state.devices.get("reader1");

    assert.ok(device);

    return idValues(composeStatusRows({ device, entries: {}, kind: "device", state }));
  };

  // Every one of these rows says yes, so what the list leaves out is decided by the capabilities alone.
  const enabled = { "bt_button": "yes", "face": "yes", "nfc": "yes", "pin_code": "yes" };

  assert.deepEqual(rowsFor(reader("reader1", MAC_TWO, { capabilities: [ "is_reader", "pin_code" ], configs: configs("reader1", enabled) })),
    [[ "methods", "[x] PIN" ]]);

  // The array-form capability names a family rather than a flag: either member offers the one Mobile switch, so either member lists it.
  assert.deepEqual(rowsFor(reader("reader1", MAC_TWO, { capabilities: [ "is_reader", "mobile_unlock_ver2" ], configs: configs("reader1", enabled) })),
    [[ "methods", "[x] Mobile" ]]);
  assert.deepEqual(rowsFor(reader("reader1", MAC_TWO, { capabilities: [ "is_reader", "support_mobile_unlock" ], configs: configs("reader1", enabled) })),
    [[ "methods", "[x] Mobile" ]]);
});

test("the access methods row omits a method the record never mentioned, and no other hardware composes one", () => {

  const store = createStateStore({});
  const rowsFor = (record: Record<string, unknown>, id: string): string[][] => {

    store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [record], id: "door1" }]) });

    const state = store.snapshot();
    const device = state.devices.get(id);

    assert.ok(device);

    return idValues(composeStatusRows({ device, entries: {}, kind: "device", state }));
  };

  const capable = [ "is_reader", "nfc_card_easy_provision", "pin_code" ];

  // The hardware offers both methods and the record's rows mention neither, so neither is listed: an unchecked box would state a reading the controller never
  // made. The row is composed all the same, and its empty list is what the panel renders as the placeholder dash.
  assert.deepEqual(rowsFor(reader("reader1", MAC_TWO, { capabilities: capable }), "reader1"), [[ "methods", "" ]]);

  // One row resolving speaks for that method alone - the method the rows still do not mention stays absent rather than reading off.
  assert.deepEqual(rowsFor(reader("reader1", MAC_TWO, { capabilities: capable, configs: configs("reader1", { "nfc": "no" }) }), "reader1"),
    [[ "methods", "[ ] NFC" ]]);

  // Hardware that reads no credentials composes no methods row at all, whatever its configuration rows happen to carry.
  assert.deepEqual(rowsFor(bareHub("device1", MAC_ONE, { capabilities: [ "is_hub", "pin_code" ], configs: configs("device1", { "pin_code": "yes" }) }), "device1"),
    [ [ "lock", "" ], [ "door", "" ] ]);
});

test("a hub that is also a reader carries its access methods beneath its door rows", () => {

  const store = createStateStore({});
  const hubReader = wiredHub("device1", MAC_ONE, { capabilities: [ "is_hub", "dps_alarm", "is_reader", "pin_code" ],
    configs: configs("device1", { "input_state_dps": "on", "input_state_rly-lock_dry": "off", "pin_code": "yes", "wiring_state_dps-neg": "on",
      "wiring_state_dps-pos": "on" }) });

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [hubReader], id: "door1" }]) });

  const state = store.snapshot();
  const device = state.devices.get("device1");

  assert.ok(device);

  // The rows the door drives still lead the set exactly as they do for a hub that reads no credentials, and the methods row follows them.
  assert.deepEqual(idValues(composeStatusRows({ device, entries: { main: { entry: selectDoorStates(state).get("door1") } }, kind: "device", state })),
    [ [ "lock", "Locked" ], [ "door", "Closed" ], [ "methods", "[x] PIN" ] ]);
});

test("the API row renders every mode the library reports and reserves the widest of them", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const state = store.snapshot();
  const modes = [ "credential", "dual", "token" ] as const;
  const rowsFor = (mode: AccessApiMode): string[][] => idValues(composeStatusRows({ kind: "controller", mode, state }));

  // Each mode reads as the surfaces its connect proved: both identity legs, credentials alone, or the token alone. The token arm is unreachable from the panel
  // today - a token-only connect yields no controller entry to view - and it is mapped anyway, because the vocabulary belongs to the library.
  assert.deepEqual(rowsFor("dual"), [ [ "api", "Credentials + API token" ], [ "uptime", "" ] ]);
  assert.deepEqual(rowsFor("credential"), [ [ "api", "Credentials" ], [ "uptime", "" ] ]);
  assert.deepEqual(rowsFor("token"), [ [ "api", "API token" ], [ "uptime", "" ] ]);

  // The row's width reservation covers every value it can render, which is what keeps the column from resizing when a controller connects with different legs than
  // the one the panel sized against.
  for(const mode of modes) {

    const row = composeStatusRows({ kind: "controller", mode, state })[0];

    assert.ok(row);
    assert.equal(row.id, "api");

    // The API row is a text row, and stating that here is what reaches its width reservation: only the text form declares one.
    assert.ok(row.kind !== "choices", "the API row must compose in the text form");
    assert.ok(row.sizer.length >= row.value.length, "the API row's sizer must reserve at least the width of every value the row renders");
  }
});

test("a view resolves through the registry, pushes the snapshot and truth frame, and streams the live rows", async () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([
    { devices: [wiredHub("device1", MAC_ONE)], id: "door1" },
    { devices: [wiredHub("device2", MAC_TWO)], id: "door2" }
  ]) });

  const record = store.snapshot().devices.get("device1");
  const { client } = makeClient(store, [{ doorId: "door1", record }]);
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([ SERIAL_ONE, SERIAL_TWO ]));

  await feed.view(SERIAL_ONE);
  await settle();

  // The establishment sequence: connecting, the snapshot, and the immediate availability truth frame - and every frame carries the decorated serial, never the
  // colon-bearing MAC the fixture record spells.
  const establishment = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(establishment.map((frame) => frame.kind), [ "connecting", "snapshot", "availability" ]);

  const snapshot = frameOf(establishment, 1, "snapshot");

  assert.deepEqual(idValues(snapshot.rows), [ [ "lock", "Locked" ], [ "door", "Closed" ] ]);
  assert.equal(snapshot.encrypted, true);

  const truth = frameOf(establishment, 2, "availability");

  assert.equal(truth.online, true);

  // The live push path: a door-state change through the real store surfaces as a row frame with the changed value alone.
  frames.length = 0;
  store.dispatch(doorEvent("door1", { dps: "open", dps_connected: true, lock: "locked" }));
  await settle();

  const doorFrames = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(doorFrames.map((frame) => frame.kind), ["row"]);
  assert.deepEqual(frameOf(doorFrames, 0, "row").row, { id: "door", value: "Open" });

  // An is_online flip on the viewed device's record surfaces as an availability frame.
  frames.length = 0;
  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([
    { devices: [wiredHub("device1", MAC_ONE, { is_online: false })], id: "door1" },
    { devices: [wiredHub("device2", MAC_TWO)], id: "door2" }
  ]) });
  await settle();

  const flip = forSerial(frames, SERIAL_ONE).filter((frame) => frame.kind === "availability");

  assert.equal(flip.length, 1);

  const offline = frameOf(flip, 0, "availability");

  assert.equal(offline.online, false);
  assert.equal(offline.encrypted, false);

  // An unrelated door's change wakes nothing: the per-entry selector rides the reducer's reference stability, so the viewed serial stays silent.
  frames.length = 0;
  store.dispatch(doorEvent("door2", { dps: "open", dps_connected: true, lock: "unlocked" }));
  await settle();

  assert.deepEqual(forSerial(frames, SERIAL_ONE), []);
});

test("a row set that grows mid-view is pushed as a fresh snapshot, where a value moving inside a fixed set rides a row frame", async () => {

  const store = createStateStore({});
  const tamperCapable = { capabilities: [ "is_hub", "dps_alarm", "tamper_proofing" ] };

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const record = store.snapshot().devices.get("device1");
  const { client } = makeClient(store, [{ doorId: "door1", record }]);
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([SERIAL_ONE]));

  await feed.view(SERIAL_ONE);
  await settle();

  // The set the view established, which is what every push below is a delta against.
  assert.deepEqual(idValues(frameOf(forSerial(frames, SERIAL_ONE), 1, "snapshot").rows), [ [ "lock", "Locked" ], [ "door", "Closed" ] ]);

  /* The hardware gains the tamper capability, which is a row appearing rather than a reading moving. The wire speaks id-and-value on an update, so a row the panel
   * has never been told about can only reach it as a full set...a per-row diff would address the new row by an index the panel holds nothing at.
   */
  frames.length = 0;
  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE, tamperCapable)], id: "door1" }]) });
  await settle();

  const grown = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(grown.map((frame) => frame.kind), ["snapshot"], "a changed row set is pushed whole rather than as per-row diffs");
  assert.deepEqual(idValues(frameOf(grown, 0, "snapshot").rows), [ [ "lock", "Locked" ], [ "door", "Closed" ], [ "tamper", "" ] ],
    "and the fresh snapshot carries the row the capability made renderable");

  /* The other half of the same recompute, driven against the set the snapshot above just established: a reading that moves inside a set whose ids are unchanged
   * takes the per-row path. Without it, an implementation that pushed a snapshot for every recompute would pass the half above on its own.
   */
  frames.length = 0;
  store.dispatch(doorEvent("door1", { dps: "open", dps_connected: true, lock: "locked" }));
  await settle();

  const moved = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(moved.map((frame) => frame.kind), ["row"], "a value moving within a fixed row set stays on the per-row path");
  assert.deepEqual(frameOf(moved, 0, "row").row, { id: "door", value: "Open" });
});

test("a configuration row change on a reader's methods surfaces as the choices arm's whole replacement list", async () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [reader("reader1", MAC_ONE, {

    capabilities: [ "is_reader", "nfc_card_easy_provision", "pin_code" ],
    configs: configs("reader1", { "nfc": "yes", "pin_code": "no" })
  })], id: "door1" }]) });

  const { client } = makeClient(store);
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([SERIAL_ONE]));

  await feed.view(SERIAL_ONE);
  await settle();

  // The set the view established, which the change below is a delta against.
  assert.deepEqual(idValues(frameOf(forSerial(frames, SERIAL_ONE), 1, "snapshot").rows), [[ "methods", "[x] NFC [ ] PIN" ]]);

  /* The controller enables the PIN method. That is a value moving inside a row set whose ids did not change, so it takes the per-row path - and the choices form's
   * update carries the WHOLE replacement list rather than the one entry that moved, because addressing an entry inside the list is not something the wire offers.
   */
  frames.length = 0;
  store.dispatch(deviceConfigsEvent("reader1", { "nfc": "yes", "pin_code": "yes" }));
  await settle();

  const moved = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(moved.map((frame) => frame.kind), ["row"]);
  assert.deepEqual(frameOf(moved, 0, "row").row, { choices: [ { label: "NFC", selected: true }, { label: "PIN", selected: true } ], id: "methods" });

  /* A row the methods list does not read changes on the same record. The record itself moves, so the recompute runs - and the list it composes is identical, so
   * the panel is left alone rather than told to redraw a list it already holds.
   */
  frames.length = 0;
  store.dispatch(deviceConfigsEvent("reader1", { "nfc": "yes", "pin_code": "yes", "tamper_event": "false" }));
  await settle();

  assert.deepEqual(forSerial(frames, SERIAL_ONE), []);
});

test("one port of an Enterprise hub gets a view of its own, and the hub that hosts it gets none", async () => {

  const store = createStateStore({});

  /* A plain hub on one door and a building-hosted Enterprise hub on the other. The Enterprise record carries the building as its location, which is the shape the
   * library classifies as building-hosted, so what this plugin projects is the hub's port rather than the hub - and a view has to follow that split exactly.
   */
  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([
    { devices: [wiredHub("device1", MAC_ONE)], id: "door1" },
    { devices: [wiredHub("device2", MAC_TWO, { device_type: "UAH-Ent",
      extensions: [{ device_id: "device2", extension_name: "port_setting", source_id: "port1", target_config: [], target_name: "Front Door", target_type: "door",
        target_value: "door2", unique_id: "port-2-1" }],
      location_id: ROOT_ID })], id: "door2" }
  ]) });

  const record = store.snapshot().devices.get("device1");
  const port = selectAccessPoints(store.snapshot()).find((candidate) => candidate.unique_id === "port-2-1");

  assert.ok(port, "the library must synthesize the Enterprise hub's port, which is the device this whole arm is about");

  const { client } = makeClient(store, [ { doorId: "door1", record }, { doorId: "door2", port: true, record: port } ]);
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  // All three serials are registered, so every view below reaches the resolution layer rather than stopping at the registry's not-found gate.
  feed.context(contextRequest([ SERIAL_ONE, SERIAL_TWO + "-PORT1", SERIAL_TWO ]));

  await feed.view(SERIAL_TWO + "-PORT1");
  await settle();

  const establishment = forSerial(frames, SERIAL_TWO + "-PORT1");

  assert.deepEqual(establishment.map((frame) => frame.kind), [ "connecting", "snapshot", "availability" ]);

  // The port's own door, resolved through the handle the client answers for the port's identity - the same rows a plain hub's view carries for its door.
  const snapshot = frameOf(establishment, 1, "snapshot");

  assert.deepEqual(idValues(snapshot.rows), [ [ "lock", "Locked" ], [ "door", "Closed" ] ]);

  /* The port's own liveness. A port's identity is never a key in the raw devices map, so a liveness read left on that map answers undefined here and reports an
   * online port offline - at establishment and on every reboot or recovery repush.
   */
  const truth = frameOf(establishment, 2, "availability");

  assert.equal(truth.online, true);

  // The other hub's door moving wakes nothing here: the port view observes its own door and its own record, and neither of them moved.
  frames.length = 0;
  store.dispatch(doorEvent("door1", { dps: "open", dps_connected: true, lock: "unlocked" }));
  await settle();

  assert.deepEqual(forSerial(frames, SERIAL_TWO + "-PORT1"), [], "an unrelated door's change must leave a port's view silent");

  // The hosting hub's own serial resolves no member, because the plugin projects no device for it. The view still establishes - the panel answers whatever it can
  // for a serial the registry knows - but it carries none of the rows the parent's own record would answer, which is what a resolution still scanning the raw
  // devices map would hand back instead.
  frames.length = 0;
  await feed.view(SERIAL_TWO);
  await settle();

  const parent = forSerial(frames, SERIAL_TWO);

  // Both serials belong to one controller, so this view is served by the client the port's view already connected - the same-controller reuse - and establishes
  // without a connecting frame of its own.
  assert.deepEqual(parent.map((frame) => frame.kind), [ "snapshot", "availability" ]);
  assert.deepEqual(idValues(frameOf(parent, 0, "snapshot").rows), []);

  // The degraded shape a token-only client's views take, described rather than checked: a view holding no record answers the serving connection's own liveness.
  assert.equal(frameOf(parent, 1, "availability").online, true);
});

test("the truth frame reports both liveness polarities the moment the snapshot lands", async () => {

  // The offline polarity: a device already offline at selection must read offline at once rather than resting on a Connected label.
  const offlineStore = createStateStore({});

  offlineStore.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE, { is_online: false })], id: "door1" }]) });

  const offlineRecord = offlineStore.snapshot().devices.get("device1");
  const offlineRig = makeClient(offlineStore, [{ doorId: "door1", record: offlineRecord }]);
  const offlineFrames: StatusEvent[] = [];
  const offlineFeed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => offlineRig.client, log: noopLog,
    push: (event) => void offlineFrames.push(event) });

  offlineFeed.context(contextRequest([SERIAL_ONE]));
  await offlineFeed.view(SERIAL_ONE);

  const offline = forSerial(offlineFrames, SERIAL_ONE);

  assert.deepEqual(offline.map((frame) => frame.kind), [ "connecting", "snapshot", "availability" ]);

  const offlineTruth = frameOf(offline, 2, "availability");

  assert.equal(offlineTruth.online, false);
  assert.equal(offlineTruth.encrypted, false);

  // The online polarity, through a registry entry carrying verifyTls false: certificate verification and transport encryption are different facts, so the
  // snapshot and availability frames still assert encrypted EXACTLY true - an implementation deriving encrypted from verifyTls goes red here.
  const onlineStore = createStateStore({});

  onlineStore.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const onlineRecord = onlineStore.snapshot().devices.get("device1");
  const onlineRig = makeClient(onlineStore, [{ doorId: "door1", record: onlineRecord }]);
  const onlineFrames: StatusEvent[] = [];
  const onlineFeed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => onlineRig.client, log: noopLog,
    push: (event) => void onlineFrames.push(event) });

  onlineFeed.context(contextRequest([SERIAL_ONE], { verifyTls: false }));
  await onlineFeed.view(SERIAL_ONE);

  const online = forSerial(onlineFrames, SERIAL_ONE);

  assert.deepEqual(online.map((frame) => frame.kind), [ "connecting", "snapshot", "availability" ]);
  assert.equal(frameOf(online, 1, "snapshot").encrypted, true);

  const onlineTruth = frameOf(online, 2, "availability");

  assert.equal(onlineTruth.online, true);
  assert.equal(onlineTruth.encrypted, true);
});

test("a superseded establish emits nothing for its session and releases the client it made", async () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const record = store.snapshot().devices.get("device1");
  const { client, disposeCount } = makeClient(store, [{ doorId: "door1", record }]);
  const frames: StatusEvent[] = [];

  const gate = Promise.withResolvers<boolean>();

  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => {

    await gate.promise;

    return client;
  }, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([SERIAL_ONE]));

  // The establish parks at the gated connect; a view switch supersedes it before its snapshot ever pushes.
  const first = feed.view(SERIAL_ONE);

  await settle();
  await feed.view("UNKNOWN0001");

  gate.resolve(true);
  await first;
  await settle();

  // The old session got exactly its connecting frame - everything after the supersession dropped at the emit chokepoint - and the stale establish released the
  // client it made rather than leaking it.
  assert.deepEqual(forSerial(frames, SERIAL_ONE).map((frame) => frame.kind), ["connecting"]);
  assert.equal(disposeCount(), 1);

  // The bypass polarity that keeps the pin non-vacuous: the same sequence WITHOUT the supersession pushes the snapshot.
  const plainFrames: StatusEvent[] = [];
  const plainRig = makeClient(store, [{ doorId: "door1", record }]);
  const plainFeed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => plainRig.client, log: noopLog,
    push: (event) => void plainFrames.push(event) });

  plainFeed.context(contextRequest([SERIAL_ONE]));
  await plainFeed.view(SERIAL_ONE);

  assert.deepEqual(forSerial(plainFrames, SERIAL_ONE).map((frame) => frame.kind), [ "connecting", "snapshot", "availability" ]);
});

test("a within-controller switch reuses the client, re-resolves the doors, and silences the old view", async () => {

  const store = createStateStore({});

  // Hub two is deliberately bare, its door state arriving only by notification, so its door values are provably distinct from hub one's wired seed.
  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([
    { devices: [wiredHub("device1", MAC_ONE)], id: "door1" },
    { devices: [bareHub("device2", MAC_TWO)], id: "door2" }
  ]) });
  store.dispatch(doorEvent("door2", { dps: "open", dps_connected: true, lock: "unlocked" }));

  const one = store.snapshot().devices.get("device1");
  const two = store.snapshot().devices.get("device2");
  const { client, disposeCount } = makeClient(store, [ { doorId: "door1", record: one }, { doorId: "door2", record: two } ]);
  const frames: StatusEvent[] = [];

  let connects = 0;

  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => {

    connects++;

    return client;
  }, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([ SERIAL_ONE, SERIAL_TWO ]));

  await feed.view(SERIAL_ONE);
  await settle();

  frames.length = 0;
  await feed.view(SERIAL_TWO);
  await settle();

  // The client is the reuse - one connect across the switch, nothing released - while the resolution is not: the post-switch snapshot carries the NEW device's
  // door values, which is what proves the reuse branch re-resolved rather than carrying the prior view's doors.
  assert.equal(connects, 1);
  assert.equal(disposeCount(), 0);

  const switched = forSerial(frames, SERIAL_TWO);

  assert.deepEqual(switched.map((frame) => frame.kind), [ "snapshot", "availability" ]);
  assert.deepEqual(idValues(frameOf(switched, 0, "snapshot").rows), [ [ "lock", "Unlocked" ], [ "door", "Open" ] ]);

  // The old view's loops are retired: a mutation on the OLD device's door emits nothing at all, for either serial.
  frames.length = 0;
  store.dispatch(doorEvent("door1", { dps: "open", dps_connected: true, lock: "locked" }));
  await settle();

  assert.deepEqual(frames, []);

  // The new view's loops are live: the NEW device's door answers with its row frame.
  store.dispatch(doorEvent("door2", { dps: "close", dps_connected: true, lock: "unlocked" }));
  await settle();

  const fresh = forSerial(frames, SERIAL_TWO);

  assert.deepEqual(fresh.map((frame) => frame.kind), ["row"]);
  assert.deepEqual(frameOf(fresh, 0, "row").row, { id: "door", value: "Closed" });
});

test("a view for a serial the registry dropped releases the standing client and answers not-found", async () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const record = store.snapshot().devices.get("device1");
  const { client, disposeCount } = makeClient(store, [{ doorId: "door1", record }]);
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([ SERIAL_ONE, SERIAL_TWO ]));
  await feed.view(SERIAL_ONE);
  await settle();

  // The context rebuild drops the viewed serial - a removal's send does exactly this - and the next view of it finds nothing.
  feed.context(contextRequest([SERIAL_TWO]));
  frames.length = 0;
  await feed.view(SERIAL_ONE);
  await settle();

  const answer = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(answer.map((frame) => frame.kind), ["error"]);
  assert.equal(frameOf(answer, 0, "error").reason, "not-found");
  assert.equal(disposeCount(), 1);
});

test("the view contract answers not-found for an unregistered serial and auth-missing for an identity the composition refuses", async () => {

  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => {

    throw new Error("The connect port must never be reached in this arm.");
  }, log: noopLog, push: (event) => void frames.push(event) });

  // No context at all: the very first view answers not-found.
  await feed.view(SERIAL_ONE);

  const missing = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(missing.map((frame) => frame.kind), ["error"]);
  assert.equal(frameOf(missing, 0, "error").reason, "not-found");

  // A registry entry whose identity the composition refuses - a username with no password - answers auth-missing without attempting a connect.
  feed.context(contextRequest([SERIAL_ONE], { password: undefined }));
  frames.length = 0;
  await feed.view(SERIAL_ONE);

  const refused = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(refused.map((frame) => frame.kind), [ "connecting", "error" ]);
  assert.equal(frameOf(refused, 1, "error").reason, "auth-missing");
});

test("every frame carries the decorated serial whatever spelling the boundary received", async () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const record = store.snapshot().devices.get("device1");
  const { client } = makeClient(store, [{ doorId: "door1", record }]);
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  // The context boundary re-normalizes: a registry send carrying the colon-bearing MAC spelling still keys the decorated form...
  feed.context(contextRequest([MAC_ONE]));

  // ...and the view boundary re-normalizes symmetrically: a colon-bearing view request resolves that entry and emits normally.
  await feed.view(MAC_ONE);
  await settle();

  const emitted = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(emitted.map((frame) => frame.kind), [ "connecting", "snapshot", "availability" ]);

  // No frame anywhere carries a colon-bearing identity.
  assert.equal(frames.every((frame) => !("serialNumber" in frame) || !frame.serialNumber.includes(":")), true);
});

test("the connection wiring emits only the offline truth on lost and re-pushes state on recovery and reboot", async () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const record = store.snapshot().devices.get("device1");
  const { client, connection } = makeClient(store, [{ doorId: "door1", record }]);
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([SERIAL_ONE]));
  await feed.view(SERIAL_ONE);
  await settle();

  // A lost controller makes the device's liveness unknown: exactly one offline availability frame, and no snapshot claiming state knowledge the feed lacks.
  frames.length = 0;
  connection.fire("controllerLost");

  let wired = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(wired.map((frame) => frame.kind), ["availability"]);
  assert.equal(frameOf(wired, 0, "availability").online, false);

  // Recovery re-pushes the snapshot plus the truth frame, because state may have moved while the connection was down.
  frames.length = 0;
  connection.fire("controllerRecovered");

  wired = forSerial(frames, SERIAL_ONE);
  assert.deepEqual(wired.map((frame) => frame.kind), [ "snapshot", "availability" ]);
  assert.equal(frameOf(wired, 1, "availability").online, true);

  // A detected reboot re-pushes the same pair, since a rebooted controller's state may have reset without ever reading lost.
  frames.length = 0;
  connection.fire("controllerRebooted");

  wired = forSerial(frames, SERIAL_ONE);
  assert.deepEqual(wired.map((frame) => frame.kind), [ "snapshot", "availability" ]);
});

test("a lost connection is never reused: the next view connects fresh and releases the husk", async () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([
    { devices: [wiredHub("device1", MAC_ONE)], id: "door1" },
    { devices: [wiredHub("device2", MAC_TWO)], id: "door2" }
  ]) });

  const one = store.snapshot().devices.get("device1");
  const two = store.snapshot().devices.get("device2");
  const first = makeClient(store, [ { doorId: "door1", record: one }, { doorId: "door2", record: two } ]);
  const second = makeClient(store, [ { doorId: "door1", record: one }, { doorId: "door2", record: two } ]);
  const clients = [ first.client, second.client ];
  const frames: StatusEvent[] = [];

  let connects = 0;

  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => {

    const client = clients[connects];

    connects++;
    assert.ok(client);

    return client;
  }, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([ SERIAL_ONE, SERIAL_TWO ]));
  await feed.view(SERIAL_ONE);
  await settle();

  // The standing connection dies; the next view of the same controller must connect fresh rather than reuse the husk.
  first.connection.state = "lost";
  await feed.view(SERIAL_TWO);
  await settle();

  assert.equal(connects, 2);
  assert.equal(first.disposeCount(), 1);
  assert.equal(second.disposeCount(), 0);
});

test("a controller-as-device view resolves only through the controllerSerial routing and answers the API and uptime rows", async () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: { host: { uptime: UPTIME_127D_14H } } as unknown as AccessControllerConfig,
    topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const record = store.snapshot().devices.get("device1");

  // The serving client reports a credential-only connect, which is deliberately NOT the value a hard-coded row would most plausibly carry: the API row's rendered
  // value has to come off this client's capabilities to match below.
  const { client } = makeClient(store, [{ doorId: "door1", record }], "credential");
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  // The console's serial rides ONLY the controllerSerial member - it is deliberately not in serials - so a feed without the controller routing answers not-found
  // here by construction. The colon-bearing spelling exercises the context boundary's normalization of this member too.
  feed.context(contextRequest([SERIAL_ONE], { controllerSerial: "aa:bb:cc:00:00:99" }));

  await feed.view("AABBCC000099");
  await settle();

  const answer = forSerial(frames, "AABBCC000099");

  assert.deepEqual(answer.map((frame) => frame.kind), [ "connecting", "snapshot", "availability" ]);

  // The pushed snapshot is where the whole path is observed at once: the call site reads the mode off the serving client, the derivation renders it, and the row
  // reaches the panel ahead of the uptime row. A call site that composed a controller view without the mode cannot produce this frame.
  assert.deepEqual(idValues(frameOf(answer, 1, "snapshot").rows), [ [ "api", "Credentials" ], [ "uptime", "127d 14h" ] ]);
});

test("a throwing door resolution degrades the view to absence and starts no door loop", async () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([{ devices: [wiredHub("device1", MAC_ONE)], id: "door1" }]) });

  const record = store.snapshot().devices.get("device1");

  // The hub handle's doorId getter throws the removal-window ReferenceError; the resolution absorbs it and resolves no door ids.
  const { client } = makeClient(store, [{ record, throwOnDoorId: true }]);
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([SERIAL_ONE]));
  await feed.view(SERIAL_ONE);
  await settle();

  // The view still pushes its snapshot, with the door and lock rows degraded to the placeholder dash.
  const establishment = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(establishment.map((frame) => frame.kind), [ "connecting", "snapshot", "availability" ]);
  assert.deepEqual(idValues(frameOf(establishment, 1, "snapshot").rows), [ [ "lock", "" ], [ "door", "" ] ]);

  // No door loop runs for an unresolved view: the viewed device's own door changing emits nothing.
  frames.length = 0;
  store.dispatch(doorEvent("door1", { dps: "open", dps_connected: true, lock: "unlocked" }));
  await settle();

  assert.deepEqual(forSerial(frames, SERIAL_ONE), []);
});

test("a UA Gate view drives the shared discovery through the live client and assigns each role its own door", async () => {

  const store = createStateStore({});
  const gate = bareHub("device1", MAC_ONE, {

    device_type: "UGT",
    door: { unique_id: "door1" },
    extensions: [{ extension_name: "port_setting", target_name: "oper2", target_value: "door2" }]
  });

  store.applyRefreshDocuments({ controller: null, topology: doorsTopology([ { devices: [gate], id: "door1" }, { devices: [], id: "door2" } ]) });

  // The two doors carry DIFFERENT values, so each row's value proves which door its role resolved to.
  store.dispatch(doorEvent("door1", { dps: "open", dps_connected: true, lock: "unlocked" }));
  store.dispatch(doorEvent("door2", { dps: "close", dps_connected: true, lock: "locked" }));

  const { client } = makeClient(store);
  const frames: StatusEvent[] = [];
  const feed = new AccessStatusFeed({ connect: async (): Promise<StatusFeedClient> => client, log: noopLog, push: (event) => void frames.push(event) });

  feed.context(contextRequest([SERIAL_ONE]));
  await feed.view(SERIAL_ONE);
  await settle();

  const answer = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(answer.map((frame) => frame.kind), [ "connecting", "snapshot", "availability" ]);
  assert.deepEqual(idValues(frameOf(answer, 1, "snapshot").rows), [ [ "lock", "Unlocked" ], [ "door", "Open" ], [ "sidelock", "Locked" ],
    [ "sidedoor", "Closed" ] ]);

  // Both role loops are live: the side door's change surfaces on the side rows alone.
  frames.length = 0;
  store.dispatch(doorEvent("door2", { dps: "open", dps_connected: true, lock: "locked" }));
  await settle();

  const sideFrames = forSerial(frames, SERIAL_ONE);

  assert.deepEqual(sideFrames.map((frame) => frame.kind), ["row"]);
  assert.deepEqual(frameOf(sideFrames, 0, "row").row, { id: "sidedoor", value: "Open" });
});
