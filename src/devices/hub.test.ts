/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hub.test.ts: Tests for the hub's door commands, its garage door opener, and the webhook delivery handlers and door-ownership predicate they share.
 *
 * The hub is stood up for real, over genuine HAP service and characteristic classes, because what these arms are about is a hub deciding whether a delivery names
 * one of its own doors - and that decision reads the same live projection and the same discovered door identities the running accessory does.
 *
 * Deliveries are driven through the handler the hub itself registered rather than by calling its methods directly, so the registration and the handler are proved
 * to agree on the event vocabulary rather than assumed to.
 */
/* eslint-disable camelcase */
import { ACCESS_DEVICE_UPDATE_EVENT, ACCESS_WEBHOOK_EVENT_PREFIX } from "../controller/events.ts";
import { ACCESS_WEBHOOK_EVENTS, ACCESS_WEBHOOK_EVENT_LIST } from "../settings.ts";
import { AccessCapabilityError, AccessOfficialApiError } from "unifi-access";
import type { AccessDevice as AccessDeviceProjection, AccessDoorStateEntry, AccessHub as AccessHubProjection, AccessStateDevice } from "unifi-access";
import { Characteristic, Service, uuid } from "@homebridge/hap-nodejs";
import { FeatureOptions, mqttGetTopic, mqttSetTopic } from "homebridge-plugin-utils";
import type { MqttPublishInit, MqttTopicEntry } from "homebridge-plugin-utils";
import { accessMethods, officialDeviceModel } from "../policy.ts";
import { featureOptionCategories, featureOptions } from "../options.ts";
import type { AccessAccessory } from "../types.ts";
import type { AccessController } from "../controller/controller.ts";
import { AccessHub } from "./hub.ts";
import { AccessReservedNames } from "../types.ts";
import { TestMqttClient } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { format } from "node:util";
import { mqttTopics } from "../mqtt.ts";
import { setImmediate as settle } from "node:timers/promises";
import test from "node:test";

// The door this hub drives, and the reader hanging off it, in the identities the live captures use.
const HUB_ID = "74acb9d55b9c";
const HUB_MAC = "aabbccddee01";
// The identity the plugin addresses this hub by, written as a literal so the assertion proves the spelling rather than agreeing with whatever the composition answers.
const HUB_SERIAL = "AABBCCDDEE01";
const MAIN_DOOR = "740785e0-ef1d-4a2b-a720-3c8804feea9c";
const SIDE_DOOR = "8f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
const READER_ID = "d8b3706bb73b";

// The identity every unlock this plugin sends names itself by, written as a literal so the assertions prove the spelling rather than agreeing with whatever the constant
// behind them answers.
const UNLOCK_ACTOR = { id: "homebridge-unifi-access", name: "Homebridge" };

// The pause the plugin gives HomeKit's own write before putting a refused characteristic back, and the delay a UA Gate's self-managed relock uses.
const REVERT_DELAY_MS = 50;
const RELOCK_DELAY_MS = 5000;

// The window a dispatched doorbell ring or cancel is given before the trigger switch settles back onto the ring state the controller reports.
const DOORBELL_RECONCILE_DELAY_MS = 5000;

// What the shared logger puts in front of every line a hub writes, so an arm reads the sentence a user reads rather than the format string behind it.
const LOG_PREFIX = "Test Hub [UA Hub]: ";

// The travel time the machine arms configure their doors with, and the window a UA Gate falls back to when nothing has been configured for it.
const TRAVEL_SECONDS = 12;
const TRAVEL_MS = 12000;
const GATE_TRAVEL_MS = 5000;

/* A managed hub record, with whatever the individual arm cares about layered over it.
 *
 * The configs default is an EMPTY ARRAY, which is a seeded-empty census - a record whose configuration was listed and mentioned no methods - not a rowless record.
 * An arm about the token-identity seed must override configs to undefined explicitly, or the model seeds synchronously from the empty census and the official
 * settings read under test never runs.
 */
function hubRecord(overrides: Record<string, unknown> = {}): AccessStateDevice & { mac: string } {

  return {

    alias: "",
    capabilities: [ "is_hub", "door_bell" ],
    configs: [],
    connected_uah_id: "",
    device_type: "UAH",
    is_adopted: true,
    is_connected: true,
    is_managed: true,
    is_online: true,
    location_id: MAIN_DOOR,
    mac: HUB_MAC,
    name: "UA-HUB-5B9C",
    unique_id: HUB_ID,
    ...overrides
  };
}

/* A HomeKit accessory over real HAP services: the lookups the plugin performs, backed by a plain list. The services are the genuine classes, so what the shared
 * service helpers do to them here is what they do in the field.
 */
function makeAccessory(services: Service[]): AccessAccessory {

  return {

    UUID: "uuid-" + HUB_ID,
    _associatedHAPAccessory: { displayName: "Test Hub" },
    addService: (service: Service): Service => {

      services.push(service);

      return service;
    },
    context: {},
    displayName: "Test Hub",
    getService: (target: { UUID: string }): Service | undefined => services.find(service => (service.UUID === target.UUID) && !service.subtype),
    getServiceById: (target: { UUID: string }, subtype: string): Service | undefined => {

      return services.find(service => (service.UUID === target.UUID) && (service.subtype === subtype));
    },
    removeService: (service: Service): void => void services.splice(services.indexOf(service), 1),
    services
  } as unknown as AccessAccessory;
}

// A door command the hub dispatched to the library, as the arm driving it sees it: the verb, the options it carried, and the rule a lock-rule command asked for.
interface RecordedCommand {

  options?: { actor?: { id: string; name: string }; doorId?: string };
  rule?: unknown;
  verb: string;
}

// What a stood-up hub looks like from a test's side: the hub itself, the deliveries and packets it can be handed, and what it commanded, published, and said.
interface HubHarness {

  commands: RecordedCommand[];
  debugs: string[];
  deliver: (event: string, delivery: unknown) => void;
  emit: (event: string, packet: unknown) => void;
  errors: string[];
  fetches: string[];
  // What the controller's connection answers about its own health, in a holder the client double reads live so an arm can move it under a hub that is already running.
  health: { isHealthy: boolean };
  hub: AccessHub;
  lines: string[];
  mqtt: TestMqttClient;
  mqttGet: (tail: string) => Promise<string | undefined>;
  mqttSet: (tail: string, value: string) => Promise<void>;
  publish: (entry: MqttTopicEntry, payload: string) => void;
  publishes: { init: MqttPublishInit | undefined; payload: string; topic: string }[];
  reconfigure: (entries: string[]) => void;
  release: () => void;
  requests: string[];
  // Every doorbell ring or cancel the hub dispatched through the official API, in the order it dispatched them.
  rings: { cancel: boolean; readerId: string }[];
  services: Service[];
  setDoorState: (entry: AccessDoorStateEntry) => void;
  updates: unknown[];
}

// What an arm varies about the hub it stands up: which identities the client behind it holds, how its dispatched commands answer, what the library's door
// resolution and door-state read answer, the topology doors a UA Gate discovers its own from, the user's settings, and the record the hub is adopted on.
interface HubOptions {

  credentials?: boolean;
  defer?: string;
  // The device roster the client's snapshot carries, keyed by unique_id, which is what the doorbell reader lookup searches.
  devices?: AccessStateDevice[];
  doorId?: string | (() => never);
  doorState?: AccessDoorStateEntry;
  /* The client's door state map, keyed by location id, which is the map every hub reads the doors it drives from. An arm names it to put the controller's
   * reading at odds with the relay rows its record carries, which is the only way an adoption-time disagreement can be expressed.
   */
  doorStates?: Map<string, AccessDoorStateEntry>;
  doors?: { name: string; unique_id: string }[];
  // The switch subtypes the accessory already carries when the hub is stood up, standing in for what a previous run left on it.
  existing?: string[];
  // A hub stood up with no door control surface at all, which is the state the base class admits through its optional handle.
  hubless?: boolean;
  official?: boolean;
  options?: string[];
  record?: AccessStateDevice & { mac: string };
  reject?: string[];
  rejectFrom?: number;
  // The error a doorbell ring or cancel rejects with, standing in for a controller that refuses the dispatch. The ring is recorded before it is thrown.
  ringRefusal?: Error;
  // What the official settings read answers, called with the ordinal of the read so an arm can answer a retry differently from the attempt that failed.
  settings?: (fetch: number) => Promise<unknown>;
  // The error an unlock naming an actor rejects with, standing in for a client that cannot carry the attribution. An unlock naming none is answered normally.
  unlockRefusal?: Error;
}

/* Stand up a real AccessHub over doubles for everything outside it.
 *
 * @param options - What this arm varies.
 *
 * @returns The hub, the way to hand it a delivery, and what it published and said.
 */
function makeHub(options: HubOptions = {}): HubHarness {

  const commands: RecordedCommand[] = [];
  const debugs: string[] = [];
  const errors: string[] = [];
  const fetches: string[] = [];
  const lines: string[] = [];
  const updates: unknown[] = [];
  const publishes: { init: MqttPublishInit | undefined; payload: string; topic: string }[] = [];
  const releases: (() => void)[] = [];
  const requests: string[] = [];
  const rings: { cancel: boolean; readerId: string }[] = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  const record = options.record ?? hubRecord();

  /* The client's door state map, which is where a hub reads every door it drives. An arm that named one door's entry has it keyed here under that entry's own
   * identity, so the single-door spelling and the whole-map spelling reach the hub through the one map the plugin actually reads.
   */
  const doorStates = options.doorStates ?? new Map<string, AccessDoorStateEntry>();

  if(options.doorState) {

    doorStates.set(options.doorState.location_id, options.doorState);
  }

  /* Every door command the hub dispatched, recorded before it answers. A verb the arm named as deferred hands back its own resolver rather than settling, which is
   * what lets an arm see what HomeKit was shown before the command behind it came back; a verb the arm named as refused rejects the way the library does.
   */
  const dispatch = async (command: RecordedCommand): Promise<void> => {

    commands.push(command);

    if(options.defer === command.verb) {

      await new Promise<void>(resolve => releases.push(resolve));
    }

    if(options.reject?.includes(command.verb) && (commands.length >= (options.rejectFrom ?? 1))) {

      throw new Error("The controller refused this command.");
    }

    /* A client that cannot carry an attribution refuses the unlock naming one and answers the retry that drops it, which is the shape the library presents to a
     * plugin whose identity holds no path to the published API. The refusal is recorded before it is thrown, so an arm counts what was dispatched rather than
     * what succeeded.
     */
    if(options.unlockRefusal && (command.options?.actor !== undefined)) {

      throw options.unlockRefusal;
    }
  };

  const hubProjection = {

    close: async (opts?: { doorId?: string }): Promise<void> => dispatch({ options: opts, verb: "close" }),
    get doorId(): string {

      if(typeof options.doorId === "function") {

        return options.doorId();
      }

      return options.doorId ?? MAIN_DOOR;
    },
    setLockRule: async (rule: unknown, opts?: { doorId?: string }): Promise<void> => dispatch({ options: opts, rule, verb: "setLockRule" }),
    stop: async (opts?: { doorId?: string }): Promise<void> => dispatch({ options: opts, verb: "stop" }),
    unlock: async (opts?: { actor?: { id: string; name: string }; doorId?: string }): Promise<void> => dispatch({ options: opts, verb: "unlock" })
  };

  /* The Access application's own endpoint, which only a credentialed client reaches. A token-only client holds none, which is what the UA Gate's location path
   * refuses and what every library command above absorbs on the caller's behalf.
   */
  const transport = options.credentials ? { request: async (endpoint: string, init: { method: string }): Promise<void> => void requests.push(init.method + " " +
    endpoint) } : null;

  /* The broker the hub registers against: the shipped recording double, which keeps every registration with the signal it was registered under and releases
   * it when that signal aborts, so an arm can read what the hub asked for and drive it without a broker. It reports into the harness's own sinks, so what the
   * double says about a publish it refused is read exactly where an arm reads everything else the run said.
   */
  const mqtt = new TestMqttClient({ log: {

    debug: (message: string, ...parameters: unknown[]): void => void debugs.push(format(message, ...parameters)),
    error: (message: string, ...parameters: unknown[]): void => void errors.push(format(message, ...parameters)),
    info: (message: string, ...parameters: unknown[]): void => void lines.push(format(message, ...parameters)),
    warn: (message: string, ...parameters: unknown[]): void => void debugs.push(format(message, ...parameters))
  } });

  const projection = { config: record, observe: async function *(): AsyncGenerator { /* nothing observes in these arms */ }, peek: (): undefined => undefined };

  const doors = new Map((options.doors ?? []).map(door => [ door.unique_id, door ]));
  const services: Service[] = (options.existing ?? []).map(subtype => new Service.Switch("Test Hub " + subtype, subtype));

  /* The official device surface, held only by a client an arm gave one to. The settings read is what seeds a reader whose record carries no configuration rows, the
   * settings write is what an access method switch dispatches, and the doorbell dispatch is what the trigger switch's manual direction sends, so each of them is
   * recorded: an arm counts the reads to tell one seed from two, reads the writes to see what a switch actually sent, and reads the dispatches to see which reader
   * was addressed and in which direction. An arm naming no answer of its own gets an empty settings map, which is what a hardware class offering no methods returns.
   */
  const official = options.official ? {

    devices: {

      fetchSettings: async (deviceId: string): Promise<unknown> => {

        fetches.push(deviceId);

        return options.settings?.(fetches.length) ?? { access_methods: {}, device_id: deviceId };
      },
      triggerDoorbell: async (readerId: string, opts?: { cancel?: boolean }): Promise<void> => {

        rings.push({ cancel: opts?.cancel === true, readerId });

        if(options.ringRefusal) {

          throw options.ringRefusal;
        }
      },
      updateSettings: async (deviceId: string, update: unknown): Promise<void> => void updates.push(update)
    }
  } : null;

  // The connection the availability composition reads its controller-wide half through, answering from a holder so an arm can move controller health mid-arm and see
  // what a live read makes of it.
  const health = { isHealthy: true };

  const connection = {

    get isHealthy(): boolean {

      return health.isHealthy;
    }
  };

  const controller = {

    client: { connection, doorStates, official,
      state: { snapshot: (): unknown => ({ devices: new Map((options.devices ?? []).map(device => [ device.unique_id, device ])), doors }) }, transport },
    config: { address: "1.2.3.4" },
    events: {

      off: (event: string): void => void handlers.delete(event),
      on: (event: string, handler: (payload: unknown) => void): void => void handlers.set(event, handler)
    },
    getDeviceName: (): string => "Test Hub [UA Hub]",
    id: undefined,
    log: { debug: (): void => undefined, error: (): void => undefined, info: (): void => undefined, warn: (): void => undefined },
    mqtt,
    mqttPublish: (topic: string, payload: string, init?: MqttPublishInit): void => {

      publishes.push({ init, payload, topic });
      mqtt.publishGuarded(topic, payload, init);
    },
    name: "Test Controller",
    ownershipKey: "1.2.3.4",
    platform: {

      api: { hap: { Characteristic, Service, uuid } },
      featureOptions: undefined as unknown as FeatureOptions,
      /* The lines are captured formatted, because what a user reads is the composed sentence rather than the format string and its arguments. The plugin's debug
       * output arrives on the warn sink, which is how the shared logger surfaces it without Homebridge's own debug flag, so that is where an arm reads it.
       */
      log: { error: (message: string, ...parameters: unknown[]): void => void errors.push(format(message, ...parameters)),
        info: (message: string, ...parameters: unknown[]): void => void lines.push(format(message, ...parameters)),
        warn: (message: string, ...parameters: unknown[]): void => void debugs.push(format(message, ...parameters)) }
    },
    resolveDeviceModel: (): string => "UA Hub",
    signal: new AbortController().signal,
    spawnLoop: (): void => undefined,
    uda: null
  };

  let featureEngine = new FeatureOptions(featureOptionCategories, featureOptions, options.options ?? []);

  controller.platform.featureOptions = featureEngine;

  const hub = new AccessHub(controller as unknown as AccessController, projection as unknown as AccessDeviceProjection, makeAccessory(services), record,
    options.hubless ? undefined : hubProjection as unknown as AccessHubProjection);

  // Construction narrates itself, and every arm below is about what a delivery or a write does rather than about what adoption said.
  debugs.length = 0;
  errors.length = 0;
  lines.length = 0;

  return {

    commands,
    debugs,
    deliver: (event: string, delivery: unknown): void => {

      const handler = handlers.get(ACCESS_WEBHOOK_EVENT_PREFIX + event);

      assert.ok(handler, "the hub should have registered a handler for " + event);
      handler(delivery);
    },
    emit: (event: string, packet: unknown): void => {

      const handler = handlers.get(event);

      assert.ok(handler, "the hub should have registered a handler for " + event);
      handler(packet);
    },
    errors,
    fetches,
    health,
    hub,
    lines,
    mqtt,
    mqttGet: async (tail: string): Promise<string | undefined> => mqtt.invokeGet(mqttGetTopic(HUB_SERIAL + "/" + tail)),
    mqttSet: async (tail: string, value: string): Promise<void> => mqtt.invokeSet(mqttSetTopic(HUB_SERIAL + "/" + tail), value),
    /* The device base's publish method is protected by design, so nothing outside the class hierarchy reaches it: this driver is the test's own hand on it, which
     * is what lets an arm issue a publish exactly as the hub's own code does.
     */
    publish: (entry: MqttTopicEntry, payload: string): void => {

      (hub as unknown as { mqttPublish: (entry: MqttTopicEntry, payload: string) => void }).mqttPublish(entry, payload);
    },
    publishes,
    /* Restate the user's settings under a hub that is already running, which is how a setting read afresh at each write is told apart from one cached at
     * construction. The engine is swapped rather than mutated, because that is what the platform itself does when a configuration is reloaded.
     */
    reconfigure: (entries: string[]): void => {

      featureEngine = new FeatureOptions(featureOptionCategories, featureOptions, entries);
      controller.platform.featureOptions = featureEngine;
    },
    release: (): void => {

      for(const resolve of releases.splice(0)) {

        resolve();
      }
    },
    requests,
    rings,
    services,
    setDoorState: (entry: AccessDoorStateEntry): void => void doorStates.set(entry.location_id, entry),
    updates
  };
}

// A UA Gate with both of its doors discovered and a credentialed client behind it, which is what the location endpoint behind its opening direction needs.
function makeGate(options: HubOptions = {}): HubHarness {

  return makeHub({ credentials: true, doors: [ { name: "Main Gate", unique_id: MAIN_DOOR }, { name: "Pedestrian Gate", unique_id: SIDE_DOOR } ],
    record: hubRecord({ device_type: "UGT" }), ...options });
}

// A door hub presenting its door as a garage door opener, which is the surface every momentary-operator arm drives.
function makeOpener(options: HubOptions = {}): HubHarness {

  return makeHub({ ...options, options: [ "Enable.Hub.Door.Service=GarageDoorOpener", ...options.options ?? [] ] });
}

// The same opener with a travel time configured for it, which is what puts the transition machine in play.
function makeTravellingOpener(options: HubOptions = {}): HubHarness {

  return makeOpener({ ...options, options: [ "Enable.Hub.Door.TransitionDuration." + HUB_SERIAL + "." + TRAVEL_SECONDS.toString(), ...options.options ?? [] ] });
}

// Every access method selected, which is what a reader arm about the model rather than the selection stands up: its switches then follow its capabilities alone.
const EVERY_ACCESS_METHOD = "Enable.AccessMethod.Switches=" + accessMethods.map(method => method.choice).join(",");

// A reader with every access method selected for a switch, so what its record and the controller say about each method is what its switches show.
function makeReader(options: HubOptions = {}): HubHarness {

  return makeHub({ ...options, options: [ EVERY_ACCESS_METHOD, ...options.options ?? [] ] });
}

// Hand a hub the door reading the controller's own door-state loop would deliver.
function deliverDoorState(harness: HubHarness, entry: AccessDoorStateEntry): void {

  harness.setDoorState(entry);
  harness.hub.refreshDoorState();
}

// Record every characteristic write a service receives, in the order it receives them, which is how one update is told from two.
function recordWrites(service: Service): { characteristic: string; value: unknown }[] {

  const writes: { characteristic: string; value: unknown }[] = [];
  const update = service.updateCharacteristic.bind(service) as (characteristic: unknown, value: unknown) => Service;

  (service as unknown as { updateCharacteristic: (characteristic: { UUID: string }, value: unknown) => Service }).updateCharacteristic =
    (characteristic: { UUID: string }, value: unknown): Service => {

      writes.push({ characteristic: characteristic.UUID, value });

      return update(characteristic, value);
    };

  return writes;
}

/* Every value a service delivered on its programmable switch event as an event notification, in the order it delivered them.
 *
 * The characteristic's change event carries the reason the value moved, and a notification sent for a press is the one reason that reads as an event...a plain
 * update of the same value reads as an update. Filtering on that is what lets an arm tell a press HomeKit was notified of from a value somebody merely wrote.
 *
 * @param service - The service whose programmable switch event to listen to.
 *
 * @returns The values delivered as event notifications, oldest first.
 */
function switchEvents(service: Service): unknown[] {

  const events: unknown[] = [];

  service.getCharacteristic(Characteristic.ProgrammableSwitchEvent).on("change", (change): void => {

    /* The reason is typed as an ambient const enum, which this project's module settings forbid naming from another module, so the comparison is written against the
     * string that enum member carries. The string is part of the characteristic's published change contract rather than an internal spelling of it.
     */
    if((change.reason as string) === "event") {

      events.push(change.newValue);
    }
  });

  return events;
}

// The garage door opener a hub configured for its own door.
function openerService(harness: HubHarness): Service {

  const service = harness.services.find(entry => (entry.UUID === Service.GarageDoorOpener.UUID) && !entry.subtype);

  assert.ok(service, "the hub should have configured a garage door opener");

  return service;
}

// The lock a hub configured, for its own door or for a UA Gate's side door.
function lockService(harness: HubHarness, subtype?: string): Service {

  const service = harness.services.find(entry => (entry.UUID === Service.LockMechanism.UUID) && (entry.subtype === subtype));

  assert.ok(service, "the hub should have configured a lock");

  return service;
}

// The doorbell a hub configured for its own ring events.
function doorbellService(harness: HubHarness): Service {

  const service = harness.services.find(entry => (entry.UUID === Service.Doorbell.UUID) && !entry.subtype);

  assert.ok(service, "the hub should have configured a doorbell");

  return service;
}

// Whether the accessory carries a doorbell at all, which is what the option that withholds one is read from.
function hasDoorbell(harness: HubHarness): boolean {

  return harness.services.some(entry => (entry.UUID === Service.Doorbell.UUID) && !entry.subtype);
}

// The switch a hub configured under a reserved subtype.
function switchService(harness: HubHarness, subtype: string): Service {

  const service = harness.services.find(entry => (entry.UUID === Service.Switch.UUID) && (entry.subtype === subtype));

  assert.ok(service, "the hub should have configured the " + subtype + " switch");

  return service;
}

// Whether the accessory carries the access method switch for a subtype, which is what creation and retirement are both read from.
function hasSwitch(harness: HubHarness, subtype: string): boolean {

  return harness.services.some(service => (service.UUID === Service.Switch.UUID) && (service.subtype === subtype));
}

// The contact sensor a hub configured under a reserved subtype.
function contactSensor(harness: HubHarness, subtype: string): Service {

  const sensor = harness.services.find(service => (service.UUID === Service.ContactSensor.UUID) && (service.subtype === subtype));

  assert.ok(sensor, "the hub should have configured the " + subtype + " sensor");

  return sensor;
}

// Whether the accessory carries the contact sensor for a subtype, which is what a creation and a withholding are both read from.
function hasContactSensor(harness: HubHarness, subtype: string): boolean {

  return harness.services.some(service => (service.UUID === Service.ContactSensor.UUID) && (service.subtype === subtype));
}

/* What an access method switch answers when HomeKit asks it, taken from the registered handler rather than from the characteristic's own cached value. The push path
 * writes that cached value whatever the model holds, so reading it would let a fold that never ran pass as one that did.
 *
 * @param harness - The hub to read.
 * @param subtype - The access method switch to ask.
 *
 * @returns What the switch's read handler answers.
 */
async function switchReads(harness: HubHarness, subtype: string): Promise<unknown> {

  return switchService(harness, subtype).getCharacteristic(Characteristic.On).handleGetRequest();
}

/* Restate a hub's own record the way the observe loop does, and hand it the device update that follows...which is how a bootstrap refresh reaches its handlers.
 *
 * @param harness   - The hub to restate.
 * @param overrides - The record members the restated record carries, layered over the one the hub holds.
 */
function restateRecord(harness: HubHarness, overrides: Record<string, unknown>): void {

  harness.hub.uda = { ...harness.hub.uda, ...overrides } as unknown as AccessStateDevice;
  harness.emit(HUB_ID, { event: ACCESS_DEVICE_UPDATE_EVENT });
}

// The same restatement for the configuration rows alone, which is the member most of the arms below vary.
function refreshRecord(harness: HubHarness, configs: unknown[]): void {

  restateRecord(harness, { configs });
}

// A v2 device update carrying one access method's reported value, in the shape the wire sends it.
function accessMethodPacket(value: string): unknown {

  return { data: { access_method: { pin_code: value } }, event: "access.data.v2.device.update" };
}

/* Everything a hub published on one of its topics, in the order it published it. A projected reading is a sequence rather than a set - it opens, it ends, and an arm
 * about it has to see a repeat or a stranded half - so the payloads are read as a list and asserted exactly.
 *
 * @param harness - The hub to read.
 * @param tail    - The topic tail to read, under this hub's own serial.
 *
 * @returns The payloads published on that topic, oldest first.
 */
function topicPayloads(harness: HubHarness, tail: string): string[] {

  return harness.publishes.filter(published => published.topic === (HUB_SERIAL + "/" + tail)).map(published => published.payload);
}

// The same reading of a lock topic, the main door's unless the side door's is named.
function lockPayloads(harness: HubHarness, tail = "lock"): string[] {

  return topicPayloads(harness, tail);
}

/* How many times a hub wrote exactly this sentence, which is what tells an announcement that happens once from one that repeated or never came.
 *
 * @param harness  - The hub to read.
 * @param sentence - The sentence as a user reads it, without the logger's own prefix.
 *
 * @returns The number of times the hub wrote it.
 */
function lineCount(harness: HubHarness, sentence: string): number {

  return harness.lines.filter(line => line === (LOG_PREFIX + sentence)).length;
}

// Write a target door state the way HomeKit does, and wait on the handler behind it.
async function writeTarget(harness: HubHarness, target: number): Promise<void> {

  await openerService(harness).getCharacteristic(Characteristic.TargetDoorState).handleSetRequest(target);
}

// One write on a freshly stood-up door hub opener, and what that write dispatched to the library.
async function openerDispatch(options: HubOptions, target: number): Promise<RecordedCommand[]> {

  const opener = makeOpener(options);

  await writeTarget(opener, target);

  return opener.commands;
}

// Write a lock target the way HomeKit does, and wait on the handler behind it.
async function writeLock(service: Service, target: number): Promise<void> {

  await service.getCharacteristic(Characteristic.LockTargetState).handleSetRequest(target);
}

// An unlock delivery naming one door, in the shape the live capture carries.
function unlockDelivery(options: { door?: string; doorName?: string } = {}): unknown {

  return {

    data: {

      actor: { id: "b3e2d4f6-0000-4000-8000-000000000002", name: "webhook delivery probe", type: "open-api" },
      device: { connected_hub_id: "", id: HUB_ID, mac: "74:ac:b9:d5:5b:9c", name: "UA-HUB-5B9C" },
      location: { id: options.door ?? MAIN_DOOR, location_type: "door", name: options.doorName ?? "Door Hub", up_id: "floor1" },
      object: {

        authentication_type: "NFC",
        authentication_value: "",
        policy_id: "",
        policy_name: "",
        reader_id: "",
        result: "Access Granted",
        time: "2026-08-15 16:03:48 -0500 CDT"
      }
    },
    event: ACCESS_WEBHOOK_EVENTS.doorUnlock,
    event_object_id: "unlock1"
  };
}

// A doorbell-completed delivery, which names its hub only through the ringing reader's own record.
function doorbellDelivery(options: { hub?: string; reasonCode?: number } = {}): unknown {

  return {

    data: {

      actor: null,
      device: { connected_hub_id: options.hub ?? HUB_ID, id: READER_ID, mac: "d8:b3:70:6b:b7:3b", name: "UA G2 PRO Black b73b" },
      location: { id: MAIN_DOOR, location_type: "door", name: "Door Hub", up_id: "floor1" },
      object: { host_device_mac: "", reason_code: options.reasonCode ?? 105, request_id: "call1" }
    },
    event: ACCESS_WEBHOOK_EVENTS.doorbellCompleted,
    event_object_id: "doorbell1"
  };
}

test("construction records the accessory's context: the controller key, the device identity, and the hardware address", () => {

  const harness = makeHub();

  // The three keys a startup sweep and an orphan's naming read back, and nothing else - the wipe that precedes the writes is what keeps a polluted context from
  // carrying a stale key past construction. The identity recorded is the device's own, read off the hub rather than restated.
  assert.deepEqual(harness.hub.accessory.context, { controller: "1.2.3.4", id: HUB_SERIAL, mac: HUB_MAC });
  assert.equal(harness.hub.accessory.context.id, harness.hub.id);
});

test("the hub registers for exactly the deliveries the registration asks a controller for", () => {

  const harness = makeHub();

  // The set the plugin listens for and the set a controller is asked to deliver are the same constant, so they cannot drift apart.
  for(const event of ACCESS_WEBHOOK_EVENT_LIST) {

    harness.deliver(event, event === ACCESS_WEBHOOK_EVENTS.doorUnlock ? unlockDelivery({ door: "somebody-elses-door" }) : doorbellDelivery({ hub: "another-hub" }));
  }

  // Neither delivery named this hub, so neither did anything - which is what makes the registration assertion above meaningful rather than incidental.
  assert.deepEqual(harness.publishes, []);
  assert.deepEqual(harness.lines, []);
});

test("an unlock on this hub's own door publishes one attribution and says who opened it", () => {

  const harness = makeHub();

  harness.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery());

  // The topic tail is the main door's, and the payload is the attribution rather than the raw delivery.
  assert.deepEqual(harness.publishes.map(published => published.topic), [HUB_SERIAL + "/unlock"]);
  assert.deepEqual(JSON.parse(harness.publishes[0]?.payload ?? "null"), {

    actor: "webhook delivery probe",
    actorType: "open_api",
    method: "NFC",
    policy: null,
    reader: null,
    result: "Access Granted",
    time: "2026-08-15 16:03:48 -0500 CDT"
  });

  // The line names the door as the delivery named it, which is the door's own name rather than the accessory's, and renders the method through the library's gloss.
  assert.deepEqual(harness.lines, [LOG_PREFIX + "Door Hub unlocked by webhook delivery probe (NFC credential)."]);
});

test("an unlock on a door this hub does not drive is not its business", () => {

  const harness = makeHub();

  /* Ownership is the door alone. The acting device is deliberately not a key: the hub that drives a door owns that door's unlocks and the reader that presented
   * the credential never publishes them, so one physical unlock reaches exactly one accessory.
   */
  harness.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery({ door: "a-door-down-the-hall" }));

  assert.deepEqual(harness.publishes, []);
  assert.deepEqual(harness.lines, []);
});

test("a hub inside its removal window answers null rather than throwing out of a shared dispatch", () => {

  /* Every hub on a controller sees every delivery, so a hub whose device has left controller state must not take its siblings down with it. The library's own
   * handle raises a ReferenceError in exactly that window, which is the ordinary shape of a removal rather than a fault.
   */
  const departing = makeHub({ doorId: (): never => { throw new ReferenceError("The device is no longer present in controller state."); } });
  const sibling = makeHub();

  departing.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery());

  assert.deepEqual(departing.publishes, [], "a hub that cannot resolve its own door owns nothing");
  assert.deepEqual(departing.lines, []);

  // The sibling still handles its own delivery, which is the half that fails a handler letting the ReferenceError escape.
  sibling.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery());

  assert.equal(sibling.publishes.length, 1);
});

test("a UA Gate publishes its side door's unlocks under the side door's own topic", () => {

  const gate = makeHub({

    doors: [ { name: "Main Gate", unique_id: MAIN_DOOR }, { name: "Pedestrian Gate", unique_id: SIDE_DOOR } ],
    record: hubRecord({ device_type: "UGT" })
  });

  gate.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery({ door: SIDE_DOOR, doorName: "Pedestrian Gate" }));

  assert.deepEqual(gate.publishes.map(published => published.topic), [HUB_SERIAL + "/sidedoor/unlock"]);

  // And the main gate still publishes on the main tail, so the two doors of one accessory stay told apart.
  gate.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery({ door: MAIN_DOOR, doorName: "Main Gate" }));

  assert.deepEqual(gate.publishes.map(published => published.topic), [ HUB_SERIAL + "/sidedoor/unlock", HUB_SERIAL + "/unlock" ]);
});

/* A UA Gate whose relay rows report both doors secured, which is the seed every service below is configured from. An arm pairs it with a door state map that
 * disagrees, so what adoption pushed can be told apart from what the record alone would have rendered.
 */
function securedGate(options: HubOptions = {}): HubHarness {

  return makeGate({ ...options, record: hubRecord({ configs: [ { device_id: HUB_ID, key: "output_oper1_relay", tag: "relay", value: "off" },
    { device_id: HUB_ID, key: "output_oper2_relay", tag: "relay", value: "off" } ], device_type: "UGT" }) });
}

test("a UA Gate adopts its main door's lock from the door state map rather than leaving the record's reading in HomeKit", () => {

  /* The distinguishing input: the relay row every service is built from says secured, and the controller's own door state map says the gate is standing open.
   * A seed that stops at the backing field leaves the lock reading secured until the door next moves.
   */
  const gate = securedGate({ doorStates: new Map([[ MAIN_DOOR, { dps: "open", location_id: MAIN_DOOR, lock: "unlock" } ]]),
    options: ["Enable.Hub.Door.Service=Lock"] });

  assert.equal(lockService(gate).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);
  assert.equal(lockService(gate).getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.UNSECURED);

  // Adoption is not a transition anyone observed, so it reaches the characteristics and nothing else.
  assert.deepEqual(gate.publishes, []);
  assert.deepEqual(gate.lines, []);
});

test("a UA Gate adopts its side door's lock and position from the door state map", () => {

  /* Both side-door sources disagree with the record here: its relay row says secured while the map says unlocked, and its position sensor was configured closed
   * from a gate with no side dps wiring while the map says open.
   */
  const gate = securedGate({ doorStates: new Map([[ SIDE_DOOR, { dps: "open", location_id: SIDE_DOOR, lock: "unlock" } ]]) });

  assert.equal(lockService(gate, AccessReservedNames.LOCK_DOOR_SIDE).getCharacteristic(Characteristic.LockCurrentState).value,
    Characteristic.LockCurrentState.UNSECURED);
  assert.equal(contactSensor(gate, AccessReservedNames.CONTACT_DPS_SIDE).getCharacteristic(Characteristic.ContactSensorState).value,
    Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

  assert.deepEqual(gate.publishes, []);
  assert.deepEqual(gate.lines, []);
});

test("a UA Gate whose door state map agrees with its record adopts silently and renders the same reading", () => {

  // Both sources say the same thing, so each setter's early return is what runs...and the rendering must be identical to the disagreeing arms' starting point.
  const gate = securedGate({ doorStates: new Map([

    [ MAIN_DOOR, { dps: "close", location_id: MAIN_DOOR, lock: "lock" } ],
    [ SIDE_DOOR, { dps: "close", location_id: SIDE_DOOR, lock: "lock" } ]
  ]), options: ["Enable.Hub.Door.Service=Lock"] });

  assert.equal(lockService(gate).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED);
  assert.equal(lockService(gate, AccessReservedNames.LOCK_DOOR_SIDE).getCharacteristic(Characteristic.LockCurrentState).value,
    Characteristic.LockCurrentState.SECURED);
  assert.equal(contactSensor(gate, AccessReservedNames.CONTACT_DPS_SIDE).getCharacteristic(Characteristic.ContactSensorState).value,
    Characteristic.ContactSensorState.CONTACT_DETECTED);

  assert.deepEqual(gate.publishes, [], "an adoption that told HomeKit nothing new must publish nothing");
  assert.deepEqual(gate.lines, []);
});

test("a door hub adopts its own door's reading from the door state map at construction, and says nothing about it", () => {

  // The record's relay row says secured while the controller's map says the door is standing unlocked, so a seed that read the record alone renders the wrong lock.
  const hub = makeHub({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "unlock" }, options: ["Enable.Hub.Door.Service=Lock"] });

  assert.equal(lockService(hub).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);

  // Adoption is not a transition anyone observed, so it reaches the characteristics and nothing else.
  assert.deepEqual(hub.publishes, []);
});

test("a doorbell call that ended on this hub's reader is logged, and one on another hub's is not", () => {

  const harness = makeHub();

  harness.deliver(ACCESS_WEBHOOK_EVENTS.doorbellCompleted, doorbellDelivery());

  // The outcome is the library's own gloss for the code, and nothing is published - a call ending is a fact about the call rather than about the door.
  assert.deepEqual(harness.lines, [LOG_PREFIX + "Doorbell call ended: The call timed out."]);
  assert.deepEqual(harness.publishes, []);

  /* The delivery names its hub only through the ringing reader's own record - the live capture's host member reads empty - so a reader hanging off another hub is
   * how a sibling's call arrives here, and it must stay silent.
   */
  harness.deliver(ACCESS_WEBHOOK_EVENTS.doorbellCompleted, doorbellDelivery({ hub: "another-hub" }));

  assert.equal(harness.lines.length, 1, "a call that ended on another hub's reader must say nothing here");
});

test("a record's configuration rows create the switches its capabilities call for, and a capability with no row of its own reads off", async () => {

  const harness = makeReader({ record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code", "qr_code" ],
    configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] }) });

  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "a row the record carries is what the switch reads");

  /* Existence keys on the reader's capabilities and the user's settings rather than on what the model happens to hold for each method, so a capability the
   * configuration rows never mentioned still gets its switch, and that switch reads off...which is exactly what the live row read this replaces answered for it.
   */
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), "a capability with no row of its own still gets a switch");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), false);
});

test("a reader whose record carries no configuration rows takes its switches from the official settings read", async () => {

  const harness = makeReader({

    official: true,
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code", "qr_code", "support_apple_pass" ], configs: undefined }),
    settings: async (): Promise<unknown> => ({ access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" }, touch_pass: { enabled: "yes" } } })
  });

  // The read is dispatched rather than awaited, so a device the record rail says nothing about carries nothing until the controller has answered.
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "nothing is created before the settings read answers");

  await settle();

  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);

  /* TouchPass is the one method the two surfaces spell differently: the settings answer names it touch_pass while the model keys it apple_pass. A switch reading off
   * here is what a translation reaching for the wrong vocabulary looks like, and it would leave the method permanently off on every token-only controller.
   */
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_TOUCHPASS), true, "TouchPass is read through its official spelling");

  // The settings map is sparse, so a capability the answer never mentioned still gets its switch and reads off, exactly as a capability with no row does above.
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), "a capability the sparse answer omits still gets a switch");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), false);
});

test("a settings read the controller refused keeps every switch the accessory carries, creates none, and says so", async () => {

  const harness = makeReader({

    existing: [AccessReservedNames.SWITCH_ACCESSMETHOD_NFC],
    official: true,
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => { throw new Error("the controller is not answering"); }
  });

  await settle();

  /* The switch the accessory arrived carrying names a method this record has no capability for, so the per-method sweep would retire it the moment that loop ran.
   * An unseeded model must never run it: a read that failed says nothing about which methods the reader offers, and a switch retired here takes the automations
   * behind it with it.
   */
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "a switch the accessory already carried survives a read that failed");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and nothing is created from a read that answered nothing");

  assert.equal(harness.debugs.filter(line => line === LOG_PREFIX + "Unable to read the access method settings from the controller. Access method switches will " +
    "be configured once the controller answers.").length, 1, "the failure is announced once");
});

test("a rowless record on a client with no official surface keeps what it has and creates nothing", async () => {

  const harness = makeReader({

    existing: [AccessReservedNames.SWITCH_ACCESSMETHOD_NFC],
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined })
  });

  await settle();

  /* The other half of the contract: neither rail can answer for this device. The rows say nothing, and a credential-only client holds no official surface to ask,
   * so the device stays unseeded and keeps exactly what it arrived with until a restart finds a rail that can answer.
   */
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "a switch the accessory already carried is kept");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and no switch is created for a method nothing has spoken about");
  assert.deepEqual(harness.fetches, [], "a client with no official surface never reaches for the settings read");

  /* An access method event is what retries the seed on a client that has a surface to retry with, so driving one is what puts this refusal where an arm can read it.
   * The harness clears whatever construction said, so the same refusal taken during construction alone would leave nothing behind to assert against.
   */
  harness.emit(HUB_ID, accessMethodPacket("yes"));
  await settle();

  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "the event leaves what the accessory keeps exactly as it was");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and creates nothing on the strength of one method's report");
  assert.deepEqual(harness.fetches, [], "and still reaches for no settings read");

  // The failure sentence belongs to a read that went out and was refused. Nothing was ever asked for here, so nothing is announced...which is what tells this arm
  // apart from the one above it, where the read was attempted and failed.
  assert.equal(harness.debugs.filter(line => line === LOG_PREFIX + "Unable to read the access method settings from the controller. Access method switches will " +
    "be configured once the controller answers.").length, 0, "a read never attempted is never announced as failed");
});

test("a seeded device retires the switch of a method that has left the reader, in both client identities", async () => {

  // The credential identity: the record's rows seed the model synchronously, so the sweep runs in the very pass that configures the device.
  const credential = makeReader({

    existing: [AccessReservedNames.SWITCH_ACCESSMETHOD_NFC],
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ],
      configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] })
  });

  assert.ok(!hasSwitch(credential, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "the switch of a method the reader no longer carries is retired");
  assert.ok(hasSwitch(credential, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and the method it still carries keeps its own");

  // The token identity: the same sweep, reached through the settings read instead of the rows, which is what makes retirement reach a rowless record at all.
  const token = makeReader({

    existing: [AccessReservedNames.SWITCH_ACCESSMETHOD_NFC],
    official: true,
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => ({ access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } })
  });

  assert.ok(hasSwitch(token, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "nothing is retired while the read is still in flight");

  await settle();

  assert.ok(!hasSwitch(token, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "and the stale switch goes once the read has seeded the model");
  assert.equal(await switchReads(token, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);
});

test("a v2 access method event moves the switch and the model behind it, in both client identities", async () => {

  const reader = { capabilities: [ "is_hub", "is_reader", "pin_code" ] };

  const credential = makeReader({ record: hubRecord({ ...reader, configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] }) });
  const service = switchService(credential, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN);

  // The wire echoes key names back as values, and the handler's own filter is what keeps one out of the model as surely as out of the switch.
  credential.emit(HUB_ID, accessMethodPacket("pin_code"));

  assert.equal(await switchReads(credential, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "a malformed value moves nothing");

  credential.emit(HUB_ID, accessMethodPacket("no"));

  assert.equal(service.getCharacteristic(Characteristic.On).value, false, "the event is pushed to the switch");
  assert.equal(await switchReads(credential, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "and the model it reads from moved with it");

  const token = makeReader({ official: true, record: hubRecord({ ...reader, configs: undefined }),
    settings: async (): Promise<unknown> => ({ access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } }) });

  await settle();

  assert.equal(token.fetches.length, 1);

  token.emit(HUB_ID, accessMethodPacket("no"));

  assert.equal(await switchReads(token, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "the same rail moves a model the settings read seeded");

  await settle();

  assert.equal(token.fetches.length, 1, "a device whose model is seeded never asks the controller again");
});

test("a v2 access method event retries a settings read that failed, and only while none is in flight", async () => {

  const harness = makeHub({

    official: true,
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

    // The first read is refused; the retry stays in flight for the rest of the arm, which is what the event arriving behind it meets.
    settings: async (fetch: number): Promise<unknown> => {

      if(fetch === 1) {

        throw new Error("the controller is not answering");
      }

      return new Promise<never>(() => undefined);
    }
  });

  await settle();

  assert.equal(harness.fetches.length, 1, "the first read is the one configuring the device dispatched");

  harness.emit(HUB_ID, accessMethodPacket("yes"));
  await settle();

  assert.equal(harness.fetches.length, 2, "an access method event retries a seed that failed");

  harness.emit(HUB_ID, accessMethodPacket("no"));
  await settle();

  assert.equal(harness.fetches.length, 2, "and an event arriving while that read is in flight asks for nothing more");
});

test("a dressed sensor answers availability from the live composition rather than from what was last pushed to it", async () => {

  const harness = makeGate();
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_DPS);

  const availability = sensor.getCharacteristic(Characteristic.StatusActive);

  assert.equal(await availability.handleGetRequest(), true, "a sensor dressed under a healthy controller reads available");

  const writes = recordWrites(sensor);

  /* Nothing pushes from here: no observer walk and no record delivery runs in this arm. An answer that follows the flip can therefore only have come from the handler
   * consulting the composition, which is exactly what a dress that wrote the characteristic and registered nothing would fail.
   */
  harness.health.isHealthy = false;

  assert.equal(await availability.handleGetRequest(), false, "and a read taken after the connection moved answers where the device stands now");
  assert.deepEqual(writes, [], "with no push behind it at all");
});

test("a door command refuses locally whenever the composition reads unreachable, on either of its two terms", async () => {

  const refusal = LOG_PREFIX + "Unable to unlock the door. The device cannot be reached.";

  // The controller term: a record that reads perfectly online, behind a connection that is not healthy.
  const outage = makeHub();

  outage.health.isHealthy = false;

  await writeLock(lockService(outage), Characteristic.LockTargetState.UNSECURED);

  assert.deepEqual(outage.commands, [], "an unreachable controller is refused here rather than dispatched into");
  assert.ok(outage.errors.includes(refusal), "and the refusal names reachability, since a controller outage says nothing about the device itself");

  /* The device term: a healthy connection over a record that reads offline. Driving the two separately is what makes dropping either half of the composition fail
   * here, where one combined arm would pass on the surviving half's strength.
   */
  const offline = makeHub({ record: hubRecord({ is_online: false }) });

  await writeLock(lockService(offline), Characteristic.LockTargetState.UNSECURED);

  assert.deepEqual(offline.commands, [], "a device its own record calls offline is refused the same way");
  assert.ok(offline.errors.includes(refusal));
});

test("a hub with no door control surface refuses every door command with the one sentence that says so", async () => {

  const hub = makeHub({ hubless: true });

  await writeLock(lockService(hub), Characteristic.LockTargetState.UNSECURED);

  assert.deepEqual(hub.commands, [], "a hub with nothing to dispatch on is refused here rather than dispatched into");
  assert.deepEqual(hub.errors, [LOG_PREFIX + "Unable to unlock the door. This device has no door control surface."]);

  /* The locking direction reaches the command through MQTT rather than through the tile: the lock service's write handler suppresses a lock write on a hub whose
   * reading is already secured, so the topic is the surface that drives that direction here.
   */
  await hub.mqttSet("lock", "true");
  await settle();

  assert.deepEqual(hub.commands, []);
  assert.deepEqual(hub.errors, [ LOG_PREFIX + "Unable to unlock the door. This device has no door control surface.",
    LOG_PREFIX + "Unable to lock the door. This device has no door control surface." ]);

  // The garage door opener's momentary pulse names the same door for the same reason.
  const opener = makeOpener({ hubless: true });

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);

  assert.deepEqual(opener.commands, []);
  assert.deepEqual(opener.errors, [LOG_PREFIX + "Unable to operate the door. This device has no door control surface."]);

  // A UA Gate hears it on both directions, its locking one arriving through the close command.
  const gate = makeGate({ hubless: true });

  await gate.mqttSet("lock", "true");
  await settle();
  await gate.mqttSet("lock", "false");
  await settle();

  assert.deepEqual(gate.errors, [ LOG_PREFIX + "Unable to close the gate. This device has no door control surface.",
    LOG_PREFIX + "Unable to unlock the gate. This device has no door control surface." ]);
  assert.deepEqual(gate.commands, []);
});

test("a UA Gate whose door was never discovered refuses its commands for the record it has no identity from", async () => {

  /* A gate holding a control surface over an empty topology. Both of the preamble's own refusals are behind it, so the only reason left is the one the door
   * resolution could not answer.
   */
  const gate = makeHub({ credentials: true, doors: [], record: hubRecord({ device_type: "UGT" }) });

  await gate.mqttSet("lock", "true");
  await settle();
  await gate.mqttSet("lock", "false");
  await settle();

  assert.deepEqual(gate.errors, [ LOG_PREFIX + "Unable to close the gate. No door record was found for it.",
    LOG_PREFIX + "Unable to unlock the gate. No door record was found for it." ]);
  assert.deepEqual(gate.commands, []);
});

test("a door that cannot be reached is refused for that reason before its relock policy is consulted", async () => {

  const hub = makeHub();

  // A door the controller reports unlocked, so the write below is a genuine relock rather than a sync from an event, which is how the relock arm sets it up too.
  hub.setDoorState({ dps: "none", location_id: MAIN_DOOR, lock: "unlock" });
  hub.hub.refreshDoorState();
  hub.health.isHealthy = false;

  await writeLock(lockService(hub), Characteristic.LockTargetState.SECURED);

  assert.deepEqual(hub.commands, [], "an unreachable door dispatches nothing whatever its relay is configured for");

  // Exactly one line, which is where the relock sentence's absence is asserted: an outage is what the user can act on.
  assert.deepEqual(hub.errors, [LOG_PREFIX + "Unable to lock the door. The device cannot be reached."]);
});

test("a door hub's failure lines name the door the command was addressed to", async () => {

  const opener = makeOpener({ reject: ["unlock"] });

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);

  assert.equal(opener.commands.length, 1, "the pulse reached the controller, so this line reports a failure rather than a refusal");
  assert.deepEqual(opener.errors, [LOG_PREFIX + "Unable to operate the door: The controller refused this command."]);

  const hub = makeHub({ reject: ["unlock"] });

  await writeLock(lockService(hub), Characteristic.LockTargetState.UNSECURED);

  assert.equal(hub.commands.length, 1);
  assert.deepEqual(hub.errors, [LOG_PREFIX + "Unable to unlock the door: The controller refused this command."]);
});

test("a completed recovery refreshes a rowless reader's access methods and restates the switch behind them", async () => {

  const harness = makeReader({

    official: true,
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

    // The controller answers differently the second time, which is what makes the refreshed value tell itself apart from the seeded one.
    settings: async (fetch: number): Promise<unknown> => ({ access_methods: { pin_code: { enabled: (fetch === 1) ? "yes" : "no", pin_code_shuffle: "no" } } })
  });

  await settle();

  // Staging the count at construction's own seed is what separates the restore's read from it: a post-restore total of one would reward a hook that never fetched.
  assert.equal(harness.fetches.length, 1, "construction's seed is the first read");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);

  harness.hub.onConnectionRestored();
  await settle();

  assert.equal(harness.fetches.length, 2, "a completed recovery reads the settings again");

  /* The pushed value is read before the handler is asked anything, because a HAP read writes the value it answers back onto the characteristic - so asking first
   * would leave this assertion passing on the strength of the read rather than on the restatement it is here to observe.
   */
  assert.equal(switchService(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On).value, false,
    "the switch restates the refreshed value for HomeKit");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "and the model behind it took what the refresh answered");
});

test("a restore arriving while a refresh is still out asks for nothing more", async () => {

  const harness = makeHub({

    official: true,
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

    // The seed settles; the refresh behind it stays in flight for the rest of the arm, which is what the second restore edge meets.
    settings: async (fetch: number): Promise<unknown> => (fetch === 1) ? { access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } } :
      new Promise<never>(() => undefined)
  });

  await settle();

  assert.equal(harness.fetches.length, 1);

  harness.hub.onConnectionRestored();
  await settle();

  assert.equal(harness.fetches.length, 2, "the first restore dispatches its refresh");

  harness.hub.onConnectionRestored();
  await settle();

  assert.equal(harness.fetches.length, 2, "and a second restore while that read is out dispatches nothing");
});

test("a reader whose record carries configuration rows reads no settings on a completed recovery", async () => {

  /* The official surface is present deliberately. Without one the refresh would exit on its absence instead, and this arm would pass without ever putting the row
   * predicate under test.
   */
  const harness = makeReader({

    official: true,
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ],
      configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] })
  });

  await settle();

  assert.deepEqual(harness.fetches, [], "the record's own rows seeded the model, so nothing was read for it");

  harness.hub.onConnectionRestored();
  await settle();

  assert.deepEqual(harness.fetches, [], "and a completed recovery leaves the record rail as this device's authority");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);
});

test("rows landing while a refresh is out outrank the answer that refresh comes back with", async () => {

  let landing: (() => void) | undefined;

  const harness = makeReader({

    official: true,
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

    settings: async (fetch: number): Promise<unknown> => {

      if(fetch === 1) {

        return { access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } };
      }

      // The refresh's own read waits here, which is the window the record delivery below lands in.
      await new Promise<void>(resolve => (landing = resolve));

      return { access_methods: { pin_code: { enabled: "no", pin_code_shuffle: "no" } } };
    }
  });

  await settle();

  harness.hub.onConnectionRestored();
  await settle();

  assert.equal(harness.fetches.length, 2, "the refresh is out");

  // The record gains its rows while that read is still in flight, which makes this device rowful and the answer already on its way stale.
  refreshRecord(harness, [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }]);

  landing?.();
  await settle();

  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "the rows the record brought are what the model holds");
});

test("a refused refresh keeps the values already held, retires nothing, and never warns", async () => {

  const harness = makeReader({

    official: true,
    options: ["Enable.Log.Debug"],
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

    settings: async (fetch: number): Promise<unknown> => {

      if(fetch === 1) {

        return { access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } };
      }

      throw new Error("the controller is not answering");
    }
  });

  await settle();

  harness.hub.onConnectionRestored();
  await settle();

  assert.equal(harness.fetches.length, 2, "the refresh went out and was refused");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "a read that failed leaves the values the model already held");
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and retires nothing behind them");

  /* Values in hand are a better answer than none, so a failed refresh is worth a note and nothing louder. It never borrows the seed's own warning either, which
   * belongs to a device that has no values at all yet.
   */
  assert.equal(harness.debugs.filter(line => line.startsWith(LOG_PREFIX + "The access method refresh was refused:")).length, 1, "the failure is noted once, at debug");
  assert.equal(harness.debugs.filter(line => line.startsWith(LOG_PREFIX + "Unable to read the access method settings from the controller.")).length, 0,
    "and the seed's warning is not borrowed for it");
});

test("a settings read that lands after the device was torn down materializes nothing and passes in silence", async () => {

  // The seed's read, held open by the arm rather than settled on a schedule, so the teardown below lands while the read is genuinely still out.
  let answerSettings: (settings: unknown) => void = (): void => undefined;

  const landing = makeReader({

    official: true,
    options: ["Enable.Log.Debug"],
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => new Promise<unknown>(resolve => { answerSettings = resolve; })
  });

  await settle();

  assert.equal(landing.fetches.length, 1, "construction's seed went out");
  assert.ok(!hasSwitch(landing, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and nothing is created while it is still in flight");

  /* The device leaves HomeKit, and only then does the controller answer. Ordering the answer behind the teardown through the arm's own resolver is what makes this
   * structural rather than a race the timing happens to win.
   */
  landing.hub.cleanup();
  answerSettings({ access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } });
  await settle();

  assert.ok(!hasSwitch(landing, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "an answer arriving after teardown dresses an accessory that is on its way out");

  // The other exit the same teardown can take: the read is refused rather than answered. A device that will never project these settings has nothing to say about
  // being unable to read them, so the seed's own warning is not borrowed for it.
  const refusal = makeReader({

    official: true,
    options: ["Enable.Log.Debug"],
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => new Promise<never>((resolve, reject) => { answerSettings = (): void => reject(new Error("the device is gone")); })
  });

  await settle();

  refusal.hub.cleanup();
  answerSettings(undefined);
  await settle();

  assert.ok(!hasSwitch(refusal, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "a refused read creates nothing either");
  assert.equal(refusal.debugs.filter(line => line.startsWith(LOG_PREFIX + "Unable to read the access method settings from the controller.")).length, 0,
    "and a device on its way out announces no failure to read them");
});

test("a recovery arriving after the device was torn down reads nothing, changes nothing, and says nothing", async () => {

  const harness = makeReader({

    official: true,
    options: ["Enable.Log.Debug"],
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => ({ access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } })
  });

  await settle();

  // Staging at the seeded model is what gives the refresh below something it could have overwritten, so silence here is a refusal to act rather than nothing to act on.
  assert.equal(harness.fetches.length, 1, "construction's seed answered");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "and the model holds what it answered");

  /* A recovery edge can reach a device the controller has already retired: the removal and the connection monitor are separate rails, and this device's lifetime
   * ended on one of them. The refresh it dispatches asks the signal first, so the read never reaches the controller at all.
   */
  harness.hub.cleanup();
  harness.hub.onConnectionRestored();
  await settle();

  assert.equal(harness.fetches.length, 1, "a device whose lifetime has ended reaches for no settings read");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "the values it already held are left exactly as they were");
  assert.equal(harness.debugs.filter(line => line.startsWith(LOG_PREFIX + "The access method refresh was refused:")).length, 0,
    "and teardown is not the kind of refusal that earns a note - the note belongs to a controller that would not answer");
});

test("every MQTT registration is bound to the device's lifetime and leaves with it", () => {

  const gate = makeGate();

  // A UA Gate with a doorbell registers the whole topic surface: the doorbell, the door position, the lock in both directions, and the side door's lock in
  // both directions and its position.
  assert.deepEqual(gate.mqtt.subscriptions.map(entry => entry.topic).sort(), [ mqttGetTopic(HUB_SERIAL + "/doorbell"), mqttGetTopic(HUB_SERIAL + "/dps"),
    mqttGetTopic(HUB_SERIAL + "/lock"), mqttSetTopic(HUB_SERIAL + "/lock"), mqttGetTopic(HUB_SERIAL + "/sidedoor/dps"),
    mqttGetTopic(HUB_SERIAL + "/sidedoor/lock"), mqttSetTopic(HUB_SERIAL + "/sidedoor/lock") ].sort());

  for(const entry of gate.mqtt.subscriptions) {

    assert.equal(entry.init.signal, gate.hub.signal, "the " + entry.topic + " registration must carry the device's own lifetime signal");
  }

  // Removing the device is what aborts its lifetime, and the broker releases every registration that signal governed.
  gate.hub.cleanup();

  assert.deepEqual(gate.mqtt.subscriptions, [], "a removed device must leave no registration behind");
});

test("every publish carries the device's own lifetime signal, and one issued after removal is refused rather than sent", async () => {

  const harness = makeHub();

  harness.publish(mqttTopics.lock, "true");

  await settle();

  // Before the removal the publish is admitted, and it carries this device's own signal rather than the controller's.
  assert.deepEqual(harness.mqtt.published, [{ payload: "true", topic: HUB_SERIAL + "/lock" }]);
  assert.equal(harness.publishes[0]?.init?.signal, harness.hub.signal, "a publish must carry the device's own lifetime signal");

  harness.hub.cleanup();
  harness.publish(mqttTopics.lock, "false");

  await settle();

  // After it, the client refuses the publish on the signal it carries and says so at debug; nothing reaches the broker and nothing is an error.
  assert.deepEqual(harness.mqtt.published, [{ payload: "true", topic: HUB_SERIAL + "/lock" }], "a publish after removal must never reach the broker");
  assert.equal(harness.publishes[1]?.init?.signal?.aborted, true);
  assert.deepEqual(harness.debugs, ["MQTT publish aborted: " + HUB_SERIAL + "/lock."]);
  assert.deepEqual(harness.errors, []);
});

test("a gate unlock overtaken by the device's removal announces nothing", async () => {

  const gate = makeGate({ defer: "unlock" });

  // The unlock goes out and parks on the controller's answer.
  void gate.mqttSet("lock", "false");

  await settle();

  assert.equal(gate.commands.length, 1, "the unlock must have been dispatched");

  // The removal lands while the answer is still outstanding, and then the answer arrives.
  gate.hub.cleanup();
  gate.release();

  await settle();

  // The controller accepted the unlock, but there is no device left to open a window for: no lock publish, no line, nothing refused at the broker either.
  assert.deepEqual(lockPayloads(gate), [], "a removed device must not announce an unlock");
  assert.equal(lineCount(gate, "Gate unlocked."), 0);
  assert.deepEqual(gate.debugs.filter(line => line.startsWith("MQTT publish aborted")), []);
});

test("a gate close overtaken by the device's removal announces nothing", async () => {

  const gate = makeGate({ defer: "close" });

  // Open the window first, so there is a standing unlocked state a close would otherwise settle and announce.
  await gate.mqttSet("lock", "false");
  await settle();

  assert.deepEqual(lockPayloads(gate), ["false"]);
  assert.equal(lineCount(gate, "Gate unlocked."), 1);

  void gate.mqttSet("lock", "true");

  await settle();

  assert.equal(gate.commands.length, 2, "the close must have been dispatched");

  gate.hub.cleanup();
  gate.release();

  await settle();

  // The close was accepted, but the window is never settled on the removed device's behalf.
  assert.deepEqual(lockPayloads(gate), ["false"], "a removed device must not announce a close");
  assert.equal(lineCount(gate, "Gate locked."), 0);
});

test("a completed recovery gives the startup seed of a reader nothing has answered for another attempt", async () => {

  const harness = makeReader({

    official: true,
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

    settings: async (fetch: number): Promise<unknown> => {

      if(fetch === 1) {

        throw new Error("the controller is not answering");
      }

      return { access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } };
    }
  });

  await settle();

  // Staging at the refused construction seed is what proves the second read was dispatched by the restore rather than by construction settling late.
  assert.equal(harness.fetches.length, 1, "construction's seed went out and was refused");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "so nothing was created on the strength of a read that failed");

  harness.hub.onConnectionRestored();
  await settle();

  assert.equal(harness.fetches.length, 2, "a completed recovery gives that seed another chance");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "and the switch it makes knowable reads what the controller answered");
});

test("a confirmed access method write answers from the model before the controller echoes it, and a declined one changes nothing", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  // What the controller answers when the write is read back, which is the only thing that tells a change it applied from one it silently refused.
  const readBack = (enabled: string): unknown => ({ access_methods: { pin_code: { enabled: enabled, pin_code_shuffle: "no" } } });
  const reader = { capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "no" }] };

  const confirmed = makeReader({ official: true, record: hubRecord(reader), settings: async (): Promise<unknown> => readBack("yes") });

  await switchService(confirmed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On).handleSetRequest(true);

  assert.deepEqual(confirmed.updates, [{ access_methods: { pin_code: { enabled: "yes" } } }], "the write carries the desired state in the official vocabulary");

  // The record still states the value the write replaced, and the model is what answers: a read landing in the gap between a confirmed write and the controller's
  // own echo says what the controller confirmed rather than what the rows have yet to restate.
  assert.equal(await switchReads(confirmed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);

  // The negative control: the controller answered success while leaving the setting where it was. Nothing was confirmed, so nothing is folded.
  const declined = makeReader({ official: true, record: hubRecord(reader), settings: async (): Promise<unknown> => readBack("no") });

  await switchService(declined, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On).handleSetRequest(true);

  assert.equal(await switchReads(declined, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "a write the controller declined leaves the model where it was");
  assert.ok(declined.errors.some(line => line === LOG_PREFIX + "The controller declined the PIN access method change."), "and the decline is announced");
});

test("a record refresh moves the model, and a refresh restating rows already folded moves nothing", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const row = (value: string): unknown[] => [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value }];
  const reader = { capabilities: [ "is_hub", "is_reader", "pin_code" ] };

  // A refresh carrying genuine news moves what the switch answers, with no v2 event involved anywhere.
  const refreshed = makeReader({ record: hubRecord({ ...reader, configs: row("no") }) });

  assert.equal(await switchReads(refreshed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false);

  refreshRecord(refreshed, row("yes"));

  assert.equal(await switchReads(refreshed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "a row the refresh moved moves the model");

  // A row the record has dropped must leave no entry standing behind it, which is what makes the fold a rebuild rather than a merge.
  refreshRecord(refreshed, []);

  assert.equal(await switchReads(refreshed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "a row the record dropped leaves nothing standing");

  // The recency guard: a confirmed write moves the model ahead of the rows, and the rows restating what they said before must not drag it back.
  const written = makeReader({ official: true, record: hubRecord({ ...reader, configs: row("no") }),
    settings: async (): Promise<unknown> => ({ access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } }) });

  await switchService(written, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On).handleSetRequest(true);

  assert.equal(await switchReads(written, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);

  /* The delivery both real paths produce: a fresh configs array object whose access method rows still state the value the write replaced. A bootstrap refresh mints
   * one on every tick an unrelated field moved, and a terminal input row change produces the same thing on the websocket, so a fold keyed on the array's identity
   * would read this as news and revert the write. Translating equal to what the last fold applied is what makes it the no news it actually is.
   */
  refreshRecord(written, row("no"));

  assert.equal(await switchReads(written, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "a refresh restating rows already folded reverts nothing");
});

test("a UA Gate's opener closes through the close command and opens through the library's unlock", async () => {

  // Each direction is driven on a gate of its own, so what a write dispatches is read without the second write meeting a gate that is already moving.
  const closing = makeGate();

  await writeTarget(closing, Characteristic.TargetDoorState.CLOSED);

  // The closing direction is the library's own close, naming the main gate rather than leaving the door to the handle's first-port resolution.
  assert.deepEqual(closing.commands, [{ options: { doorId: MAIN_DOOR }, verb: "close" }]);
  assert.equal(closing.requests.length, 0, "a door command composes no request of its own");

  const opening = makeGate();

  await writeTarget(opening, Characteristic.TargetDoorState.OPEN);

  // The opening direction is the library's unlock, naming the gate's own door for the same reason the close does, and with no close sent along beside it.
  assert.deepEqual(opening.commands, [{ options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }]);

  /* Both directions leave the endpoint the plugin once composed for itself untouched. The assertion is the negative control against a half-finished migration: a door
   * command that still reached for the Access application's own endpoint would show up here rather than passing quietly.
   */
  assert.equal(opening.requests.length, 0, "the opening direction goes through the library's rail rather than an endpoint composed here");
});

test("a garage door opener on a door hub closes with the momentary pulse, on a credentialed client and a token-only one alike", async () => {

  /* The pulse is the library's plain unlock, naming no door for hardware that drives one and asking for no lock rule of any kind, so what it carries beyond the
   * attribution every unlock carries is nothing at all. Every client identity carries that unlock - a token-only client reaches it over the official API and a
   * credentialed one over the Access application's own - and which of them is in hand is not a difference this plugin sees.
   */
  assert.deepEqual(await openerDispatch({ credentials: true }, Characteristic.TargetDoorState.CLOSED), [{ options: { actor: UNLOCK_ACTOR }, verb: "unlock" }]);
  assert.deepEqual(await openerDispatch({ official: true }, Characteristic.TargetDoorState.CLOSED), [{ options: { actor: UNLOCK_ACTOR }, verb: "unlock" }]);
});

test("a garage door opener never consults the lock delay, in either direction", async () => {

  /* The lock delay interval is the lock accessory's setting. A garage door opener is a momentary operator, so a configured interval must not turn its closing
   * direction into the reset rule that ends a hold, nor its opening direction into the hold itself.
   */
  const held = { options: ["Enable.Hub.LockDelayInterval." + HUB_SERIAL + ".5"] };
  const pulse = [{ options: { actor: UNLOCK_ACTOR }, verb: "unlock" }];

  assert.deepEqual(await openerDispatch({}, Characteristic.TargetDoorState.CLOSED), pulse, "the closing direction at the default interval is the pulse");
  assert.deepEqual(await openerDispatch(held, Characteristic.TargetDoorState.CLOSED), pulse, "and a configured interval never makes it the reset rule");
  assert.deepEqual(await openerDispatch({}, Characteristic.TargetDoorState.OPEN), pulse, "the opening direction at the default interval is the same pulse");
  assert.deepEqual(await openerDispatch(held, Characteristic.TargetDoorState.OPEN), pulse, "and a configured interval never makes it a hold rule");
});

test("a refused close puts a gate's opener back and leaves the lock state and the pending relock exactly as they were", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate({ options: ["Enable.Hub.Lock.Trigger"], reject: ["close"] });
  const opener = openerService(gate);
  const trigger = switchService(gate, AccessReservedNames.SWITCH_LOCK_TRIGGER);

  // Unlock over MQTT first, so there is an unlocked state and a pending relock for the refused close below to leave alone, with the gate itself standing still.
  await gate.mqttSet("lock", "false");
  await settle();

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "the gate is unlocked after the trigger it opens on");

  await writeTarget(gate, Characteristic.TargetDoorState.CLOSED);
  t.mock.timers.tick(REVERT_DELAY_MS);

  // Nothing settled, so the transitional state HomeKit was shown goes back to where the gate actually stands.
  assert.equal(opener.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.OPEN);
  assert.equal(opener.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "a close the controller refused never locks the door behind HomeKit's back");

  // The unlock went through the library's own rail, and the close that followed it was dispatched and refused rather than never sent.
  assert.deepEqual(gate.commands, [ { options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }, { options: { doorId: MAIN_DOOR }, verb: "close" } ]);

  // A close nobody accepted ends no window, so the topic still stands where the unlock left it rather than announcing a gate that never locked.
  assert.deepEqual(lockPayloads(gate), ["false"], "a refused close announces nothing");

  // And the relock the unlock armed is still pending, because only a close that succeeded has anything to cancel.
  t.mock.timers.tick(RELOCK_DELAY_MS - REVERT_DELAY_MS);
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false, "the pending relock still runs its course");

  // The window ends on the relock instead, which is the announcement the refused close did not get to make.
  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);

});

test("a refused pulse puts a door hub's opener back", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const opener = makeOpener({ reject: ["unlock"] });
  const service = openerService(opener);

  await writeTarget(opener, Characteristic.TargetDoorState.CLOSED);
  t.mock.timers.tick(REVERT_DELAY_MS);

  assert.deepEqual(opener.commands, [{ options: { actor: UNLOCK_ACTOR }, verb: "unlock" }]);
  assert.equal(service.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.OPEN);
  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

});

test("a door hub's lock accessory still refuses a manual relock at the default settings", async () => {

  const hub = makeHub();
  const tile = lockService(hub);

  // A door the controller reports unlocked, so the relock below is a genuine state change rather than a sync from an event.
  hub.setDoorState({ dps: "none", location_id: MAIN_DOOR, lock: "unlock" });
  hub.hub.refreshDoorState();

  await writeLock(tile, Characteristic.LockTargetState.SECURED);

  assert.deepEqual(hub.commands, [], "the relock is refused before any command is dispatched");
  assert.ok(hub.errors.some(line => line.includes("Unable to manually relock the door when the lock relay is configured to the default settings.")),
    "the refusal says why the door cannot be relocked");
});

test("a UA Gate's lock accessory closes the gate, reads secured afterward, and cancels the relock it no longer needs", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate({ options: ["Enable.Hub.Door.Service=Lock"] });
  const tile = lockService(gate);

  // Unlock first: that is what arms the relock this close has to cancel, and what makes the relock below a genuine state change.
  await writeLock(tile, Characteristic.LockTargetState.UNSECURED);
  await writeLock(tile, Characteristic.LockTargetState.SECURED);

  assert.deepEqual(gate.commands, [ { options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }, { options: { doorId: MAIN_DOOR }, verb: "close" } ]);
  assert.equal(tile.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
    "a gate the controller closed reads secured rather than snapping back to unlocked");

  /* The controller then reports the gate unlocked again. A relock that had survived the close would fire on top of that report and lock the tile behind the
   * controller's own reading, which is what makes this the observable half of the cancellation.
   */
  deliverDoorState(gate, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });

  assert.equal(tile.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);
  t.mock.timers.tick(RELOCK_DELAY_MS);
  assert.equal(tile.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED, "no relock is left pending after a close");

});

test("a UA Gate's MQTT lock topic closes the gate and then answers locked", async () => {

  const gate = makeGate();

  await gate.mqttSet("lock", "false");
  await settle();
  await gate.mqttSet("lock", "true");
  await settle();

  assert.deepEqual(gate.commands, [ { options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }, { options: { doorId: MAIN_DOOR }, verb: "close" } ]);
  assert.equal(await gate.mqttGet("lock"), "true", "the topic answers the state the close established rather than the unlock before it");

  // The topic a subscriber watches saw the whole window rather than only the half a reader has to ask for.
  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
});

test("a UA Gate's side door relocks through the close command, on its own MQTT topic and on its own automation trigger", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate({ options: ["Enable.Hub.SideDoor.Lock.Trigger"] });

  await gate.mqttSet("sidedoor/lock", "false");
  await settle();
  await gate.mqttSet("sidedoor/lock", "true");
  await settle();

  // The side door is named explicitly on both verbs, because the handle's own resolution answers with whichever of the gate's two doors the controller listed first.
  assert.deepEqual(gate.commands, [ { options: { actor: UNLOCK_ACTOR, doorId: SIDE_DOOR }, verb: "unlock" }, { options: { doorId: SIDE_DOOR }, verb: "close" } ]);
  assert.equal(await gate.mqttGet("sidedoor/lock"), "true");
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), [ "false", "true" ], "the side door's own topic carried the whole window");

  /* The close ended the window and said so, and the relock it cancelled would say the same thing again if it had survived. Counting the sentence rather than
   * looking for its absence is what tells the close's own announcement from a relock firing on top of it.
   */
  t.mock.timers.tick(RELOCK_DELAY_MS);
  assert.equal(lineCount(gate, "Side door locked."), 1, "the close cancelled the side door's pending relock");

  // And the automation trigger reaches the same verb with the same door.
  await switchService(gate, AccessReservedNames.SWITCH_LOCK_DOOR_SIDE_TRIGGER).getCharacteristic(Characteristic.On).handleSetRequest(false);

  assert.deepEqual(gate.commands.map(command => command.options), [ { actor: UNLOCK_ACTOR, doorId: SIDE_DOOR }, { doorId: SIDE_DOOR }, { doorId: SIDE_DOOR } ]);
  assert.deepEqual(gate.commands.map(command => command.verb), [ "unlock", "close", "close" ]);

  // That third close ended nothing: the side door was already secured, so it added no payload and said nothing a second time.
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Side door locked."), 1);

});

test("a UA Gate's own lock automation trigger closes the gate", async () => {

  const gate = makeGate({ options: ["Enable.Hub.Lock.Trigger"] });

  // The switch mirrors the lock, so turning it off is asking for the locked direction.
  await switchService(gate, AccessReservedNames.SWITCH_LOCK_TRIGGER).getCharacteristic(Characteristic.On).handleSetRequest(false);

  assert.deepEqual(gate.commands, [{ options: { doorId: MAIN_DOOR }, verb: "close" }]);
});

test("a UA Gate opens for a client that holds only an API token", async () => {

  /* The client behind this gate holds no credentials at all. Which rail carries the unlock is the library's own decision, and its own suite's to prove; what this
   * arm asserts is that the plugin hands the unlock over whatever identity the client holds, rather than refusing an identity of its own accord.
   */
  const gate = makeGate({ credentials: false, official: true });

  await gate.mqttSet("lock", "false");
  await settle();

  assert.deepEqual(gate.commands, [{ options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }]);
  assert.deepEqual(gate.errors, [], "an identity the library can carry is not a refusal for this plugin to make");
});

test("every unlock names Homebridge as the actor behind it, whether or not it names a door", async () => {

  const gate = makeGate();

  await gate.mqttSet("lock", "false");
  await settle();

  /* The pair is spelled out here rather than read from the constant behind it, so what the arm proves is the identity the controller will file the unlock under
   * rather than that two references agree. The reference documents each member as required whenever the other is supplied, so half a pair is not a lesser
   * attribution but none at all, and asserting the options whole is what catches a member going missing.
   */
  assert.deepEqual(gate.commands, [{ options: { actor: { id: "homebridge-unifi-access", name: "Homebridge" }, doorId: MAIN_DOOR }, verb: "unlock" }]);

  // The same identity goes out on an unlock that names no door at all, which is what a door hub sends for its momentary pulse.
  assert.deepEqual(await openerDispatch({}, Characteristic.TargetDoorState.OPEN),
    [{ options: { actor: { id: "homebridge-unifi-access", name: "Homebridge" } }, verb: "unlock" }]);
});

test("an unlock a client cannot attribute is sent again unattributed, and opens the gate exactly as it always has", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  /* The refusal the library raises, and the sentence the plugin composes from it. The shared formatter drops the message's own full stop, so the composed line
   * ends with exactly one...spelling the expectation out rather than rebuilding it here is what makes that the assertion.
   */
  const refusal = "This UniFi Access client cannot carry an unlock attributed to an actor.";
  const noted = LOG_PREFIX + "The attributed unlock was refused, so it is being sent unattributed: This UniFi Access client cannot carry an unlock attributed " +
    "to an actor.";
  const gate = makeGate({ options: [ "Enable.Hub.Lock.Trigger", "Enable.Log.Debug" ], unlockRefusal: new AccessCapabilityError(refusal) });
  const trigger = switchService(gate, AccessReservedNames.SWITCH_LOCK_TRIGGER);

  await gate.mqttSet("lock", "false");
  await settle();

  /* Two dispatches, the second being the first with the actor dropped and nothing else moved. The door the retry still names is what tells a fallback reusing the
   * caller's options from one rebuilding them: a gate drives two doors, so an unlock that lost its door would open whichever one the handle resolved for itself.
   */
  assert.deepEqual(gate.commands, [ { options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }, { options: { doorId: MAIN_DOOR }, verb: "unlock" } ]);

  // The unlock landed, so the gate opened its window and announced it exactly as it does for a client that carries the attribution.
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true);
  assert.deepEqual(lockPayloads(gate), ["false"]);
  assert.equal(lineCount(gate, "Gate unlocked."), 1);

  /* What the user reads is nothing at all. An attribution the client cannot carry is the library's own routing decision rather than a fault of the unlock, so the
   * fallback is worth a note and nothing louder...and asserting the whole of what was said is what proves nothing was said beside it.
   */
  assert.deepEqual(gate.errors, [], "a fallback the library asked for is not an error the user has to read");
  assert.deepEqual(gate.debugs, [noted], "the fallback speaks once, at debug, and nothing louder is said beside it");

  // And the window still ends on the gate's own timer, which is the rest of the unlock behaving as it always has.
  t.mock.timers.tick(RELOCK_DELAY_MS);

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false);
  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
});

test("an unlock that fails for any reason but the attribution is reported as it always has been, and never sent twice", async () => {

  /* The fallback answers one thing: a client that cannot say who acted. Anything else is a fault of the unlock itself, so it surfaces through the command's own
   * reporting and is never quietly sent a second time - a catch reaching wider than the capability refusal would open this door twice on a fault that named it.
   */
  const failure = "The controller rejected the request.";
  const gate = makeGate({ unlockRefusal: new AccessOfficialApiError(failure, { code: "CODE_OPERATION_FORBIDDEN" }) });

  await gate.mqttSet("lock", "false");
  await settle();

  assert.deepEqual(gate.commands, [{ options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }], "one dispatch, and no retry behind it");
  assert.deepEqual(gate.errors, [LOG_PREFIX + "Unable to unlock the gate: The controller rejected the request."]);

  // Nothing announced and nothing armed, which is what an unlock the controller never performed has always left behind.
  assert.deepEqual(lockPayloads(gate), []);
  assert.equal(lineCount(gate, "Gate unlocked."), 0);
});

test("a gate unlocked from HomeKit announces the window it opened, and the relock announces the end of it exactly once", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate();

  await gate.mqttSet("lock", "false");
  await settle();

  /* The controller sends nothing back over the event stream for a door command of ours, so the announcement of the window is the plugin's own to make. Every
   * surface that can unlock a gate - this topic, the lock accessory, the opener, the automation triggers - reaches the one arm that makes it.
   */
  assert.deepEqual(lockPayloads(gate), ["false"]);
  assert.equal(lineCount(gate, "Gate unlocked."), 1);

  t.mock.timers.tick(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);

  // A second full delay finds nothing armed: a window ends once, and the relock that ended this one did not re-arm on its way out.
  t.mock.timers.tick(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);
});

test("a close inside the window ends it once, and the relock it cancelled adds nothing behind it", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate();

  await gate.mqttSet("lock", "false");
  await settle();
  await gate.mqttSet("lock", "true");
  await settle();

  // The close is what ended the window, so the topic carries both halves rather than stranding at the unlock's own.
  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);

  // A relock the close failed to cancel would announce the same ending a second time.
  t.mock.timers.tick(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);
});

test("a remote unlock opens the same window a command of ours does, on either of a gate's two doors", (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate();

  // The controller's own report of an unlock, delivered on the door's location identity rather than the hub's, which is how a gate's two doors are told apart.
  gate.emit(MAIN_DOOR, { event: "access.data.device.remote_unlock", event_object_id: MAIN_DOOR });

  assert.deepEqual(lockPayloads(gate), ["false"]);
  assert.equal(lineCount(gate, "Gate unlocked."), 1);

  // A second unlock while the window stands announces again and replaces the pending relock rather than stacking a second one beside it.
  gate.emit(MAIN_DOOR, { event: "access.data.device.remote_unlock", event_object_id: MAIN_DOOR });

  assert.deepEqual(lockPayloads(gate), [ "false", "false" ]);
  assert.equal(lineCount(gate, "Gate unlocked."), 2);

  t.mock.timers.tick(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1, "the replaced timer left exactly one relock to fire");

  // The side door runs the whole window on its own topic and under its own name, ending on the relock nobody cancelled.
  gate.emit(SIDE_DOOR, { event: "access.data.device.remote_unlock", event_object_id: SIDE_DOOR });

  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), ["false"]);
  assert.equal(lineCount(gate, "Side door unlocked."), 1);

  t.mock.timers.tick(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Side door locked."), 1);
});

test("a gate the controller reports locked retires the relock our own unlock armed", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate();

  await gate.mqttSet("lock", "false");
  await settle();

  // The rail's own report of the gate secured, which settles the door and announces it in the same voice the window speaks in.
  deliverDoorState(gate, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1, "the rail announces the closing in the gate's own voice");

  /* A relock has nothing left to do once the controller has reported the door secured. Left armed it would fire here and announce a closing of its own on top of
   * the controller's fresher reading, which is a state the door had already left.
   */
  t.mock.timers.tick(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1, "and the retired relock announced nothing on top of it");
});

test("a rail-reported lock and re-unlock inside the window leave no stale relock to announce over them", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate();

  await gate.mqttSet("lock", "false");
  await settle();

  /* The controller's own reading outranks the window we model. A relock still pending when the rail reports the door locked has nothing left to do, and left
   * armed it fires against whatever the door has become by the time it expires. The reports below are what tell the retirement from its absence: with
   * the door reported unlocked again, a surviving relock would both flip the state and speak over the controller's fresher truth.
   */
  deliverDoorState(gate, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });
  deliverDoorState(gate, { dps: "open", location_id: MAIN_DOOR, lock: "unlocked" });

  t.mock.timers.tick(RELOCK_DELAY_MS);

  // A relock the rail's own report failed to retire fires here and announces a close over the controller's fresher reading.
  assert.deepEqual(lockPayloads(gate), [ "false", "true", "false" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1, "the rail's own report of the closing is the only one anyone read");
  assert.equal(lineCount(gate, "Gate unlocked."), 2, "the window's own opening and the rail's re-unlock, each announced once");
});

test("a UA Gate reads both of the doors it drives from the door state map in one refresh", () => {

  const gate = makeGate({ options: ["Enable.Hub.Door.Service=Lock"] });

  // Both doors reported unlocked at once, which is the shape a single fold of a report naming both of them leaves in the map.
  gate.setDoorState({ dps: "open", location_id: MAIN_DOOR, lock: "unlocked" });
  gate.setDoorState({ dps: "open", location_id: SIDE_DOOR, lock: "unlocked" });
  gate.hub.refreshDoorState();

  assert.equal(lockService(gate).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);
  assert.equal(lockService(gate, AccessReservedNames.LOCK_DOOR_SIDE).getCharacteristic(Characteristic.LockCurrentState).value,
    Characteristic.LockCurrentState.UNSECURED);
  assert.deepEqual(lockPayloads(gate), ["false"]);
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), ["false"]);
  assert.equal(lineCount(gate, "Gate unlocked."), 1);
  assert.equal(lineCount(gate, "Side door unlocked."), 1);

  // The same readings again tell the doors nothing they do not already hold, so the delivery costs a settled gate nothing.
  gate.hub.refreshDoorState();

  assert.deepEqual(lockPayloads(gate), ["false"]);
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), ["false"]);
  assert.equal(lineCount(gate, "Gate unlocked."), 1);
  assert.equal(lineCount(gate, "Side door unlocked."), 1);
});

test("a UA Gate's side door reported locked retires the relock its own unlock armed", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate();

  await gate.mqttSet("sidedoor/lock", "false");
  await settle();

  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), ["false"]);
  assert.equal(lineCount(gate, "Side door unlocked."), 1);

  /* The controller's own reading outranks the window we model. A relock still pending when the rail reports the side door locked has nothing left to do, and
   * left armed it fires against whatever the door has become by the time it expires. The re-unlock below is what tells the retirement from its absence: the
   * close helper speaks only about a door standing unlocked, so a surviving relock is silent over a door already secured and shows itself only once the
   * controller has reported the door open again.
   */
  deliverDoorState(gate, { dps: "close", location_id: SIDE_DOOR, lock: "locked" });

  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Side door locked."), 1);
  assert.deepEqual(lockPayloads(gate), [], "the main door was not named by any of this, so nothing reached its topic");

  deliverDoorState(gate, { dps: "open", location_id: SIDE_DOOR, lock: "unlocked" });

  t.mock.timers.tick(RELOCK_DELAY_MS);

  // A relock the rail's own report failed to retire fires here and announces a close over the controller's fresher reading.
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), [ "false", "true", "false" ]);
  assert.equal(lineCount(gate, "Side door locked."), 1, "the rail's own report of the closing is the only one anyone read");
  assert.equal(lineCount(gate, "Side door unlocked."), 2, "the window's own opening and the rail's re-unlock, each announced once");
  assert.deepEqual(lockPayloads(gate), [], "and the main door was never named, so nothing reached its topic");
});

test("a UA Gate whose side door is turned off delivers its main door alone", () => {

  const gate = makeGate({ options: ["Disable.Hub.SideDoor"] });

  // The map is told about both doors. Only the door this gate drives may be read out of it.
  gate.setDoorState({ dps: "close", location_id: SIDE_DOOR, lock: "unlocked" });
  gate.setDoorState({ dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });
  gate.hub.refreshDoorState();

  assert.deepEqual(lockPayloads(gate), ["false"]);
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), []);
  assert.deepEqual(gate.lines.filter(line => line.startsWith(LOG_PREFIX + "Side door")), []);
  assert.equal(gate.services.some(service => service.subtype === AccessReservedNames.LOCK_DOOR_SIDE), false);
});

test("a hub inside its removal window refreshes nothing and throws nothing at the delivery", () => {

  /* Every hub on a controller sees every delivery, so a hub whose device has left controller state must not take its siblings down with it. The library's own
   * handle raises a ReferenceError in exactly that window, which is what leaves this hub with no door to read.
   */
  const departing = makeHub({ doorId: (): never => { throw new ReferenceError("The device is no longer present in controller state."); } });

  departing.setDoorState({ dps: "open", location_id: MAIN_DOOR, lock: "unlocked" });

  assert.doesNotThrow(() => departing.hub.refreshDoorState());
  assert.deepEqual(departing.publishes, []);
  assert.deepEqual(departing.lines, []);
  assert.equal(lockService(departing).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED);
});

test("a door hub announces what the controller reports under its own door's name, once per transition", () => {

  const hub = makeHub();

  deliverDoorState(hub, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });

  assert.deepEqual(lockPayloads(hub), ["false"]);
  assert.equal(lineCount(hub, "Door unlocked."), 1);

  // The same reading again is nothing the door does not already hold, so it neither publishes nor speaks.
  deliverDoorState(hub, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });

  assert.deepEqual(lockPayloads(hub), ["false"]);
  assert.equal(lineCount(hub, "Door unlocked."), 1);

  deliverDoorState(hub, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });

  assert.deepEqual(lockPayloads(hub), [ "false", "true" ]);
  assert.equal(lineCount(hub, "Door locked."), 1);

  // Every lock line names the door it describes, so none of them is the subject-less sentence a reader cannot place.
  assert.deepEqual(hub.lines.filter(line => line.endsWith(": Unlocked.") || line.endsWith(": Locked.")), []);
});

test("a door hub announces one remote unlock once, whichever of its two rails reports it first", () => {

  /* The controller reports an unlock on its remote-unlock rail and reports the door unlocked on the door-state rail, and either can arrive first. One physical
   * event is one announcement whichever ordering this hub sees.
   */
  const first = makeHub();

  first.emit(HUB_ID, { event: "access.data.device.remote_unlock", event_object_id: MAIN_DOOR });
  deliverDoorState(first, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });

  assert.deepEqual(lockPayloads(first), ["false"]);
  assert.equal(lineCount(first, "Door unlocked."), 1);
  assert.equal(lockService(first).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);

  // The same pair in the other order, which is the ordering the field's own same-second duplicate was read in.
  const second = makeHub();

  deliverDoorState(second, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });
  second.emit(HUB_ID, { event: "access.data.device.remote_unlock", event_object_id: MAIN_DOOR });

  assert.deepEqual(lockPayloads(second), ["false"]);
  assert.equal(lineCount(second, "Door unlocked."), 1);
  assert.equal(lockService(second).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);

  // And the door still moves on the next genuine transition rather than being left settled by the pair that reached it.
  deliverDoorState(second, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });

  assert.deepEqual(lockPayloads(second), [ "false", "true" ]);
  assert.equal(lineCount(second, "Door locked."), 1);
  assert.equal(lockService(second).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED);
});

test("the lock logging preference silences a door's lock lines and never its topic", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const hub = makeHub({ options: ["Disable.Log.Lock"] });

  deliverDoorState(hub, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });
  deliverDoorState(hub, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });

  // The lock lines alone are read: a first delivery also gives the position sensor its evidence, which the sensor announces on its own account.
  assert.deepEqual(lockPayloads(hub), [ "false", "true" ]);
  assert.deepEqual(hub.lines.filter(line => line.endsWith(" locked.") || line.endsWith(" unlocked.")), []);

  // A gate's own window speaks through the same helper, so the preference silences the window exactly as it silences the rail.
  const gate = makeGate({ options: ["Disable.Log.Lock"] });

  await gate.mqttSet("lock", "false");
  await settle();
  t.mock.timers.tick(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.deepEqual(gate.lines.filter(line => line.endsWith(" locked.") || line.endsWith(" unlocked.")), []);
});

test("an unlock the controller refuses says so and opens no window at all", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate({ reject: ["unlock"] });

  await gate.mqttSet("lock", "false");
  await settle();

  // The refusal is the library's own sentence, inside the wrapper this command reports every failure in.
  assert.deepEqual(gate.errors, [LOG_PREFIX + "Unable to unlock the gate: The controller refused this command."]);

  // Nothing announced and nothing armed: a window that never opened has no state to flip and no ending to reach.
  assert.deepEqual(lockPayloads(gate), []);
  assert.equal(lineCount(gate, "Gate unlocked."), 0);

  t.mock.timers.tick(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), []);
});

test("a write on a standing door starts the travel the opener renders, in the direction it was asked for", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  // A door the sensor reports open, asked to close.
  const closing = makeTravellingOpener({ doorState: { dps: "open", location_id: MAIN_DOOR, lock: "unlock" } });

  assert.equal(openerService(closing).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN);

  await writeTarget(closing, Characteristic.TargetDoorState.CLOSED);

  assert.equal(openerService(closing).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING);

  // And a door the sensor reports closed, asked to open.
  const opening = makeTravellingOpener({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" } });

  assert.equal(openerService(opening).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  await writeTarget(opening, Characteristic.TargetDoorState.OPEN);

  assert.equal(openerService(opening).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING);
});

test("a travel nobody confirms ends on its own timer, showing whatever the door reports by then", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  /* Each door below reports the same position throughout, and it is the opposite of what the travel was heading for. A settle that rendered the destination
   * rather than the evidence would answer the other way in every one of them.
   */
  const closing = makeTravellingOpener({ doorState: { dps: "open", location_id: MAIN_DOOR, lock: "unlock" } });

  await writeTarget(closing, Characteristic.TargetDoorState.CLOSED);
  t.mock.timers.tick(TRAVEL_MS - 1);

  assert.equal(openerService(closing).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING,
    "the travel runs for the whole duration configured for it");

  t.mock.timers.tick(1);

  assert.equal(openerService(closing).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN);

  const opening = makeTravellingOpener({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" } });

  await writeTarget(opening, Characteristic.TargetDoorState.OPEN);
  t.mock.timers.tick(TRAVEL_MS);

  assert.equal(openerService(opening).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  // And a door halted mid-travel comes to rest the same way, on the timer the halt re-armed.
  const halted = makeTravellingOpener({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" } });

  await writeTarget(halted, Characteristic.TargetDoorState.OPEN);
  await writeTarget(halted, Characteristic.TargetDoorState.CLOSED);

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);

  t.mock.timers.tick(TRAVEL_MS - 1);

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED,
    "the halt re-arms the travel timer rather than inheriting what was left of the old one");

  t.mock.timers.tick(1);

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

test("a gate operated mid-travel is halted through the library's own stop, from either direction", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Closing, then asked to open before it arrives.
  const closing = makeGate();

  await writeTarget(closing, Characteristic.TargetDoorState.CLOSED);
  await writeTarget(closing, Characteristic.TargetDoorState.OPEN);

  assert.deepEqual(closing.commands, [ { options: { doorId: MAIN_DOOR }, verb: "close" }, { options: { doorId: MAIN_DOOR }, verb: "stop" } ]);
  assert.equal(openerService(closing).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);

  // Opening, then asked to close before it arrives. The halt is the whole command: the gate is not also asked to close.
  const opening = makeGate();

  await writeTarget(opening, Characteristic.TargetDoorState.OPEN);
  await writeTarget(opening, Characteristic.TargetDoorState.CLOSED);

  assert.deepEqual(opening.commands, [ { options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }, { options: { doorId: MAIN_DOOR }, verb: "stop" } ]);
  assert.equal(opening.requests.length, 0, "neither the opening write nor the halt composes a request of its own");
  assert.equal(openerService(opening).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);
});

test("a gate whose client cannot carry a stop is halted all the same, and says why once", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = makeGate({ options: ["Enable.Log.Debug"], reject: ["stop"] });

  await writeTarget(gate, Characteristic.TargetDoorState.CLOSED);
  await writeTarget(gate, Characteristic.TargetDoorState.OPEN);

  // The gate stands where its travel left it whether or not the controller could be told to stop it, so the machine proceeds identically.
  assert.equal(openerService(gate).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);
  assert.deepEqual(gate.debugs.filter(line => line.includes("Unable to halt the gate")).length, 1, "the refusal is said once, at debug");
  assert.deepEqual(gate.errors, [], "and a halt the client cannot carry is not an error the user has to read");
});

test("a door hub's opener halts on its own pulse, and only once that pulse comes back", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const opener = makeTravellingOpener();

  await writeTarget(opener, Characteristic.TargetDoorState.CLOSED);
  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);

  // The halt is the operator's own pulse. The library scopes its stop to gate hardware, so nothing here reaches for it.
  assert.deepEqual(opener.commands.map(command => command.verb), [ "unlock", "unlock" ]);
  assert.equal(openerService(opener).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);

  // A pulse the controller refuses leaves the travel that was running, and the timer behind it, exactly where they were.
  const refusing = makeTravellingOpener({ reject: ["unlock"], rejectFrom: 2 });
  const service = openerService(refusing);

  await writeTarget(refusing, Characteristic.TargetDoorState.CLOSED);
  await writeTarget(refusing, Characteristic.TargetDoorState.OPEN);
  t.mock.timers.tick(REVERT_DELAY_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING);
  assert.equal(service.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.CLOSED);

  // The timer the first write armed is still the live one, so the travel ends on its own schedule rather than on one the refusal re-armed.
  t.mock.timers.tick(TRAVEL_MS - REVERT_DELAY_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

test("a halted door resumes the direction its own hardware answers to: a gate the target written, a momentary operator the reverse of the interrupted travel",
  async (t) => {

    t.mock.timers.enable({ apis: ["setTimeout"] });

    /* A momentary operator takes one input that names no direction, so its pulse reverses whatever the halt interrupted. The write below is the target that
     * agrees with the interrupted travel, so an implementation honoring the literal write renders the direction the door was already going.
     */
    const opener = makeTravellingOpener();

    await writeTarget(opener, Characteristic.TargetDoorState.CLOSED);
    await writeTarget(opener, Characteristic.TargetDoorState.OPEN);
    await writeTarget(opener, Characteristic.TargetDoorState.CLOSED);

    assert.equal(openerService(opener).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING,
      "the halt interrupted a closing door, so the next pulse opens it");

    /* A gate answers to two distinct verbs, so it travels the way the write names and the render follows the verb sent. Each write below is the target that
     * disagrees with what the interrupted travel would resume, so an implementation reversing the way a momentary operator does renders the opposite.
     */
    const opening = makeGate();

    await writeTarget(opening, Characteristic.TargetDoorState.OPEN);
    await writeTarget(opening, Characteristic.TargetDoorState.CLOSED);
    await writeTarget(opening, Characteristic.TargetDoorState.OPEN);

    assert.equal(openerService(opening).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING,
      "the resume was asked to open, and opening is the verb the gate is sent");

    // The resume is the unlock again, exactly as an opening write from a standstill is, with the halt between the two.
    assert.deepEqual(opening.commands, [ { options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }, { options: { doorId: MAIN_DOOR }, verb: "stop" },
      { options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" } ]);
    assert.equal(opening.requests.length, 0, "every one of the three goes through the library's own rail");

    // And the mirror: halted while closing, asked to close again.
    const closing = makeGate();

    await writeTarget(closing, Characteristic.TargetDoorState.CLOSED);
    await writeTarget(closing, Characteristic.TargetDoorState.OPEN);
    await writeTarget(closing, Characteristic.TargetDoorState.CLOSED);

    assert.equal(openerService(closing).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING,
      "the resume was asked to close, and closing is the verb the gate is sent");

    assert.deepEqual(closing.commands, [ { options: { doorId: MAIN_DOOR }, verb: "close" }, { options: { doorId: MAIN_DOOR }, verb: "stop" },
      { options: { doorId: MAIN_DOOR }, verb: "close" } ]);
  });

test("a closed reading settles every travel, and an open reading settles only an opening one", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const open = { dps: "open", location_id: MAIN_DOOR, lock: "unlock" };
  const closed = { dps: "close", location_id: MAIN_DOOR, lock: "unlock" };

  // Opening, told the door is closed: a closed reading is the reliable one, so it settles whatever was running.
  const openingClosed = makeTravellingOpener({ doorState: open });

  await writeTarget(openingClosed, Characteristic.TargetDoorState.OPEN);
  deliverDoorState(openingClosed, closed);

  assert.equal(openerService(openingClosed).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  // Closing, told the door is closed: the travel arrived.
  const closingClosed = makeTravellingOpener({ doorState: open });

  await writeTarget(closingClosed, Characteristic.TargetDoorState.CLOSED);
  deliverDoorState(closingClosed, closed);

  assert.equal(openerService(closingClosed).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  // Opening, told the door is open: the reading confirms the travel it belongs to.
  const openingOpen = makeTravellingOpener({ doorState: closed });

  await writeTarget(openingOpen, Characteristic.TargetDoorState.OPEN);
  deliverDoorState(openingOpen, open);

  assert.equal(openerService(openingOpen).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN);

  // Closing, told the door is open: a door on its way closed reads open right up until it arrives, so the reading settles nothing.
  const closingOpen = makeTravellingOpener({ doorState: closed });

  await writeTarget(closingOpen, Characteristic.TargetDoorState.CLOSED);
  deliverDoorState(closingOpen, open);

  assert.equal(openerService(closingOpen).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING);

  t.mock.timers.tick(TRAVEL_MS);

  assert.equal(openerService(closingOpen).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN,
    "and the travel still ends on its own timer, on the evidence it finds there");
});

test("a halted door settles on a closed reading and waits out an open one", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Halted, then told the door is closed: it arrived after all, so the halt is over.
  const settling = makeTravellingOpener({ doorState: { dps: "open", location_id: MAIN_DOOR, lock: "unlock" } });

  await writeTarget(settling, Characteristic.TargetDoorState.CLOSED);
  await writeTarget(settling, Characteristic.TargetDoorState.OPEN);

  assert.equal(openerService(settling).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);

  deliverDoorState(settling, { dps: "close", location_id: MAIN_DOOR, lock: "unlock" });

  assert.equal(openerService(settling).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  // Halted, then told the door is open: a door standing part-way reads open, which says nothing about whether it is still halted.
  const waiting = makeTravellingOpener({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" } });

  await writeTarget(waiting, Characteristic.TargetDoorState.OPEN);
  await writeTarget(waiting, Characteristic.TargetDoorState.CLOSED);

  deliverDoorState(waiting, { dps: "open", location_id: MAIN_DOOR, lock: "lock" });

  assert.equal(openerService(waiting).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);
});

test("a halted door whose sensor says nothing new still comes to rest on its own timer", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const halted = makeTravellingOpener({ doorState: { dps: "open", location_id: MAIN_DOOR, lock: "unlock" } });

  await writeTarget(halted, Characteristic.TargetDoorState.CLOSED);
  await writeTarget(halted, Characteristic.TargetDoorState.OPEN);

  // The same reading the door already held, which the delivery's own change detection swallows...so the timer is the halt's guaranteed way out.
  deliverDoorState(halted, { dps: "open", location_id: MAIN_DOOR, lock: "unlock" });

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);

  t.mock.timers.tick(TRAVEL_MS);

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN);
});

test("a door with no travel time to model renders instantly, and a UA Gate falls back to the window its hardware is given", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const opener = makeOpener();
  const service = openerService(opener);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);

  // Nothing transitional is shown and no timer is armed: the door goes on reporting where the evidence puts it.
  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  t.mock.timers.tick(TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  const gate = makeGate();
  const gateService = openerService(gate);

  await writeTarget(gate, Characteristic.TargetDoorState.CLOSED);

  assert.equal(gateService.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING);

  t.mock.timers.tick(GATE_TRAVEL_MS - 1);

  assert.equal(gateService.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING,
    "an unconfigured gate travels for the window that hardware is given");

  t.mock.timers.tick(1);

  assert.equal(gateService.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

test("an opener reads the door position sensor where one is wired, and the lock relay where none is", () => {

  // The sensor says open while the relay says locked. The two disagree deliberately, which is what tells the derivations apart.
  const sensed = makeOpener({ doorState: { dps: "open", location_id: MAIN_DOOR, lock: "lock" } });

  assert.equal(openerService(sensed).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN);

  // A door whose entry carries no position at all has only its relay to answer from, and the position we default to says the opposite.
  const unsensed = makeOpener({ doorState: { location_id: MAIN_DOOR, lock: "unlock" } });

  assert.equal(openerService(unsensed).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN);
});

test("one delivery makes one opener update, from both of its readings and in the order HomeKit expects", () => {

  const opener = makeOpener({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" } });
  const writes = recordWrites(openerService(opener));

  // One delivery moving the position and the relay at once, which is the shape that renders twice if each reading announces itself.
  deliverDoorState(opener, { dps: "open", location_id: MAIN_DOOR, lock: "unlock" });

  assert.deepEqual(writes, [ { characteristic: Characteristic.TargetDoorState.UUID, value: Characteristic.TargetDoorState.OPEN },
    { characteristic: Characteristic.CurrentDoorState.UUID, value: Characteristic.CurrentDoorState.OPEN } ]);
});

test("a UA Gate's MQTT position topic answers the state it holds, and a hub with no sensor still answers unknown", async () => {

  const gate = makeGate();

  // Drive the gate's position away from the state it was born holding, so an answer that ignored the live state cannot pass.
  deliverDoorState(gate, { dps: "open", location_id: MAIN_DOOR, lock: "locked" });

  assert.equal(await gate.mqttGet("dps"), "true");

  deliverDoorState(gate, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });

  assert.equal(await gate.mqttGet("dps"), "false");

  // A door hub with no position evidence at all still says so rather than guessing.
  assert.equal(await makeHub().mqttGet("dps"), "unknown");
});

test("a command the controller refuses leaves the machine standing and puts the characteristics back", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const opener = makeTravellingOpener({ reject: ["unlock"] });
  const service = openerService(opener);

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);
  t.mock.timers.tick(REVERT_DELAY_MS);

  assert.equal(service.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.CLOSED);
  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  // Nothing was armed, so nothing is waiting to expire: a travel that never began cannot end.
  t.mock.timers.tick(TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

test("the opener reports no obstruction, and a door is presented as one accessory or the other", async () => {

  const opener = makeOpener();

  assert.equal(await openerService(opener).getCharacteristic(Characteristic.ObstructionDetected).handleGetRequest(), false);
  assert.equal(opener.services.filter(entry => entry.UUID === Service.LockMechanism.UUID).length, 0, "acquiring the opener removes the lock it replaces");

  const lock = makeHub();

  assert.equal(lock.services.filter(entry => entry.UUID === Service.GarageDoorOpener.UUID).length, 0, "and a door presented as a lock has no opener beside it");
  assert.equal(lock.services.filter(entry => entry.UUID === Service.LockMechanism.UUID).length, 1);
});

test("the travel time is read at the write, so a door reconfigured while it runs travels for its new duration", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const opener = makeTravellingOpener();
  const service = openerService(opener);

  opener.reconfigure([ "Enable.Hub.Door.Service=GarageDoorOpener", "Enable.Hub.Door.TransitionDuration." + HUB_SERIAL + ".30" ]);

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);
  t.mock.timers.tick(TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING,
    "the duration the hub was built with is not the one in force");

  t.mock.timers.tick(30000 - TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

test("the opener shows the travel before the command behind it settles, and the machine takes only once it has", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const opener = makeTravellingOpener({ defer: "unlock" });
  const service = openerService(opener);
  const writing = writeTarget(opener, Characteristic.TargetDoorState.OPEN);

  await settle();

  // HomeKit already sees the travel while the command that carries it is still in flight.
  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING);

  // And nothing is armed behind it yet, so an expiry here would be the expiry of a travel that has not begun.
  t.mock.timers.tick(TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING);

  opener.release();
  await writing;

  // Now that the command has come back, the travel is the machine's and its own expiry is what ends it.
  t.mock.timers.tick(TRAVEL_MS - 1);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING);

  t.mock.timers.tick(1);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

// A doorbell ring on this hub's reader, naming the door guards the controller called, in the shape the wire sends it.
function ringPacket(guardIds: string[]): unknown {

  return { data: { channel: "ring", connected_uah_id: HUB_ID, device_id: READER_ID, door_guard_ids: guardIds, request_id: "ring-1" }, event: "access.remote_view" };
}

test("the door guard filter reads the selected guards at device scope and admits or refuses a ring on them", () => {

  // Debug logging is turned on for this harness alone, because the refusal is said at debug and the device's debug lines are gated on Log.Debug.
  const filtered = makeHub({ options: [ "Enable.Hub.Doorbell.DoorGuards." + HUB_SERIAL + "=guard-a,guard-b", "Enable.Log.Debug" ] });

  // A ring naming a selected guard reaches HomeKit and MQTT; one naming only another guard is refused at debug and reaches neither.
  filtered.emit("access.remote_view", ringPacket(["guard-b"]));
  filtered.emit("access.remote_view", ringPacket(["guard-c"]));

  assert.deepEqual(filtered.mqtt.published.filter(entry => entry.topic === HUB_SERIAL + "/doorbell"), [{ payload: "true", topic: HUB_SERIAL + "/doorbell" }]);
  assert.equal(lineCount(filtered, "Doorbell ring detected."), 1);
  assert.deepEqual(filtered.debugs.filter(line => line.startsWith(LOG_PREFIX + "Doorbell ring ignored")),
    [LOG_PREFIX + "Doorbell ring ignored: no door guard matched the configured filter."]);

  // The same selection written at global scope is not read, because the option is offered at device scope alone, so every ring is admitted.
  const global = makeHub({ options: ["Enable.Hub.Doorbell.DoorGuards=guard-a"] });

  global.emit("access.remote_view", ringPacket(["guard-c"]));

  assert.equal(lineCount(global, "Doorbell ring detected."), 1);

  // Nothing selected is no filtering, exactly as an unattributed ring is: both are admitted.
  const open = makeHub();

  open.emit("access.remote_view", ringPacket(["guard-c"]));
  open.emit("access.remote_view", ringPacket([]));

  assert.equal(lineCount(open, "Doorbell ring detected."), 2);
});

test("the door service choice resolves end to end: an explicit service, the automatic choice, and a device-scoped choice over a global one", () => {

  const carries = (harness: HubHarness, service: { UUID: string }): boolean => harness.services.some(entry => (entry.UUID === service.UUID) && !entry.subtype);

  // A gate told to be a lock is one; a gate told to decide for itself is the opener its hardware defaults to.
  assert.ok(carries(makeGate({ options: ["Enable.Hub.Door.Service=Lock"] }), Service.LockMechanism));
  assert.ok(carries(makeGate({ options: ["Enable.Hub.Door.Service=Automatic"] }), Service.GarageDoorOpener));

  // A hub told globally to be an opener but at its own scope to decide for itself is the lock its hardware defaults to.
  const hub = makeHub({ options: [ "Enable.Hub.Door.Service=GarageDoorOpener", "Enable.Hub.Door.Service." + HUB_SERIAL + "=Automatic" ] });

  assert.ok(carries(hub, Service.LockMechanism));
  assert.ok(!carries(hub, Service.GarageDoorOpener));
});

test("a reader with no access method selected creates no switch and retires one the accessory carried", () => {

  const harness = makeHub({

    existing: [AccessReservedNames.SWITCH_ACCESSMETHOD_NFC],
    record: hubRecord({ capabilities: [ "is_hub", "is_reader", "nfc_card_easy_provision", "pin_code" ],
      configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] })
  });

  // The model seeded from the rows, so the pass ran; with nothing selected it materialized nothing and retired the switch a previous run left.
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "no switch is created for a method nobody selected");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "and a switch nobody selects any longer is retired");
});

test("a selection creates exactly the selected switches, at the device's own scope over the global one, in any case the entry spelled them", async () => {

  const record = hubRecord({ capabilities: [ "is_hub", "is_reader", "nfc_card_easy_provision", "pin_code", "qr_code" ],
    configs: [ { device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }, { device_id: HUB_ID, key: "nfc", tag: "open_door_mode", value: "no" } ] });

  // The global selection names two methods; the device's own names one, spelled in lower case, and it is the device's that counts.
  const scoped = makeHub({ options: [ "Enable.AccessMethod.Switches=PIN,QR", "Enable.AccessMethod.Switches." + HUB_SERIAL + "=nfc" ], record });

  assert.ok(hasSwitch(scoped, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "the device's own selection is materialized");
  assert.ok(!hasSwitch(scoped, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and the global selection is not read past it");
  assert.ok(!hasSwitch(scoped, AccessReservedNames.SWITCH_ACCESSMETHOD_QR));
  assert.equal(await switchReads(scoped, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), false, "the switch still answers from the model");

  // The same reader with the global selection alone materializes exactly the two it names, and nothing for the method it leaves out.
  const global = makeHub({ options: ["Enable.AccessMethod.Switches=PIN,QR"], record });

  assert.ok(hasSwitch(global, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN));
  assert.ok(hasSwitch(global, AccessReservedNames.SWITCH_ACCESSMETHOD_QR));
  assert.ok(!hasSwitch(global, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC));
});

// A configuration row as a hub's record carries one: the device it belongs to, the key it is read by, the family it belongs to, and the reading it reports.
interface ConfigRow {

  device_id: string;
  key: string;
  tag: string;
  value: string;
}

/* The configuration rows of one family, addressed to this hub, in the shape its record carries them.
 *
 * @param tag     - The family the rows belong to.
 * @param entries - The key each row is read by and the reading it reports.
 *
 * @returns The rows.
 */
function hubRows(tag: string, entries: { key: string; value: string }[]): ConfigRow[] {

  return entries.map(({ key, value }) => ({ device_id: HUB_ID, key, tag, value }));
}

// The wiring rows behind a terminal input's live circuit detection, which is the evidence a sensor is created on.
function wiringRows(pairs: { key: string; value: string }[]): ConfigRow[] {

  return hubRows("wiring", pairs);
}

// The rows a hub reports its terminal input readings through, which is what a created sensor answers from.
function inputRows(readings: { key: string; value: string }[]): ConfigRow[] {

  return hubRows("input", readings);
}

// Every wiring key a terminal input is detected through across the hub families that name one, so an arm can offer a family all the evidence there is.
const EVERY_WIRE = [ "wiring_state_d1-button-neg", "wiring_state_d1-button-pos", "wiring_state_rel-neg", "wiring_state_rel-pos", "wiring_state_ren-neg",
  "wiring_state_ren-pos", "wiring_state_rex-neg", "wiring_state_rex-pos" ];

// Every one of those pairs reporting a live circuit, which is the most a record can say about its terminal inputs.
const EVERY_PAIR_LIVE = wiringRows(EVERY_WIRE.map(key => ({ key, value: "on" })));

// The remote release pair alone, which is what the arms about one input's own lifecycle vary.
const REL_PAIR_LIVE = wiringRows([ { key: "wiring_state_rel-neg", value: "on" }, { key: "wiring_state_rel-pos", value: "on" } ]);

// The request to exit pair a UA Hub Door Mini reports its one input through.
const D1_PAIR_LIVE = wiringRows([ { key: "wiring_state_d1-button-neg", value: "on" }, { key: "wiring_state_d1-button-pos", value: "on" } ]);

// A UA Hub reporting every terminal input wired, with each input reading whatever the arm names.
function wiredHub(reading: string): AccessStateDevice & { mac: string } {

  return hubRecord({ configs: [ ...EVERY_PAIR_LIVE, ...inputRows([ { key: "input_state_rel", value: reading }, { key: "input_state_ren", value: reading },
    { key: "input_state_rex", value: reading } ]) ] });
}

// A UA Hub Door Mini reporting its one terminal input wired, reading whatever the arm names.
function doorMiniHub(reading: string): AccessStateDevice & { mac: string } {

  return hubRecord({ configs: [ ...D1_PAIR_LIVE, ...inputRows([{ key: "input_d1_button", value: reading }]) ], device_type: "UA-Hub-Door-Mini" });
}

/* A UA Ultra whose one multiplexed terminal input is configured for the mode an arm names, carried in the port setting extension the controller reports it through.
 *
 * @param mode - What the input is configured for.
 *
 * @returns The record.
 */
function ultraRecord(mode: string): AccessStateDevice & { mac: string } {

  return hubRecord({ device_type: "UA-ULTRA", extensions: [{ device_id: HUB_ID, extension_name: "port_setting",
    target_config: [{ config_key: "rex_button_mode", config_tag: "", config_value: mode }], target_type: "device", unique_id: "extension-1" }] });
}

// A doorbell-capable reader hanging off this hub, as the client's device snapshot carries it, which is the device a dispatched ring is addressed to.
const READER_RECORD = hubRecord({ capabilities: [ "is_reader", "remote_view" ], connected_uah_id: HUB_ID, device_type: "UA-G2-PRO", unique_id: READER_ID });

// Every terminal input sensor, which most of the arms below sweep over together.
const TERMINAL_SUBTYPES = [ AccessReservedNames.CONTACT_REL, AccessReservedNames.CONTACT_REN, AccessReservedNames.CONTACT_REX ];

// What each of those sensors says for itself when it is created, in the sentence a user reads.
const TERMINAL_ENABLED = [ "Enabling the remote release.", "Enabling the request to enter sensor.", "Enabling the request to exit sensor." ];

test("a hub creates a terminal input's sensor the moment its wiring reports live, announces it once, and seeds it from the input's own reading", async () => {

  const harness = makeHub();

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(!hasContactSensor(harness, subtype), "a record offering no wiring evidence carries no " + subtype + " to begin with");
  }

  restateRecord(harness, { configs: [ ...EVERY_PAIR_LIVE, ...inputRows([ { key: "input_state_rel", value: "on" }, { key: "input_state_ren", value: "on" },
    { key: "input_state_rex", value: "on" } ]) ] });

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(hasContactSensor(harness, subtype), subtype + " is created the moment its wiring reports live");
    assert.equal(contactSensor(harness, subtype).getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_DETECTED, subtype + " is seeded from the reading its record carries");
  }

  const availability = await Promise.all(TERMINAL_SUBTYPES.map(async (subtype): Promise<unknown> => {

    return contactSensor(harness, subtype).getCharacteristic(Characteristic.StatusActive).handleGetRequest();
  }));

  assert.deepEqual(availability, TERMINAL_SUBTYPES.map(() => true), "and every sensor is dressed with the availability it answers reads from");

  for(const sentence of TERMINAL_ENABLED) {

    assert.equal(lineCount(harness, sentence), 1, "each sensor announces itself exactly once: " + sentence);
  }

  // A hub adopted on the same evidence seeds its sensors the same way, and one whose inputs all report open seeds the other reading.
  const closed = makeHub({ record: wiredHub("on") });
  const opened = makeHub({ record: wiredHub("off") });

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.equal(contactSensor(closed, subtype).getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_DETECTED, subtype + " reads closed at adoption where its input says so");
    assert.equal(contactSensor(opened, subtype).getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED, subtype + " reads open at adoption where its input says so");
  }
});

test("a hub withholds a terminal input's sensor where its wiring evidence is absent or half-wired, and wherever the family drives no such input", () => {

  // A record that reports no wiring at all offers no evidence, and nothing is announced for a sensor that was never made.
  const bare = makeHub();

  restateRecord(bare, { configs: [] });

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(!hasContactSensor(bare, subtype), "a UA Hub reporting no wiring carries no " + subtype);
  }

  for(const sentence of TERMINAL_ENABLED) {

    assert.equal(lineCount(bare, sentence), 0, "and nothing announces a sensor that was never made: " + sentence);
  }

  // One terminal of a pair is a half-wired sensor, which is not a sensor.
  const half = makeHub({ record: hubRecord({ configs: wiringRows([ { key: "wiring_state_rel-neg", value: "on" }, { key: "wiring_state_ren-neg", value: "on" },
    { key: "wiring_state_rex-neg", value: "on" } ]) }) });

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(!hasContactSensor(half, subtype), "a UA Hub reporting one terminal of a pair carries no " + subtype);
  }

  // A UA Gate and an Enterprise hub drive no terminal input at all, so the most generous evidence a record can carry still says nothing about them.
  const gate = makeGate({ record: hubRecord({ configs: EVERY_PAIR_LIVE, device_type: "UGT" }) });
  const enterprise = makeHub({ record: hubRecord({ configs: EVERY_PAIR_LIVE, device_type: "UAH-Ent" }) });

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(!hasContactSensor(gate, subtype), "a UA Gate carries no " + subtype);
    assert.ok(!hasContactSensor(enterprise, subtype), "an Enterprise hub carries no " + subtype);
  }

  // The Door Mini drives a request to exit alone, through wiring keys of its own.
  const mini = makeHub({ record: doorMiniHub("on") });

  assert.ok(hasContactSensor(mini, AccessReservedNames.CONTACT_REX), "a UA Hub Door Mini carries its request to exit sensor");
  assert.ok(!hasContactSensor(mini, AccessReservedNames.CONTACT_REL), "and a UA Hub Door Mini carries no remote release");
  assert.ok(!hasContactSensor(mini, AccessReservedNames.CONTACT_REN), "and a UA Hub Door Mini carries no request to enter sensor");

  // The Ultra multiplexes its one input and reports no wiring pair at all, so what that input is configured for is the whole of the evidence.
  const ultra = makeHub({ record: ultraRecord("rex") });
  const positioned = makeHub({ record: ultraRecord("dps") });
  const unconfigured = makeHub({ record: hubRecord({ device_type: "UA-ULTRA" }) });

  assert.ok(hasContactSensor(ultra, AccessReservedNames.CONTACT_REX), "a UA Ultra configured for a request to exit carries that sensor, with no wiring row at all");
  assert.ok(!hasContactSensor(ultra, AccessReservedNames.CONTACT_REL), "and a UA Ultra carries no remote release");
  assert.ok(!hasContactSensor(ultra, AccessReservedNames.CONTACT_REN), "and a UA Ultra carries no request to enter sensor");

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(!hasContactSensor(positioned, subtype), "a UA Ultra configured for a door position sensor carries no " + subtype);
    assert.ok(!hasContactSensor(unconfigured, subtype), "and a UA Ultra reporting no extensions at all carries no " + subtype);
  }
});

test("a hub keeps a terminal input's sensor through a silence about its wiring and retires it only when the user turns the option off", () => {

  const harness = makeHub({ record: hubRecord({ configs: REL_PAIR_LIVE }) });

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the pair reporting live is what creates the sensor");

  // The hardware falling silent about the wiring is a window to sit through rather than a removal to act on, so the sensor stays and nothing is said.
  restateRecord(harness, { configs: [] });

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "a record that stops reporting the pair keeps the sensor already standing");
  assert.equal(lineCount(harness, "Disabling the remote release."), 0, "and the hub says nothing about a sensor it kept");

  // The user's own toggle is absolute, and the next update is what carries it into HomeKit.
  harness.reconfigure(["Disable.Hub.REL"]);
  restateRecord(harness, { configs: [] });

  assert.ok(!hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the toggle turned off retires the sensor");
  assert.equal(lineCount(harness, "Disabling the remote release."), 1, "and the retirement is announced exactly once");

  // A hub adopted with the toggle already off never carries the sensor, whatever its wiring reports.
  const disabled = makeHub({ options: ["Disable.Hub.REL"], record: hubRecord({ configs: EVERY_PAIR_LIVE }) });

  assert.ok(!hasContactSensor(disabled, AccessReservedNames.CONTACT_REL), "and a hub adopted with the toggle off never carries it");
  assert.ok(hasContactSensor(disabled, AccessReservedNames.CONTACT_REN), "while the inputs the user left alone are untouched by it");
});

test("a hub carries a terminal input's change to the characteristic, the topic, and the log exactly once, and carries a repeat of the same reading nowhere", () => {

  const harness = makeHub({ record: hubRecord({ configs: [ ...REL_PAIR_LIVE, ...inputRows([{ key: "input_state_rel", value: "on" }]) ] }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REL);

  restateRecord(harness, { configs: [ ...REL_PAIR_LIVE, ...inputRows([{ key: "input_state_rel", value: "off" }]) ] });

  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    "the input opening reaches the characteristic");
  assert.equal(lineCount(harness, "Remote release open."), 1, "and is announced once");

  restateRecord(harness, { configs: [ ...REL_PAIR_LIVE, ...inputRows([{ key: "input_state_rel", value: "on" }]) ] });

  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_DETECTED,
    "the input closing reaches it too");
  assert.equal(lineCount(harness, "Remote release closed."), 1, "and is announced once");

  // The same reading restated is not a change, so it reaches none of them.
  restateRecord(harness, { configs: [ ...REL_PAIR_LIVE, ...inputRows([{ key: "input_state_rel", value: "on" }]) ] });

  assert.deepEqual(topicPayloads(harness, "rel"), [ "true", "false" ], "each change publishes exactly once, and a repeat publishes nothing");
  assert.equal(lineCount(harness, "Remote release closed."), 1, "and a repeat is announced no second time");

  // The Door Mini reports the same kind of input through a key of its own, and its readings travel the request to exit surface the same way.
  const mini = makeHub({ record: doorMiniHub("on") });
  const miniSensor = contactSensor(mini, AccessReservedNames.CONTACT_REX);

  restateRecord(mini, { configs: [ ...D1_PAIR_LIVE, ...inputRows([{ key: "input_d1_button", value: "off" }]) ] });

  assert.equal(miniSensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
  assert.equal(lineCount(mini, "Request to exit sensor open."), 1);

  restateRecord(mini, { configs: [ ...D1_PAIR_LIVE, ...inputRows([{ key: "input_d1_button", value: "on" }]) ] });

  assert.deepEqual(topicPayloads(mini, "rex"), [ "true", "false" ], "the Door Mini's readings reach the request to exit topic");
  assert.equal(lineCount(mini, "Request to exit sensor closed."), 1);

  // The log option is the user's own, and turning it off silences the sentence without withholding the reading from anything else.
  const quiet = makeHub({ options: ["Disable.Log.REL"], record: hubRecord({ configs: [ ...REL_PAIR_LIVE, ...inputRows([{ key: "input_state_rel", value: "on" }]) ] }) });

  restateRecord(quiet, { configs: [ ...REL_PAIR_LIVE, ...inputRows([{ key: "input_state_rel", value: "off" }]) ] });

  assert.equal(contactSensor(quiet, AccessReservedNames.CONTACT_REL).getCharacteristic(Characteristic.ContactSensorState).value,
    Characteristic.ContactSensorState.CONTACT_NOT_DETECTED, "the reading still reaches HomeKit");
  assert.deepEqual(topicPayloads(quiet, "rel"), ["true"], "and is still published");
  assert.equal(lineCount(quiet, "Remote release open."), 0, "while the sentence the user turned off is not written");
});

test("a UA Hub reads each terminal input from its own row, so no input can answer with another's reading", () => {

  /* Every other arm drives a UA Hub's three rows to one value together, which cannot tell the rows apart: a table naming the wrong row for an input would answer
   * identically. Here each restate moves exactly one row, so each sensor is read against the two that did not move.
   */
  const harness = makeHub({ record: wiredHub("off") });
  const readings = (): unknown[] => TERMINAL_SUBTYPES.map(subtype => contactSensor(harness, subtype).getCharacteristic(Characteristic.ContactSensorState).value);
  const closed = Characteristic.ContactSensorState.CONTACT_DETECTED;
  const open = Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;

  refreshRecord(harness, [ ...EVERY_PAIR_LIVE, ...inputRows([ { key: "input_state_rel", value: "on" }, { key: "input_state_ren", value: "off" },
    { key: "input_state_rex", value: "off" } ]) ]);

  assert.deepEqual(readings(), [ closed, open, open ], "the remote release row alone reads on, and the remote release alone answers closed");

  refreshRecord(harness, [ ...EVERY_PAIR_LIVE, ...inputRows([ { key: "input_state_rel", value: "off" }, { key: "input_state_ren", value: "on" },
    { key: "input_state_rex", value: "off" } ]) ]);

  assert.deepEqual(readings(), [ open, closed, open ], "the request to enter row alone reads on, and only that sensor follows it");

  refreshRecord(harness, [ ...EVERY_PAIR_LIVE, ...inputRows([ { key: "input_state_rel", value: "off" }, { key: "input_state_ren", value: "off" },
    { key: "input_state_rex", value: "on" } ]) ]);

  assert.deepEqual(readings(), [ open, open, closed ], "and the request to exit row alone reads on");
});

test("a terminal input whose wiring falls silent keeps its sensor, reads closed, and announces nothing", () => {

  const harness = makeHub({ record: hubRecord({ configs: [ ...REL_PAIR_LIVE, ...inputRows([{ key: "input_state_rel", value: "off" }]) ] }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REL);

  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    "a wired input whose row reads off is open");

  /* The wiring rows go away while the reading row stays exactly where it was. The service survives, because the gate keeps one already standing through a wiring
   * silence, and the reading falls back to the closed default an input carrying no wiring evidence has.
   */
  refreshRecord(harness, inputRows([{ key: "input_state_rel", value: "off" }]));

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the sensor already standing survives the silence");
  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_DETECTED,
    "and an input with no wiring evidence reads closed whatever its row still says");
  assert.deepEqual(topicPayloads(harness, "rel"), [], "the closed default is not a reading to publish");
  assert.equal(lineCount(harness, "Remote release closed."), 0, "and not a change to announce");
});

test("a hub's wiring table and the option catalog's model lists agree about which family drives which terminal input", () => {

  const families = [ "UAH", "UA-Hub-Door-Mini", "UA-ULTRA", "UGT", "UAH-Ent" ];
  const inputs = [ { name: "REL", subtype: AccessReservedNames.CONTACT_REL }, { name: "REN", subtype: AccessReservedNames.CONTACT_REN },
    { name: "REX", subtype: AccessReservedNames.CONTACT_REX } ];

  /* The catalog and the wiring table state model support in different vocabularies - the catalog names display models and the wiring table names device types - so
   * the plugin's own resolver is what puts them on one footing. Reading the catalog the option engine runs on is what makes this an agreement rather than a copy.
   */
  for(const deviceType of families) {

    const harness = makeHub({ record: (deviceType === "UA-ULTRA") ? ultraRecord("rex") : hubRecord({ configs: EVERY_PAIR_LIVE, device_type: deviceType }) });

    for(const { name, subtype } of inputs) {

      const entry = (featureOptions["Hub"] ?? []).find(option => option.name === name);

      assert.ok(entry, "the catalog should declare Hub." + name);

      const supported = (entry.meta?.modelKey ?? []).some(model => model === officialDeviceModel(deviceType));

      assert.equal(hasContactSensor(harness, subtype), supported, "the " + name + " sensor on a " + deviceType + " follows the catalog's own model list");
    }
  }
});

test("a hub delivers a doorbell ring to HomeKit, its trigger switch, the topic, and the log, and delivers a ring that is not its own nowhere", async () => {

  const harness = makeHub({ options: ["Enable.Hub.Doorbell.Trigger"] });
  const presses = switchEvents(doorbellService(harness));
  const trigger = switchService(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  assert.deepEqual(presses, [], "nothing is delivered before a ring arrives");

  harness.emit("access.remote_view", ringPacket([]));

  assert.deepEqual(presses, [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS], "the ring reaches HomeKit as a single press");
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "the trigger switch mirrors the ring");
  assert.equal(await trigger.getCharacteristic(Characteristic.On).handleGetRequest(), true, "and answers a read from the ring the hub is holding");
  assert.deepEqual(topicPayloads(harness, "doorbell"), ["true"], "the ring is published");
  assert.equal(lineCount(harness, "Doorbell ring detected."), 1, "and announced once");

  // A ring the controller attributed to another hub is not this hub's to answer.
  const foreign = makeHub({ options: ["Enable.Hub.Doorbell.Trigger"] });
  const foreignPresses = switchEvents(doorbellService(foreign));

  foreign.emit("access.remote_view", { data: { channel: "ring", connected_uah_id: "another-hub", device_id: READER_ID, door_guard_ids: [], request_id: "ring-9" },
    event: "access.remote_view" });

  assert.deepEqual(foreignPresses, [], "a ring naming another hub reaches HomeKit nowhere");
  assert.equal(switchService(foreign, AccessReservedNames.SWITCH_DOORBELL_TRIGGER).getCharacteristic(Characteristic.On).value, false,
    "and moves no trigger switch");
  assert.deepEqual(topicPayloads(foreign, "doorbell"), [], "and publishes nothing");
  assert.equal(lineCount(foreign, "Doorbell ring detected."), 0, "and says nothing");

  // Hardware with no doorbell has no ring to answer, whatever the wire says.
  const mute = makeHub({ record: hubRecord({ capabilities: ["is_hub"] }) });

  mute.emit("access.remote_view", ringPacket([]));

  assert.ok(!hasDoorbell(mute), "a hub reporting no doorbell hardware carries no doorbell");
  assert.deepEqual(topicPayloads(mute, "doorbell"), [], "and publishes nothing for a ring addressed to it");
  assert.equal(lineCount(mute, "Doorbell ring detected."), 0, "and says nothing");

  // The user's own toggles govern each surface separately: the doorbell can be withheld, and the trigger switch is offered rather than assumed.
  assert.ok(!hasDoorbell(makeHub({ options: ["Disable.Hub.Doorbell"] })), "a hub told to carry no doorbell carries none");

  const untriggered = makeHub();
  const untriggeredPresses = switchEvents(doorbellService(untriggered));

  assert.ok(!hasSwitch(untriggered, AccessReservedNames.SWITCH_DOORBELL_TRIGGER), "the trigger switch is off by default");

  untriggered.emit("access.remote_view", ringPacket([]));

  assert.deepEqual(untriggeredPresses, [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS], "and a ring still reaches HomeKit without one");
  assert.equal(lineCount(untriggered, "Doorbell ring detected."), 1, "and is still announced");
});

test("a hub ends a doorbell ring on the cancel that names it, and on no other", () => {

  const harness = makeHub({ options: ["Enable.Hub.Doorbell.Trigger"] });
  const trigger = switchService(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  harness.emit("access.remote_view", ringPacket([]));
  harness.emit("access.remote_view.change", { data: { remote_call_request_id: "ring-2" }, event: "access.remote_view.change" });

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "a cancel naming another call leaves this ring standing");
  assert.deepEqual(topicPayloads(harness, "doorbell"), ["true"], "and publishes nothing");
  assert.equal(lineCount(harness, "Doorbell ring cancelled."), 0, "and says nothing");

  harness.emit("access.remote_view.change", { data: { remote_call_request_id: "ring-1" }, event: "access.remote_view.change" });

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false, "the cancel that names the ring is what ends it");
  assert.deepEqual(topicPayloads(harness, "doorbell"), [ "true", "false" ], "and the end is published");
  assert.equal(lineCount(harness, "Doorbell ring cancelled."), 1, "and announced once");

  // The ring is already over, so a repeat of the same cancel has nothing left to end.
  harness.emit("access.remote_view.change", { data: { remote_call_request_id: "ring-1" }, event: "access.remote_view.change" });

  assert.deepEqual(topicPayloads(harness, "doorbell"), [ "true", "false" ], "a second cancel publishes nothing further");
  assert.equal(lineCount(harness, "Doorbell ring cancelled."), 1, "and says nothing further");
});

test("the doorbell trigger switch rings and cancels through the official API and settles back onto the ring the controller reports", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const harness = makeHub({ devices: [READER_RECORD], official: true, options: ["Enable.Hub.Doorbell.Trigger"] });
  const trigger = harness.services.find(service => service.subtype === AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  assert.ok(trigger, "the hub should have configured the doorbell trigger switch");

  await trigger.getCharacteristic(Characteristic.On).handleSetRequest(true);

  assert.deepEqual(harness.rings, [{ cancel: false, readerId: READER_ID }], "a write while the doorbell is quiet rings the reader that carries the call surface");

  // A dispatched ring earns the longer window, so the pause a refused write settles in passes without moving the switch.
  t.mock.timers.tick(REVERT_DELAY_MS);

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "the switch stands while the controller still has time to confirm");

  t.mock.timers.tick(DOORBELL_RECONCILE_DELAY_MS - REVERT_DELAY_MS);

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false, "and settles back onto ring truth when no ring ever arrived");

  // A ring arriving inside that window is what the wake finds, so the switch stays where the dispatch put it.
  const confirmed = makeHub({ devices: [READER_RECORD], official: true, options: ["Enable.Hub.Doorbell.Trigger"] });
  const confirmedTrigger = switchService(confirmed, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  await confirmedTrigger.getCharacteristic(Characteristic.On).handleSetRequest(true);
  confirmed.emit("access.remote_view", ringPacket([]));
  t.mock.timers.tick(DOORBELL_RECONCILE_DELAY_MS);

  assert.equal(confirmedTrigger.getCharacteristic(Characteristic.On).value, true, "the ring the controller confirmed is what the switch settles onto");

  await confirmedTrigger.getCharacteristic(Characteristic.On).handleSetRequest(false);

  assert.deepEqual(confirmed.rings, [ { cancel: false, readerId: READER_ID }, { cancel: true, readerId: READER_ID } ],
    "and a write against a live ring cancels it through the same reader");

  // A write that agrees with the mirror asks for what is already true, which is nothing to dispatch and nothing to complain about.
  const agreeing = makeHub({ devices: [READER_RECORD], official: true, options: ["Enable.Hub.Doorbell.Trigger"] });

  await switchService(agreeing, AccessReservedNames.SWITCH_DOORBELL_TRIGGER).getCharacteristic(Characteristic.On).handleSetRequest(false);

  assert.deepEqual(agreeing.rings, [], "a write agreeing with the mirror dispatches nothing");
  assert.deepEqual(agreeing.errors, [], "and is not an error the user has to read");

  // The endpoint addresses a reader rather than the hub, so a hub with none attached has nowhere to send the ring.
  const unattached = makeHub({ official: true, options: ["Enable.Hub.Doorbell.Trigger"] });
  const unattachedTrigger = switchService(unattached, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  await unattachedTrigger.getCharacteristic(Characteristic.On).handleSetRequest(true);

  assert.deepEqual(unattached.rings, [], "a hub with no doorbell-capable reader dispatches nothing");
  assert.deepEqual(unattached.errors, [LOG_PREFIX + "Unable to ring the doorbell: no doorbell-capable reader is connected to this hub."]);

  t.mock.timers.tick(REVERT_DELAY_MS);

  assert.equal(unattachedTrigger.getCharacteristic(Characteristic.On).value, false, "and the switch is put back on the shorter pause");

  // Without an official path the switch reflects ring events and drives nothing, which is what the user is told rather than left to discover.
  const tokenless = makeHub({ options: ["Enable.Hub.Doorbell.Trigger"] });
  const tokenlessTrigger = switchService(tokenless, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  await tokenlessTrigger.getCharacteristic(Characteristic.On).handleSetRequest(true);

  assert.deepEqual(tokenless.rings, [], "a hub with no official path dispatches nothing");
  assert.deepEqual(tokenless.errors, [LOG_PREFIX + "Ringing the doorbell requires the official Access API, which needs an API token configured."]);

  t.mock.timers.tick(REVERT_DELAY_MS);

  assert.equal(tokenlessTrigger.getCharacteristic(Characteristic.On).value, false, "and the switch is put back where the mirror stands");
});

test("a doorbell ring the controller refuses says so and puts the switch back on the shorter pause", async (t) => {

  t.mock.timers.enable({ apis: ["setTimeout"] });

  const harness = makeHub({ devices: [READER_RECORD], official: true, options: ["Enable.Hub.Doorbell.Trigger"],
    ringRefusal: new Error("The controller refused the ring.") });
  const trigger = switchService(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  await trigger.getCharacteristic(Characteristic.On).handleSetRequest(true);

  assert.deepEqual(harness.rings, [{ cancel: false, readerId: READER_ID }], "the ring reached the reader, so the refusal is the controller's answer to it");
  assert.deepEqual(harness.errors, [LOG_PREFIX + "Unable to ring the doorbell: The controller refused the ring."]);

  t.mock.timers.tick(REVERT_DELAY_MS);

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false, "and a dispatch the controller refused keeps the shorter pause rather than the window");
});
