/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hub.test.ts: Tests for every behavior AccessHub owns, exercised over a hub stood up for real - genuine HAP service and characteristic classes - rather than
 * through isolated method calls.
 *
 * The hub is stood up this way because what these arms are about is a hub reading and reacting to the same live state the running accessory does - the client's
 * projection, its discovered door and reader identities, and the record's own configuration - rather than to values asserted about it from outside.
 *
 * Deliveries are driven through the handler the hub itself registered rather than by calling its methods directly, so the registration and the handler are proved
 * to agree on the event vocabulary rather than assumed to.
 */
/* eslint-disable camelcase */
import { ACCESSORY_SAVE_WINDOW_MS, FeatureOptions, HAPStatus, ServiceEventTypes, mqttGetTopic, mqttSetTopic, setAccessoryName,
  setServiceName } from "homebridge-plugin-utils";
import { ACCESS_DEVICE_UPDATE_EVENT, ACCESS_REMOTE_UNLOCK_EVENT, ACCESS_WEBHOOK_EVENT_PREFIX } from "../controller/events.ts";
import { ACCESS_WEBHOOK_EVENTS, ACCESS_WEBHOOK_EVENT_LIST, PLATFORM_NAME, PLUGIN_NAME } from "../settings.ts";
import { AccessAbortedError, AccessApiError, AccessCapabilityError, AccessDeclinedError } from "unifi-access";
import type { AccessDeviceEntryConfig, AccessDevice as AccessDeviceProjection, AccessDoorStateEntry, AccessHub as AccessHubProjection,
  AccessStateDevice } from "unifi-access";
import { Characteristic, RESTORED_LINE, Service, configRows, eventsFrom, hap, hubRecord, makeControllerDouble, makePlatformDouble, makeTestAccessory,
  makeTestApi, runtime, savesOn, writesOn } from "../testing.helpers.ts";
import { EventEmitter, getEventListeners, on } from "node:events";
import type { FeatureOptionChoice, MqttPublishInit, MqttTopicEntry } from "homebridge-plugin-utils";
import { TestClock, TestMqttClient, hapStatus, settle, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import { accessMethods, hubSensorChoices, logEventChoices, officialDeviceModel } from "../policy.ts";
import { featureOptionCategories, featureOptions } from "../options.ts";
import { AccessHub } from "./hub.ts";
import { AccessReservedNames } from "../types.ts";
import type { Mock } from "node:test";
import type { TestAccessAccessory } from "../testing.helpers.ts";
import type { TestMqttPublish } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { format } from "node:util";
import { mqttTopics } from "../mqtt.ts";
import test from "node:test";

// The hub's own identities, the doors it drives, and the reader hanging off it. The hub's identifier, its main door, and the reader carry the identities the live
// captures use; the hub's MAC address and its side door are synthetic.
const HUB_ID = "74acb9d55b9c";
const HUB_MAC = "aabbccddee01";
// The identity the plugin addresses this hub by, written as a literal so the assertion proves the spelling rather than agreeing with whatever the composition answers.
const HUB_SERIAL = "AABBCCDDEE01";
const MAIN_DOOR = "740785e0-ef1d-4a2b-a720-3c8804feea9c";
const SIDE_DOOR = "8f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
// The doors a rebind moves a gate's ports onto. The topology the harness stands up knows neither of them, so an announcement naming one names it by its identity,
// which is what tells a door read from the record apart from a name read from the topology.
const NEW_MAIN = "b21c4d5e-6f70-4a2b-8193-c4d5e6f70819";
const NEW_SIDE = "c32d5e6f-7081-4b3c-9204-d5e6f7081920";
// Another hub's door in the controller's topology, which no binding of a gate's record names, so a gate handing it a role would drive a door it does not own.
const OTHER_DOOR = "d43e6f70-8192-4c4d-a315-e6f708192a31";
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
function testHub(overrides: Record<string, unknown> = {}): AccessStateDevice & { mac: string } {

  return hubRecord({

    alias: "",
    capabilities: [ "is_hub", "door_bell" ],
    configs: [],
    connected_uah_id: "",
    is_adopted: true,
    is_connected: true,
    is_online: true,
    location_id: MAIN_DOOR,
    mac: HUB_MAC,
    name: "UA-HUB-5B9C",
    unique_id: HUB_ID,
    ...overrides
  });
}

/* A service a previous run left on the accessory, named the way the hub names its own so an acquire finds it under its subtype rather than creating a second.
 *
 * @param serviceType - The HAP service class to carry.
 * @param subtype     - The reserved subtype the hub will look it up under.
 *
 * @returns The service, bare: an arm writes onto it whatever cached values it wants the hub to find.
 */
function carried<T extends Service>(serviceType: new (displayName?: string, subtype?: string) => T, subtype: string): T {

  return new serviceType("Test Hub " + subtype, subtype);
}

/* The HomeKit accessory a hub is stood up on: Homebridge's own PlatformAccessory over HAP, seeded by the hub's identifier and carrying the services a previous run
 * left on it. Every lookup and service mutation the plugin performs on it is HAP's own, so what the shared service helpers do to it here is what they do in the
 * field: a type lookup answers the first service of the type whatever its subtype, an identity lookup matches the type and the subtype exactly, an add is refused
 * where HAP refuses it, and a removal takes out exactly the service it names.
 *
 * @param existing - The services a previous run left on the accessory, added in the order given.
 *
 * @returns The accessory.
 */
function makeAccessory(existing: Service[]): TestAccessAccessory {

  const accessory = makeTestAccessory("Test Hub", HUB_ID);

  for(const service of existing) {

    accessory.addService(service);
  }

  return accessory;
}

// A door command the hub dispatched to the library, as the arm driving it sees it: the verb, the options it carried, and the rule a lock-rule command asked for.
interface RecordedCommand {

  options?: { actor?: { id: string; name: string }; doorId?: string };
  rule?: unknown;
  verb: string;
}

// An access method switch write the hub handed the library, as the arm driving it sees it: the method by the library's name, the state asked for, and the signal.
interface RecordedAccessMethodWrite {

  enabled: boolean;
  method: string;
  signal: AbortSignal | undefined;
}

// What a stood-up hub looks like from a test's side: the hub itself, the deliveries and packets it can be handed, and what it commanded, published, and said.
interface HubHarness {

  accessMethodWrites: RecordedAccessMethodWrite[];
  // The accessory the hub is stood up on, which records every change HAP raises on its services, so an arm reads what the hub wrote and what HomeKit was sent.
  accessory: TestAccessAccessory;
  // The time source every timer this hub arms is registered on, so an arm advances the hub's own timeline rather than the process's global timers.
  clock: TestClock;
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
  // The hub's own record loop, as the construction handed it to the controller, which walks the arm's record script once per call.
  loop: () => Promise<void>;
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
  // The UUIDs each save Homebridge accepted named, in the order it accepted them, which only an arm that put the accessory on the bridge can see.
  readonly saves: string[][];
  // The accessory's own service list, HAP's array, so a creation or a retirement the hub makes is read here as it happens.
  services: Service[];
  setDoorState: (entry: AccessDoorStateEntry) => void;
}

// What an arm varies about the hub it stands up: which identities the client behind it holds, how its dispatched commands answer, what the library's door
// resolution and door-state read answer, the topology doors a UA Gate discovers its own from, the user's settings, and the record the hub is adopted on.
interface HubOptions {

  /* What an access method switch write answers, called with the ordinal of the write once it is recorded, so an arm can hold one open, decline it, or fail it the
   * way the library does. An arm naming none has every write complete.
   */
  accessMethodWrite?: (write: number) => Promise<void>;
  /* The accessory the hub is stood up on, for an arm that lays out the services a previous run left on it in an order HAP's own add would refuse. An arm naming
   * none gets a fresh one carrying its existing services.
   */
  accessory?: TestAccessAccessory;
  /* Register the accessory before the hub is stood up, as a controller's adoption does, for an arm about what reaches Homebridge's accessory cache: the persistence
   * saves only an accessory the bridge holds, so a hub on an accessory left off it saves nothing an arm could read.
   */
  bridged?: boolean;
  credentials?: boolean;
  defer?: string;
  // The device roster the client's snapshot carries, keyed by unique_id, which is what the doorbell reader lookup searches.
  devices?: AccessStateDevice[];
  // A function value simulates the library's door handle throwing during the removal window, mirroring the #doorId getter's own guard.
  doorId?: string | (() => never);
  doorState?: AccessDoorStateEntry;
  /* The client's door state map, keyed by location id, which is the map every hub reads the doors it drives from. An arm names it to put the controller's
   * reading at odds with the relay rows its record carries, which is the only way an adoption-time disagreement can be expressed.
   */
  doorStates?: Map<string, AccessDoorStateEntry>;
  doors?: { name: string; unique_id: string }[];
  /* The services the accessory already carries when the hub is stood up, standing in for what a previous run left on it: a restored service carries the values it
   * last held and none of its handlers, exactly as Homebridge's accessory cache hands one back.
   */
  existing?: Service[];
  // A hub stood up with no door control surface at all, which is the state the base class admits through its optional handle.
  hubless?: boolean;
  // Keep what construction said rather than clearing it, for the arms about adoption's own sentences.
  keepAdoptionLines?: boolean;
  official?: boolean;
  options?: string[];
  record?: AccessStateDevice & { mac: string };
  reject?: string[];
  // The 1-based position, among every command dispatched so far whatever its verb, from which a verb named in reject starts being refused.
  rejectFrom?: number;
  // The error a doorbell ring or cancel rejects with, standing in for a controller that refuses the dispatch. The ring is recorded before it is thrown.
  ringRefusal?: Error;
  // The records the hub's own observation yields, one per entry, when an arm drives its record loop. An arm naming none observes nothing.
  script?: AccessStateDevice[];
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

  const accessMethodWrites: RecordedAccessMethodWrite[] = [];
  const clock = new TestClock();
  const commands: RecordedCommand[] = [];
  const debugs: string[] = [];
  const errors: string[] = [];
  const fetches: string[] = [];
  const lines: string[] = [];
  const publishes: { init: MqttPublishInit | undefined; payload: string; topic: string }[] = [];
  const releases: (() => void)[] = [];
  const requests: string[] = [];
  const rings: { cancel: boolean; readerId: string }[] = [];
  /* The controller's event rail, doubled with the emitter's own semantics: a registration under a key joins the list already there rather than replacing it, off
   * removes the single registration it names, and a delivery reaches every handler under the key in registration order. The hub binds one handler and registers
   * that same reference under several keys, so a key registered twice holds one reference twice and fires twice - which is the leak an arm has to be able to
   * see. A rail keeping one handler per key, or one deduplicating by reference, answers a doubled registration as a single one and hides it.
   */
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const record = options.record ?? testHub();

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

  /* The Access application's own endpoint, which only a credentialed client reaches and a token-only client holds none of. Every command a hub sends goes through
   * the library's own rail, so a request composed here would be a hub reaching around it, and the arms that count the requests read them as none.
   */
  const transport = options.credentials ? { request: async (endpoint: string, init: { method: string }): Promise<void> => void requests.push(init.method + " " +
    endpoint) } : null;

  /* What kind of client the hub is behind, as the client describes itself at connect: an API token beside credentials, an API token alone, or credentials alone. It
   * follows the identities an arm gives the client, so an arm about a token-only client and one about a dual client differ in exactly the identities they name.
   */
  const mode = options.official ? (options.credentials ? "dual" : "token") : "credential";

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

  /* The hub's own observation yields once per scripted record and answers peek() with that record, so an arm naming no script observes nothing. The loop the
   * construction hands the controller is held rather than run, so an arm drives it when it is ready to read what a record changed. A switch write the hub hands the
   * library is recorded before it answers, so an arm reads what a switch sent whichever way the write then goes.
   */
  const script = options.script ?? [];
  let peekIndex = 0;
  let loop: () => Promise<void> = async (): Promise<void> => undefined;

  const projection = {

    config: record,
    observe: async function *(): AsyncGenerator {

      for(const _entry of script) {

        yield projection;
      }
    },
    peek: (): AccessStateDevice | undefined => script[peekIndex++],
    setAccessMethod: async (method: string, enabled: boolean, opts: { signal?: AbortSignal } = {}): Promise<void> => {

      accessMethodWrites.push({ enabled, method, signal: opts.signal });

      await options.accessMethodWrite?.(accessMethodWrites.length);
    }
  };

  // The Homebridge API double the platform saves through, held here so the saves an arm reads are the ones this hub's persistence made.
  const api = makeTestApi();
  const platform = makePlatformDouble({

    api,
    /* The clock every timer this hub arms is registered on, stated here rather than left to the double's own default, because a hub reading a clock no arm holds is
     * a hub whose relocks and travels an advance would never reach.
     */
    clock,
    featureOptions: new FeatureOptions(featureOptionCategories, featureOptions, options.options ?? []),
    /* The lines are captured formatted, because what a user reads is the composed sentence rather than the format string and its arguments. The plugin's debug
     * output arrives on the warn sink, which is how the shared logger surfaces it without Homebridge's own debug flag, so that is where an arm reads it.
     */
    log: { error: (message: string, ...parameters: unknown[]): void => void errors.push(format(message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => void lines.push(format(message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => void debugs.push(format(message, ...parameters)) }
  });

  /* The engine a reconfiguration swaps in, written through a view of the one member it replaces. The platform declares its engine read-only because the real one
   * reads its own once and keeps it, so this is the harness stating that restating a user's settings under a running hub is the test's own hand on the double.
   */
  const settings = platform as { featureOptions: FeatureOptions };

  const doors = new Map((options.doors ?? []).map(door => [ door.unique_id, door ]));
  const accessory = options.accessory ?? makeAccessory(options.existing ?? []);

  if(options.bridged) {

    platform.registerAccessory(accessory);
  }

  /* The official device surface, held only by a client an arm gave one to. The settings read is what seeds a reader whose record carries no configuration rows, and
   * the doorbell dispatch is what the trigger switch's manual direction sends, so each of them is recorded: an arm counts the reads to tell one seed from two, and
   * reads the dispatches to see which reader was addressed and in which direction. An arm naming no answer of its own gets an empty settings map, which is what a
   * hardware class offering no methods returns. The surface carries no settings write, because a switch write is the library's to route.
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
      }
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

  const controller = makeControllerDouble({

    client: { capabilities: { mode }, connection, doorStates, official,
      state: { snapshot: (): unknown => ({ devices: new Map((options.devices ?? []).map(device => [ device.unique_id, device ])), doors }) }, transport },
    events: {

      off: (event: string, handler: (payload: unknown) => void): void => {

        const registered = handlers.get(event) ?? [];
        const index = registered.lastIndexOf(handler);

        if(index >= 0) {

          registered.splice(index, 1);
        }

        if(!registered.length) {

          handlers.delete(event);
        }
      },
      on: (event: string, handler: (payload: unknown) => void): void => {

        const registered = handlers.get(event) ?? [];

        registered.push(handler);
        handlers.set(event, registered);
      }
    },
    mqtt,
    mqttPublish: (topic: string, payload: string, init?: MqttPublishInit): void => {

      publishes.push({ init, payload, topic });
      mqtt.publishGuarded(topic, payload, init);
    },
    platform,
    spawnLoop: (_title: string, body: () => Promise<void>): void => {

      loop = body;
    }
  });

  const hub = new AccessHub(controller, projection as unknown as AccessDeviceProjection, accessory, record,
    options.hubless ? undefined : hubProjection as unknown as AccessHubProjection);

  // Construction narrates itself, and every arm but the ones about adoption reads from a clean slate rather than from what adoption said.
  if(!options.keepAdoptionLines) {

    debugs.length = 0;
    errors.length = 0;
    lines.length = 0;
  }

  return {

    accessMethodWrites,
    accessory,
    clock,
    commands,
    debugs,
    deliver: (event: string, delivery: unknown): void => {

      const registered = handlers.get(ACCESS_WEBHOOK_EVENT_PREFIX + event) ?? [];

      assert.ok(registered.length, "the hub should have registered a handler for " + event);

      // The fire walks a copy, so a handler that unregisters itself or a sibling mid-delivery cannot make the rail skip the neighbor behind it.
      for(const handler of [...registered]) {

        handler(delivery);
      }
    },
    emit: (event: string, packet: unknown): void => {

      const registered = handlers.get(event) ?? [];

      assert.ok(registered.length, "the hub should have registered a handler for " + event);

      for(const handler of [...registered]) {

        handler(packet);
      }
    },
    errors,
    fetches,
    health,
    hub,
    lines,
    loop: (): Promise<void> => loop(),
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
     * construction. The engine is swapped whole rather than mutated, so every read after the swap answers from the new entries alone, and the hub meets the new
     * engine on its next read because it reaches the engine through the platform each time.
     */
    reconfigure: (entries: string[]): void => {

      settings.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, entries);
    },
    release: (): void => {

      for(const resolve of releases.splice(0)) {

        resolve();
      }
    },
    requests,
    rings,
    get saves(): string[][] {

      return savesOn(api);
    },
    services: accessory.services,
    setDoorState: (entry: AccessDoorStateEntry): void => void doorStates.set(entry.location_id, entry)
  };
}

/* The extension a controller publishes one of a gate's port-to-door bindings through, in the shape the wire sends it. The port's own name is what tells the side
 * door's binding from the main door's, and the target is the door that port serves.
 *
 * @param name   - The port name the controller writes beside the binding.
 * @param doorId - The door the port is bound to.
 *
 * @returns The extension.
 */
function portBinding(name: string, doorId: string): Record<string, unknown> {

  return { device_id: HUB_ID, extension_name: "port_setting", target_config: [], target_name: name, target_type: "door", target_value: doorId,
    unique_id: "ext-" + name };
}

// A UA Gate with both of its doors discovered and a credentialed client behind it, so an arm can count the requests a door command composes through the transport
// double and show there are none.
function makeGate(options: HubOptions = {}): HubHarness {

  return makeHub({ credentials: true, doors: [ { name: "Main Gate", unique_id: MAIN_DOOR }, { name: "Pedestrian Gate", unique_id: SIDE_DOOR } ],
    record: testHub({ device_type: "UGT" }), ...options });
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

/* Each list as an arm turning one member off writes it. A list entry replaces the whole selection, so taking one member out means naming every other one - which is
 * what the settings page composes and what the migration composes for an upgrader.
 *
 * @param option  - The list to compose an entry for.
 * @param choices - The members the list offers.
 * @param dropped - The member being turned off.
 *
 * @returns The configured entry.
 */
function listLess(option: string, choices: FeatureOptionChoice[], dropped: string): string {

  return "Enable." + option + "=" + choices.map(choice => choice.value).filter(value => value !== dropped).join(",");
}

// A reader with every access method selected for a switch, so what its record and the controller say about each method is what its switches show.
function makeReader(options: HubOptions = {}): HubHarness {

  return makeHub({ ...options, options: [ EVERY_ACCESS_METHOD, ...options.options ?? [] ] });
}

// Hand a hub the door reading the controller's own door-state loop would deliver.
function deliverDoorState(harness: HubHarness, entry: AccessDoorStateEntry): void {

  harness.setDoorState(entry);
  harness.hub.refreshDoorState();
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

/* What an access method switch answers when HomeKit asks it, read through the same get path HomeKit uses. The read proves the value HomeKit would see and never
 * that a handler is registered: HAP consults a handler only where one stands and answers from the characteristic's stored value otherwise, and the push path
 * writes that stored value on every pass, so an undressed switch answers exactly what a dressed one would. A registered handler is proven by a write through
 * triggerSet() asserted against the switch write the harness records, which only a write registration can carry.
 *
 * @param harness - The hub to read.
 * @param subtype - The access method switch to ask.
 *
 * @returns What the switch's read handler answers.
 */
async function switchReads(harness: HubHarness, subtype: string): Promise<unknown> {

  return triggerGet(switchService(harness, subtype).getCharacteristic(Characteristic.On));
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

// A reader's configuration rows carrying one PIN row in the record's own shape, under the tag the controller files every access-method row under.
function pinRow(value: string): unknown[] {

  return [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value }];
}

/* The decline the library throws when the settings write answered success and the read-back shows PIN still in the other state.
 *
 * @param enabled - The state the write asked for.
 *
 * @returns The error.
 */
function pinDecline(enabled: boolean): AccessDeclinedError {

  return new AccessDeclinedError("The UniFi Access controller declined to " + (enabled ? "enable" : "disable") + " the pin access method for device \"Test Hub\".",
    { method: "pin", reported: !enabled });
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

/* The availability statement a reachable hub makes once its adoption completes, as the harness records the call. Every reachable hub these arms stand up opens its
 * publish record with it, so an arm asserting what a later act published names it first rather than reading it as part of that act.
 *
 * @param harness - The hub whose statement to spell.
 *
 * @returns The recorded publish.
 */
function adoptionStatement(harness: HubHarness): HubHarness["publishes"][number] {

  return { init: { ifChanged: true, retain: true, signal: harness.hub.signal }, payload: "online", topic: HUB_SERIAL + "/availability" };
}

/* Drive the broker double through one session and answer every publish that session recorded, in order. The lever's false-to-true edge is a session restored:
 * the double records the plugin-level statement on the bare availability tail and then runs every connect registration the hub holds.
 *
 * @param mqtt - The broker double to drive.
 *
 * @returns The publishes the session recorded, oldest first.
 */
function restoreSession(mqtt: TestMqttClient): TestMqttPublish[] {

  const before = mqtt.published.length;

  mqtt.connected = false;
  mqtt.connected = true;

  return mqtt.published.slice(before);
}

/* The held state topics a session restated, read past the plugin-level and device availability statements that open it, as tail, payload, and retention, sorted
 * by tail because the order a hub restates in is not part of its contract. A topic restated twice appears twice, so a duplicate cannot hide in the reading.
 *
 * @param session - What the session recorded.
 *
 * @returns The restated topics.
 */
function restatedIn(session: readonly TestMqttPublish[]): [ string, string, boolean ][] {

  return session.slice(2).map((entry): [ string, string, boolean ] => [ entry.topic.slice((HUB_SERIAL + "/").length), entry.payload.toString(), entry.retain ])
    .sort(([left], [right]) => left.localeCompare(right));
}

/* What a hub's get topics answer, read through the gets themselves, in the same tail and payload form a restatement is compared in.
 *
 * @param harness  - The hub to ask.
 * @param restated - The restated topics, each spelled as its tail, an equals sign, and its payload.
 *
 * @returns Each of those topics' tail beside what its get answers now.
 */
async function getAnswers(harness: HubHarness, restated: readonly string[]): Promise<string[]> {

  return Promise.all(restated.map(async (pair): Promise<string> => {

    const tail = pair.slice(0, pair.indexOf("="));

    return tail + "=" + String(await harness.mqttGet(tail));
  }));
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

/* The same reading of a warning, which the log double keeps in the debug sink beside the debug lines rather than in the info one.
 *
 * @param harness  - The hub to read.
 * @param sentence - The sentence as a user reads it, without the logger's own prefix.
 *
 * @returns The number of times the hub warned it.
 */
function warnCount(harness: HubHarness, sentence: string): number {

  return harness.debugs.filter(line => line === (LOG_PREFIX + sentence)).length;
}

// Write a target door state the way HomeKit does, and wait on the handler behind it.
async function writeTarget(harness: HubHarness, target: number): Promise<void> {

  await triggerSet(openerService(harness).getCharacteristic(Characteristic.TargetDoorState), target);
}

// One write on a freshly stood-up door hub opener, and what that write dispatched to the library.
async function openerDispatch(options: HubOptions, target: number): Promise<RecordedCommand[]> {

  const opener = makeOpener(options);

  await writeTarget(opener, target);

  return opener.commands;
}

// Write a lock target the way HomeKit does, and wait on the handler behind it.
async function writeLock(service: Service, target: number): Promise<void> {

  await triggerSet(service.getCharacteristic(Characteristic.LockTargetState), target);
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
      // 105 is the controller's code for a call that timed out, which unifi-access glosses as such.
      object: { host_device_mac: "", reason_code: options.reasonCode ?? 105, request_id: "call1" }
    },
    event: ACCESS_WEBHOOK_EVENTS.doorbellCompleted,
    event_object_id: "doorbell1"
  };
}

test("construction records the accessory's context: the controller key, the device identity, and the hardware address", () => {

  const harness = makeHub();

  // The keys a startup sweep and an orphan's naming read back, and nothing else - the wipe that precedes the writes is what keeps a polluted context from
  // carrying a stale key past construction. The identity recorded is the device's own, read off the hub rather than restated.
  assert.deepEqual(harness.hub.accessory.context, { controller: "1.2.3.4", id: HUB_SERIAL, mac: HUB_MAC });
  assert.equal(harness.hub.accessory.context.id, harness.hub.id);
});

test("a hub whose construction throws ends the lifetime it had started, and the failure leaves the constructor as it arrived", async () => {

  const lifetimes: AbortSignal[] = [];
  const loops: Promise<void>[] = [];
  const record = testHub();

  // The record loop the construction starts parks until the lifetime it was handed ends, as the library's own observation does, so the loop ends only with it.
  const projection = {

    config: record,
    observe: async function *(opts: { signal: AbortSignal }): AsyncGenerator {

      lifetimes.push(opts.signal);

      try {

        // A record stream nothing moves, so the loop takes no record from it and waits on it until the lifetime ends.
        yield* on(new EventEmitter(), "record", { signal: opts.signal });
      } catch {

        // The lifetime's own abort is what ends this iteration, exactly as it ends the library's, so it is the expected exit rather than news.
      }
    },
    peek: (): undefined => undefined
  };

  // A door handle whose read fails, which a hub driving one door reaches at adoption, once its record loop is already running.
  const hubProjection = {

    get doorId(): string {

      throw new Error("The door could not be read");
    }
  };

  // The loop runs as the controller runs it, started at once and left to end on its own, so the arm holds what each one returns.
  const controller = makeControllerDouble({ spawnLoop: (_title: string, loop: () => Promise<void>): void => void loops.push(loop()) });

  assert.throws(() => new AccessHub(controller, projection as unknown as AccessDeviceProjection, makeAccessory([]), record,
    hubProjection as unknown as AccessHubProjection), { message: "The door could not be read" });

  assert.equal(lifetimes.length, 1, "the record loop had started before the failure");
  assert.equal(lifetimes[0]?.aborted, true, "and the lifetime it was handed has ended, since nothing holds the instance to end it later");

  // The loop resolves only once its observation has ended, so this await is the assertion that nothing of the failed hub is still running.
  await Promise.all(loops);
});

test("the hub registers for exactly the deliveries the registration asks a controller for", () => {

  const harness = makeHub();

  // The set the plugin listens for and the set a controller is asked to deliver are the same constant, so they cannot drift apart.
  for(const event of ACCESS_WEBHOOK_EVENT_LIST) {

    harness.deliver(event, event === ACCESS_WEBHOOK_EVENTS.doorUnlock ? unlockDelivery({ door: "somebody-elses-door" }) : doorbellDelivery({ hub: "another-hub" }));
  }

  // Neither delivery named this hub, so neither did anything - which is what makes the registration assertion above meaningful rather than incidental.
  assert.deepEqual(harness.publishes, [adoptionStatement(harness)]);
  assert.deepEqual(harness.lines, []);
});

test("an unlock on this hub's own door publishes one attribution and says who opened it", () => {

  const harness = makeHub();

  harness.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery());

  // The topic tail is the main door's, and the payload is the attribution rather than the raw delivery.
  assert.deepEqual(harness.publishes.map(published => published.topic), [ HUB_SERIAL + "/availability", HUB_SERIAL + "/unlock" ]);
  assert.deepEqual(JSON.parse(harness.publishes[1]?.payload ?? "null"), {

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

  assert.deepEqual(harness.publishes, [adoptionStatement(harness)]);
  assert.deepEqual(harness.lines, []);
});

test("a hub inside its removal window answers null rather than throwing out of a shared dispatch", () => {

  /* Every hub on a controller sees every delivery, so a hub whose device has left controller state must not take its siblings down with it. The library's own
   * handle raises a ReferenceError in exactly that window, which is the ordinary shape of a removal rather than a fault.
   */
  const departing = makeHub({ doorId: (): never => { throw new ReferenceError("The device is no longer present in controller state."); } });
  const sibling = makeHub();

  departing.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery());

  assert.deepEqual(departing.publishes, [adoptionStatement(departing)], "a hub that cannot resolve its own door owns nothing");
  assert.deepEqual(departing.lines, []);

  // The sibling still handles its own delivery, which is the half that fails a handler letting the ReferenceError escape.
  sibling.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery());

  assert.deepEqual(sibling.publishes.map(published => published.topic), [ HUB_SERIAL + "/availability", HUB_SERIAL + "/unlock" ]);
});

test("a UA Gate publishes its side door's unlocks under the side door's own topic", () => {

  const gate = makeHub({

    doors: [ { name: "Main Gate", unique_id: MAIN_DOOR }, { name: "Pedestrian Gate", unique_id: SIDE_DOOR } ],
    record: testHub({ device_type: "UGT" })
  });

  gate.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery({ door: SIDE_DOOR, doorName: "Pedestrian Gate" }));

  assert.deepEqual(gate.publishes.map(published => published.topic), [ HUB_SERIAL + "/availability", HUB_SERIAL + "/sidedoor/unlock" ]);

  // And the main gate still publishes on the main tail, so the two doors of one accessory stay told apart.
  gate.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery({ door: MAIN_DOOR, doorName: "Main Gate" }));

  assert.deepEqual(gate.publishes.map(published => published.topic), [ HUB_SERIAL + "/availability", HUB_SERIAL + "/sidedoor/unlock", HUB_SERIAL + "/unlock" ]);
});

/* A UA Gate whose relay rows report both doors secured, which is the seed every service below is configured from. An arm pairs it with a door state map that
 * disagrees, so what adoption pushed can be told apart from what the record alone would have rendered.
 */
function securedGate(options: HubOptions = {}): HubHarness {

  return makeGate({ ...options, record: testHub({ configs: [ { device_id: HUB_ID, key: "output_oper1_relay", tag: "relay", value: "off" },
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

  // Adoption is not a transition anyone observed, so it reaches the characteristics and publishes nothing but the device's availability.
  assert.deepEqual(gate.publishes, [adoptionStatement(gate)]);
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

  assert.deepEqual(gate.publishes, [adoptionStatement(gate)]);
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

  assert.deepEqual(gate.publishes, [adoptionStatement(gate)], "an adoption that told HomeKit nothing new must publish nothing but its availability");
  assert.deepEqual(gate.lines, []);
});

test("a door hub adopts its own door's reading from the door state map at construction, and says nothing about it", () => {

  // A door hub's record carries no lock reading of its own, so the default reads secured, while the controller's map says the door is standing unlocked, so a seed
  // that ignored the map renders the wrong lock.
  const hub = makeHub({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "unlock" }, options: ["Enable.Hub.Door.Service=Lock"] });

  assert.equal(lockService(hub).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);

  // Adoption is not a transition anyone observed, so it reaches the characteristics and publishes nothing but the device's availability.
  assert.deepEqual(hub.publishes, [adoptionStatement(hub)]);
});

test("a doorbell call that ended on this hub's reader is logged, and one on another hub's is not", () => {

  const harness = makeHub();

  harness.deliver(ACCESS_WEBHOOK_EVENTS.doorbellCompleted, doorbellDelivery());

  // The outcome is the library's own gloss for the code, and nothing is published - a call ending is a fact about the call rather than about the door.
  assert.deepEqual(harness.lines, [LOG_PREFIX + "Doorbell call ended: the call timed out."]);
  assert.deepEqual(harness.publishes, [adoptionStatement(harness)]);

  /* The delivery names its hub only through the ringing reader's own record - the live capture's host member reads empty - so a reader hanging off another hub is
   * how a sibling's call arrives here, and it must stay silent.
   */
  harness.deliver(ACCESS_WEBHOOK_EVENTS.doorbellCompleted, doorbellDelivery({ hub: "another-hub" }));

  assert.equal(harness.lines.length, 1, "a call that ended on another hub's reader must say nothing here");
});

test("a record's configuration rows create the switches its capabilities call for, and a capability with no row of its own reads off", async () => {

  const harness = makeReader({ record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code", "qr_code" ],
    configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] }) });

  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "a row the record carries is what the switch reads");

  /* Existence keys on the reader's capabilities and the user's settings rather than on what the model happens to hold for each method, so a capability the
   * configuration rows never mentioned still gets its switch, and that switch reads off because the model holds no entry for it.
   */
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), "a capability with no row of its own still gets a switch");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), false);
});

test("a reader whose record carries no configuration rows takes its switches from the official settings read", async () => {

  const harness = makeReader({

    official: true,
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code", "qr_code", "support_apple_pass" ], configs: undefined }),
    settings: async (): Promise<unknown> => ({ access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" }, touch_pass: { enabled: "yes" } } })
  });

  // The read is dispatched rather than awaited, so a device the record rail says nothing about carries nothing until the controller has answered.
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "nothing is created before the settings read answers");

  await settle();

  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);

  /* TouchPass is the one method the settings answer spells differently from its configuration row: the settings answer names it touch_pass where the row names it
   * apple_pass. A switch reading off here is what a reading reaching for the wrong spelling looks like, and it would leave the method permanently off on every
   * token-only controller.
   */
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_TOUCHPASS), true, "TouchPass is read through its official spelling");

  // The settings map is sparse, so a capability the answer never mentioned still gets its switch and reads off, exactly as a capability with no row does above.
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), "a capability the sparse answer omits still gets a switch");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), false);
});

test("a switch is dressed the first time the hub holds it, a repeat pass registers nothing on one already standing, and the record creates and retires", async (t) => {

  const harness = makeReader({

    existing: [carried(Service.Switch, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN)],
    official: true,
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code", "qr_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => ({ access_methods: { nfc: { enabled: "yes" }, pin_code: { enabled: "yes" } } })
  });

  await settle();

  /* The adoption polarity, read from both sides. The PIN switch is one the accessory arrived carrying, restored with none of its handlers, so an answer from it can
   * only come from a registration this hub made on a switch it never created. The QR switch is one this pass created, dressed from the same sparse model. NFC is the
   * third case: the model holds it on, but the record carries no capability for it, so no switch exists to dress.
   */
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "a switch the accessory carried is dressed at the first seeded pass");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), false, "and a switch the pass created is dressed from the same model");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "a method the model holds and the record has no capability for gets no switch");

  /* The spies watch the registration calls themselves rather than the handlers behind them. A second registration would install a fresh closure over the same
   * instance - identical in what it answers, and invisible from the characteristic's own value - so the call is the only place a repeat can be seen.
   */
  const spyHandlers = (subtype: string): { gets: Mock<Characteristic["onGet"]>; sets: Mock<Characteristic["onSet"]> } => {

    const on = switchService(harness, subtype).getCharacteristic(Characteristic.On);

    return { gets: t.mock.method(on, "onGet"), sets: t.mock.method(on, "onSet") };
  };

  const pin = spyHandlers(AccessReservedNames.SWITCH_ACCESSMETHOD_PIN);
  const qr = spyHandlers(AccessReservedNames.SWITCH_ACCESSMETHOD_QR);

  // A device update over an unchanged record, which is a pass across switches that are all standing and were all dressed above.
  restateRecord(harness, {});

  assert.equal(pin.gets.mock.callCount(), 0, "a repeat pass finds the switch dressed and registers nothing on it");
  assert.equal(pin.sets.mock.callCount(), 0, "neither its read handler nor its write one");
  assert.equal(qr.gets.mock.callCount(), 0, "and the same for a switch this hub created itself");
  assert.equal(qr.sets.mock.callCount(), 0);
  assert.equal(harness.fetches.length, 1, "the pass ran from the model rather than reaching for a second settings read");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "and the handler the first pass registered still answers");

  /* The record moving is what a pass on every delivery is for: NFC arrives as a capability and QR goes, and each reaches HomeKit on the delivery that carried it.
   * The model already holds NFC on, so the switch this pass creates is dressed with a handler that can say so.
   */
  restateRecord(harness, { capabilities: [ "is_hub", "is_reader", "nfc_card_easy_provision", "pin_code" ] });

  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), true,
    "a switch this pass created reads the model on the delivery that brought its capability, rather than at the next restart");

  /* The read alone cannot tell a dressed switch from an undressed one: the value push runs on every pass, and a characteristic carrying no handler answers whatever
   * was last pushed onto it. A write is what only a registration can carry, so the write is what says the switch was dressed on the pass that created it.
   */
  await triggerSet(switchService(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC).getCharacteristic(Characteristic.On), true);

  assert.deepEqual(harness.accessMethodWrites, [{ enabled: true, method: "nfc", signal: harness.hub.signal }],
    "and it carries a write from HomeKit, which only a registered handler can");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), "and a capability the record has dropped retires its switch on the same delivery");
  assert.equal(pin.gets.mock.callCount(), 0, "while the switch that stood through both deliveries was registered on neither");
  assert.equal(pin.sets.mock.callCount(), 0);
});

test("a settings read the controller refused keeps every switch the accessory carries, creates none, and says so", async () => {

  const harness = makeReader({

    existing: [carried(Service.Switch, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC)],
    official: true,
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
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

    existing: [carried(Service.Switch, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC)],
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined })
  });

  await settle();

  /* The other half of the contract: neither rail can answer for this device. The rows say nothing, and a credential-only client holds no official surface to ask,
   * so the device stays unseeded and keeps exactly what it arrived with until a restart finds a rail that can answer.
   */
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "a switch the accessory already carried is kept");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and no switch is created for a method nothing has spoken about");
  assert.deepEqual(harness.fetches, [], "a client with no official surface never reaches for the settings read");

  /* A device update is what retries the seed on a client that has a surface to retry with, so delivering one that still brings no rows is what puts this refusal
   * where an arm can read it. The harness clears whatever construction said, so the same refusal taken during construction alone would leave nothing behind to
   * assert against.
   */
  restateRecord(harness, {});
  await settle();

  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "the update leaves what the accessory keeps exactly as it was");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and creates nothing on the strength of a record that still says nothing");
  assert.deepEqual(harness.fetches, [], "and still reaches for no settings read");

  // The failure sentence belongs to a read that went out and was refused. Nothing was ever asked for here, so nothing is announced...which is what tells this arm
  // apart from the one above it, where the read was attempted and failed.
  assert.equal(harness.debugs.filter(line => line === LOG_PREFIX + "Unable to read the access method settings from the controller. Access method switches will " +
    "be configured once the controller answers.").length, 0, "a read never attempted is never announced as failed");
});

test("a seeded device retires the switch of a method that has left the reader, in both client identities", async () => {

  // The credential identity: the record's rows seed the model synchronously, so the sweep runs in the very pass that configures the device.
  const credential = makeReader({

    existing: [carried(Service.Switch, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC)],
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ],
      configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] })
  });

  assert.ok(!hasSwitch(credential, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "the switch of a method the reader no longer carries is retired");
  assert.ok(hasSwitch(credential, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and the method it still carries keeps its own");

  // The token identity: the same sweep, reached through the settings read instead of the rows, which is what makes retirement reach a rowless record at all.
  const token = makeReader({

    existing: [carried(Service.Switch, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC)],
    official: true,
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => ({ access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } })
  });

  assert.ok(hasSwitch(token, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "nothing is retired while the read is still in flight");

  await settle();

  assert.ok(!hasSwitch(token, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "and the stale switch goes once the read has seeded the model");
  assert.equal(await switchReads(token, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);
});

test("rows a device update moves push the switch its new value on a credentialed client", async () => {

  const harness = makeReader({ record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: pinRow("yes") }) });
  const service = switchService(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN);

  assert.equal(service.getCharacteristic(Characteristic.On).value, true, "the record's rows dressed the switch on");

  refreshRecord(harness, pinRow("no"));

  /* The pushed value is read before the handler is asked anything, because a HAP read writes the value it answers back onto the characteristic - so asking first
   * would leave this assertion passing on the strength of the read rather than on the push the delivery is here to make.
   */
  assert.equal(service.getCharacteristic(Characteristic.On).value, false, "the delivery pushes the switch the value its rows moved to");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "and the model it reads from moved with it");
});

test("rows a device update brings replace a model the settings read seeded on a token-only client, and push the switch what they say", async () => {

  const harness = makeReader({ official: true, record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => ({ access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } }) });

  await settle();

  const service = switchService(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN);

  assert.equal(harness.fetches.length, 1, "construction's seed is the one read");
  assert.equal(service.getCharacteristic(Characteristic.On).value, true, "and it dressed the switch on");

  // The controller's own update for this device carries every row it holds, so the record gains its rows here, and they say PIN is off.
  refreshRecord(harness, pinRow("no"));

  assert.equal(service.getCharacteristic(Characteristic.On).value, false, "the rows push the switch what they say, ahead of any read");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "and the model behind the switch answers the same");

  await settle();

  assert.equal(harness.fetches.length, 1, "a seeded model asks the controller for nothing more");
});

test("a device update retries a settings read that failed, and only while none is in flight", async () => {

  const harness = makeHub({

    official: true,
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

    // The first read is refused; the retry stays in flight for the rest of the arm, which is what the update arriving behind it meets.
    settings: async (fetch: number): Promise<unknown> => {

      if(fetch === 1) {

        throw new Error("the controller is not answering");
      }

      return new Promise<never>(() => undefined);
    }
  });

  await settle();

  assert.equal(harness.fetches.length, 1, "the first read is the one configuring the device dispatched");

  // A device update that still brings no rows leaves the model unseeded, and the controller speaking for the device is what makes another read worth asking for.
  restateRecord(harness, {});
  await settle();

  assert.equal(harness.fetches.length, 2, "a device update retries a seed that failed");

  restateRecord(harness, {});
  await settle();

  assert.equal(harness.fetches.length, 2, "and an update arriving while that read is in flight asks for nothing more");
});

test("a settings read the controller keeps refusing warns once for the whole streak, and notes every refusal's cause at debug", async () => {

  const warning = "Unable to read the access method settings from the controller. Access method switches will be configured once the controller answers.";
  const cause = LOG_PREFIX + "The access method settings read was refused: the controller is not answering.";

  const harness = makeReader({

    official: true,
    options: ["Enable.Log.Debug"],
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

    // The controller refuses every read but the arm's last, which answers PIN on, so the streak ends on a read that seeds the model.
    settings: async (fetch: number): Promise<unknown> => {

      if(fetch < 4) {

        throw new Error("the controller is not answering");
      }

      return { access_methods: { pin_code: { enabled: "yes", pin_code_shuffle: "no" } } };
    }
  });

  await settle();

  assert.equal(harness.fetches.length, 1, "construction's seed went out and was refused");
  assert.equal(warnCount(harness, warning), 1, "the refusal that opens the streak warns");

  // Each device update that still brings no rows retries the read, and each retry is refused inside the streak the first refusal already announced.
  restateRecord(harness, {});
  await settle();
  restateRecord(harness, {});
  await settle();

  assert.equal(harness.fetches.length, 3, "every device update retried the read");
  assert.equal(warnCount(harness, warning), 1, "and the retries inside the streak stay silent");
  assert.equal(harness.debugs.filter(line => line === cause).length, 3, "while every refusal still notes its cause at debug");

  // The next retry is answered, which ends the streak on a seeded model.
  restateRecord(harness, {});
  await settle();

  assert.equal(harness.fetches.length, 4, "the next device update retried the read once more");
  assert.equal(switchService(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On).value, true,
    "and its answer created the switch and pushed it on");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "from the model the answer seeded");
  assert.equal(warnCount(harness, warning), 1, "and the streak ended without another warning");
});

test("a settings read refused after rows seeded the model mid-read warns nothing, and the model keeps what the rows said", async () => {

  const answer = Promise.withResolvers<unknown>();
  const harness = makeReader({ official: true, options: ["Enable.Log.Debug"],
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }), settings: async (): Promise<unknown> => answer.promise });

  await settle();

  assert.equal(harness.fetches.length, 1, "construction's seed is out");

  // The record gains its rows while that read is still in flight, so the switches stand before the controller has answered anything.
  refreshRecord(harness, pinRow("yes"));

  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "the rows seed the model and create the switch on the delivery");

  /* The seed's read is refused after the rows have answered for the device. The warning promises switches that will be configured once the controller answers, and
   * the rows have configured them already, so the refusal has nothing to announce beyond the cause it notes at debug.
   */
  answer.reject(new Error("the controller is not answering"));
  await settle();

  assert.equal(warnCount(harness, "Unable to read the access method settings from the controller. Access method switches will be configured once the controller " +
    "answers."), 0, "a refusal the rows overtook warns nothing");
  assert.equal(harness.debugs.filter(line => line === LOG_PREFIX + "The access method settings read was refused: the controller is not answering.").length, 1,
    "and its cause is still noted at debug");
  assert.equal(switchService(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On).value, true,
    "the refusal pushes nothing over the rows");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "and the model keeps what the rows said");
  assert.equal(harness.fetches.length, 1, "with no read asked for behind it");
});

test("rows landing while the startup seed is out outrank the answer that seed comes back with", async () => {

  const answer = Promise.withResolvers<unknown>();
  const harness = makeReader({ official: true, record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => answer.promise });

  await settle();

  assert.equal(harness.fetches.length, 1, "construction's seed is out");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "and nothing is created while it is");

  // The record gains its rows while that read is still in flight, and the rows are the device's own authority on its methods.
  refreshRecord(harness, pinRow("yes"));

  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "the rows seed the model and create the switch on the delivery");

  answer.resolve({ access_methods: { pin_code: { enabled: "no", pin_code_shuffle: "no" } } });
  await settle();

  assert.equal(switchService(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On).value, true,
    "the seed's later answer pushes nothing over the rows");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "and the model still holds what the rows said");
  assert.equal(harness.fetches.length, 1, "with no read asked for behind it");
});

test("a dressed sensor's availability read consults the live composition, answering under a healthy controller and refusing once the connection moves", async () => {

  const harness = makeGate();
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_DPS);

  const availability = sensor.getCharacteristic(Characteristic.StatusActive);

  assert.equal(await triggerGet(availability), true, "a sensor dressed under a healthy controller reads available");

  // The accessory's record restarts here, so the read of its writes below holds only what followed the flip.
  harness.accessory.clearObservations();

  /* Nothing pushes from here: no observer walk and no record delivery runs in this arm. A refusal that follows the flip can therefore only have come from the
   * handler consulting the composition, which is exactly what a dress that wrote the characteristic and registered nothing would fail by answering the cached value.
   */
  harness.health.isHealthy = false;

  await assert.rejects(triggerGet(availability), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
    "a read taken after the connection moved is refused with the status HomeKit renders as Not Responding");
  assert.deepEqual(writesOn(harness.accessory, sensor), [], "with no push behind it at all");
});

test("every reader a hub wires answers while the device can be reached and refuses with the communication-failure status while it cannot, " +
  "whichever service carries it", async (t) => {

  /* Every reader this hub wires registers through the prototype's own onGet, so the registrations the spy records are the census of readers with nothing listed by
   * hand, and a reader wired past the rule is caught here without anyone naming it.
   */
  const registered: Mock<Characteristic["onGet"]> = t.mock.method(Characteristic.prototype, "onGet");

  // The registrations one construction added, taken as the slice between the census before it and the census after it.
  const wiredBy = (build: () => HubHarness): { harness: HubHarness; slice: typeof registered.mock.calls } => {

    const from = registered.mock.calls.length;
    const harness = build();

    return { harness, slice: registered.mock.calls.slice(from) };
  };

  /* What one hub's own registrations prove: each reader answers the value its characteristic holds while the device can be reached, each refuses once it
   * cannot - at the handler itself and through HAP's read path in front of it - and a recovery clears the refusal with nothing rewired.
   */
  const proves = async (harness: HubHarness, slice: typeof registered.mock.calls): Promise<void> => {

    const [first] = slice;

    assert.ok(first, "the hub wired at least one reader");

    /* Each characteristic's stored value is taken before any request goes out, because a reader answering that store would make a value read afterwards agree
     * with itself whatever the handler did.
     */
    const held = slice.map((call): { characteristic: Characteristic; value: unknown } => {

      const characteristic = call.this as Characteristic;

      return { characteristic, value: characteristic.value };
    });

    await Promise.all(held.map(async (reader): Promise<void> => {

      assert.strictEqual(await triggerGet(reader.characteristic), reader.value,
        "a reader answers while the device can be reached, and answers the value the characteristic holds");
    }));

    harness.health.isHealthy = false;

    await Promise.all(slice.map(async (call): Promise<void> => {

      const characteristic = call.this as Characteristic;
      const [handler] = call.arguments;

      // The rule refuses with HAP's own status error.
      assert.throws(() => handler({}), { constructor: hap.HapStatusError, hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });

      await assert.rejects(triggerGet(characteristic), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
        "which HAP's read path renders as the status HomeKit shows as Not Responding");
    }));

    harness.health.isHealthy = true;

    await assert.doesNotReject(triggerGet(first.this as Characteristic),
      "and the next read after recovery answers, with nothing rewired");
  };

  /* These hubs between them carry every service a hub offers: a doorbell reader with its lock, both automation triggers, and a PIN switch; an opener over wired
   * terminal inputs; a UA Gate driving two doors; and a UA Ultra whose sensors carry a tamper status.
   */
  const reader = wiredBy(() => makeReader({ options: [ "Enable.Hub.Doorbell.Trigger", "Enable.Hub.Lock.Trigger" ],
    record: testHub({ capabilities: [ "is_hub", "is_reader", "door_bell", "pin_code" ],
      configs: [ ...wiredRows("on"), { device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" } ] }) }));
  const opener = wiredBy(() => makeOpener({ record: wiredHub("on") }));
  const gate = wiredBy(() => makeGate({ options: ["Enable.Hub.SideDoor.Lock.Trigger"] }));
  const ultra = wiredBy(() => makeHub({ record: tamperUltra({ "tamper_event": "true" }) }));

  await proves(reader.harness, reader.slice);
  await proves(opener.harness, opener.slice);
  await proves(gate.harness, gate.slice);
  await proves(ultra.harness, ultra.slice);
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
  const offline = makeHub({ record: testHub({ is_online: false }) });

  await writeLock(lockService(offline), Characteristic.LockTargetState.UNSECURED);

  assert.deepEqual(offline.commands, [], "a device its own record calls offline is refused the same way");
  assert.ok(offline.errors.includes(refusal));
});

test("a hub with no door control surface refuses every door command with the one sentence that says so", async () => {

  const hub = makeHub({ hubless: true });

  await writeLock(lockService(hub), Characteristic.LockTargetState.UNSECURED);

  assert.deepEqual(hub.commands, [], "a hub with nothing to dispatch on is refused here rather than dispatched into");
  assert.deepEqual(hub.errors, [LOG_PREFIX + "Unable to unlock the door. This device does not expose door controls."]);

  /* The locking direction reaches the command through MQTT rather than through the tile: the lock service's write handler suppresses a lock write on a hub whose
   * reading is already secured, so the topic is the surface that drives that direction here.
   */
  await hub.mqttSet("lock", "true");
  await settle();

  assert.deepEqual(hub.commands, []);
  assert.deepEqual(hub.errors, [ LOG_PREFIX + "Unable to unlock the door. This device does not expose door controls.",
    LOG_PREFIX + "Unable to lock the door. This device does not expose door controls." ]);

  // The garage door opener's momentary pulse names the same door for the same reason.
  const opener = makeOpener({ hubless: true });

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);

  assert.deepEqual(opener.commands, []);
  assert.deepEqual(opener.errors, [LOG_PREFIX + "Unable to operate the door. This device does not expose door controls."]);

  // A UA Gate hears it on both directions, its locking one arriving through the close command.
  const gate = makeGate({ hubless: true });

  await gate.mqttSet("lock", "true");
  await settle();
  await gate.mqttSet("lock", "false");
  await settle();

  assert.deepEqual(gate.errors, [ LOG_PREFIX + "Unable to close the gate. This device does not expose door controls.",
    LOG_PREFIX + "Unable to unlock the gate. This device does not expose door controls." ]);
  assert.deepEqual(gate.commands, []);
});

test("a UA Gate whose door was never discovered refuses its commands for the record it has no identity from", async () => {

  /* A gate holding a control surface over an empty topology. Every refusal the preamble makes on its own account is behind it, so the only reason left is the one
   * the door resolution could not answer.
   */
  const gate = makeHub({ credentials: true, doors: [], record: testHub({ device_type: "UGT" }) });

  await gate.mqttSet("lock", "true");
  await settle();
  await gate.mqttSet("lock", "false");
  await settle();

  assert.deepEqual(gate.errors, [ LOG_PREFIX + "Unable to close the gate. The controller reports no door for it.",
    LOG_PREFIX + "Unable to unlock the gate. The controller reports no door for it." ]);
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
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

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
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

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

test("a reader whose record carries configuration rows reads no settings on a completed recovery of a client holding credentials", async () => {

  /* The official surface is present deliberately. Without one the refresh would exit on its absence instead, and this arm would pass without ever putting the row
   * predicate under test. The credentials beside it make this a client whose census restates the rows, which is what leaves them this reader's authority.
   */
  const harness = makeReader({

    credentials: true,
    official: true,
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ],
      configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] })
  });

  await settle();

  assert.deepEqual(harness.fetches, [], "the record's own rows seeded the model, so nothing was read for it");

  harness.hub.onConnectionRestored();
  await settle();

  assert.deepEqual(harness.fetches, [], "and a completed recovery leaves the record rail as this device's authority");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);
});

test("a completed recovery re-reads the settings of a reader on a token-only client even where its record carries rows", async () => {

  /* A token-only client's census carries no configuration rows, so nothing restates the rows a device update brought this reader, and a method changed while the
   * channel was down would stay stale behind them. The settings read is what catches the model up.
   */
  const harness = makeReader({ official: true, record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: pinRow("yes") }),
    settings: async (): Promise<unknown> => ({ access_methods: { pin_code: { enabled: "no", pin_code_shuffle: "no" } } }) });

  await settle();

  assert.deepEqual(harness.fetches, [], "the record's own rows seeded the model, so nothing was read for it");

  harness.hub.onConnectionRestored();
  await settle();

  assert.equal(harness.fetches.length, 1, "a completed recovery reads the settings all the same");
  assert.equal(switchService(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On).value, false,
    "the switch restates what that read answered");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "and the model behind it took the answer");
});

test("rows landing while a refresh is out outrank the answer that refresh comes back with", async () => {

  let landing: (() => void) | undefined;

  const harness = makeReader({

    official: true,
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

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

  // The record gains its rows while that read is still in flight, and rows that land mid-read outrank the answer already on its way.
  refreshRecord(harness, [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }]);

  landing?.();
  await settle();

  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "the rows the record brought are what the model holds");
});

test("rows a delivery restates while a refresh is out leave that refresh free to apply its answer", async () => {

  const answer = Promise.withResolvers<unknown>();
  const harness = makeReader({ official: true, record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: pinRow("yes") }),
    settings: async (): Promise<unknown> => answer.promise });

  await settle();

  const service = switchService(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN);

  assert.equal(service.getCharacteristic(Characteristic.On).value, true, "the record's rows seeded the switch on");

  harness.hub.onConnectionRestored();
  await settle();

  assert.equal(harness.fetches.length, 1, "the restore's refresh is out");

  /* The record moves on an unrelated member while that read is out, carrying the rows it already held. On this token-mode client the library hands the held
   * rows back by reference when a delivery restates them and yields a record only when it moves, so this is the one shape in which a delivery restating the rows
   * reaches the hub: the same rows beside news of something else. Rows that restate the last fold carry no access method news, so the answer already on its way
   * is still the freshest word.
   */
  restateRecord(harness, { name: "Front Door Reader" });

  answer.resolve({ access_methods: { pin_code: { enabled: "no", pin_code_shuffle: "no" } } });
  await settle();

  assert.equal(service.getCharacteristic(Characteristic.On).value, false, "the refresh's answer reaches HomeKit over the restated rows");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "and the model took it");
  assert.equal(harness.fetches.length, 1, "from the one read the restore asked for");
});

test("a refused refresh keeps the values already held, retires nothing, and never warns", async () => {

  const harness = makeReader({

    official: true,
    options: ["Enable.Log.Debug"],
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

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
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
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
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
    settings: async (): Promise<unknown> => new Promise<never>((_resolve, reject) => { answerSettings = (): void => reject(new Error("the device is gone")); })
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
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),
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

test("every MQTT registration carries its topic's own lifetime composed with the device's, and leaves with the device", () => {

  const gate = makeGate();

  /* A UA Gate with a doorbell registers the whole topic surface: the doorbell, the door position, the lock in both directions, and the side door's lock in both
   * directions and its position. Every registration carries a lifetime of its own composed with the device's, because each follows the control its topic
   * describes, which the record can withdraw while the device stays.
   */
  assert.deepEqual(gate.mqtt.subscriptions.map(entry => entry.topic).sort(), [ mqttGetTopic(HUB_SERIAL + "/doorbell"), mqttGetTopic(HUB_SERIAL + "/dps"),
    mqttGetTopic(HUB_SERIAL + "/lock"), mqttSetTopic(HUB_SERIAL + "/lock"), mqttGetTopic(HUB_SERIAL + "/sidedoor/dps"),
    mqttGetTopic(HUB_SERIAL + "/sidedoor/lock"), mqttSetTopic(HUB_SERIAL + "/sidedoor/lock") ].sort());

  for(const entry of gate.mqtt.subscriptions) {

    assert.notEqual(entry.init.signal, gate.hub.signal, "the " + entry.topic + " registration must carry its topic's own lifetime rather than the device's alone");
  }

  // Removing the device is what aborts its lifetime, and the broker releases every registration that signal governed, each topic's own lifetime composed with it.
  gate.hub.cleanup();

  assert.deepEqual(gate.mqtt.subscriptions, [], "a removed device must leave no registration behind");
});

test("every publish carries the device's own lifetime signal, and one issued after removal is refused rather than sent", async () => {

  const harness = makeHub();

  harness.publish(mqttTopics.lock, "true");

  await settle();

  // Before the removal the publish is admitted, and it carries this device's own signal rather than the controller's.
  assert.deepEqual(harness.mqtt.published, [ { payload: "online", retain: true, topic: HUB_SERIAL + "/availability" },
    { payload: "true", retain: false, topic: HUB_SERIAL + "/lock" } ]);
  assert.equal(harness.publishes[1]?.init?.signal, harness.hub.signal, "a publish must carry the device's own lifetime signal");

  harness.hub.cleanup();
  harness.publish(mqttTopics.lock, "false");

  await settle();

  // After it, the client refuses the publish on the signal it carries and says so at debug: the removal's own offline statement is the last thing to reach the
  // broker, and nothing is an error.
  assert.deepEqual(harness.mqtt.published, [ { payload: "online", retain: true, topic: HUB_SERIAL + "/availability" },
    { payload: "true", retain: false, topic: HUB_SERIAL + "/lock" }, { payload: "offline", retain: true, topic: HUB_SERIAL + "/availability" } ],
  "a publish after removal must never reach the broker");
  assert.equal(harness.publishes[3]?.init?.signal?.aborted, true);
  assert.deepEqual(harness.debugs, ["MQTT publish aborted: " + HUB_SERIAL + "/lock."]);
  assert.deepEqual(harness.errors, []);
});

test("a hub states its availability once its adoption completes, retained, in whichever word its reachability reads", () => {

  /* Neither trigger that restates reachability reaches a device at adoption - the record loop waits for a change and the controller's observer for a transition -
   * so the statement comes from adoption itself, which is what spares a hub adopted mid-session from saying nothing until its record next moves.
   */
  const reachable = makeHub();
  const unreachable = makeHub({ record: testHub({ is_online: false }) });

  assert.deepEqual(reachable.mqtt.published, [{ payload: "online", retain: true, topic: HUB_SERIAL + "/availability" }]);
  assert.deepEqual(unreachable.mqtt.published, [{ payload: "offline", retain: true, topic: HUB_SERIAL + "/availability" }]);
});

test("a broker session hears the hub's availability right behind the plugin-level statement, retained, ahead of every held state topic", () => {

  const harness = makeHub();

  /* Adoption already delivered online on this topic, and the change gate would answer a second online with nothing sent. The session clears that memory ahead of
   * the restatement, which is what lets the statement go out again for a subscriber that missed it while the broker was away.
   */
  const session = restoreSession(harness.mqtt);

  assert.deepEqual(session.slice(0, 2), [ { payload: "online", retain: true, topic: "availability" },
    { payload: "online", retain: true, topic: HUB_SERIAL + "/availability" } ]);
  assert.ok(session.slice(2).length > 0, "and the held state topics follow it");

  // A hub its controller cannot reach says so on the session too, in the other word.
  harness.health.isHealthy = false;

  assert.deepEqual(restoreSession(harness.mqtt)[1], { payload: "offline", retain: true, topic: HUB_SERIAL + "/availability" });
});

/* Each family the fixtures cover restates exactly the held state topics its transitions can publish, each with the value it holds. The readings are driven apart
 * wherever a family carries a pair - a door open while its lock is secured, one terminal input open while its neighbor is closed - so a payload answered from the
 * wrong source cannot pass unseen.
 */
test("a door hub restates its lock, and its position wherever a sensor shows it, reading unknown once the evidence behind a kept sensor goes", () => {

  // A hub with no position evidence carries no position sensor, so its position topic has no control to describe and the session restates its lock alone.
  assert.deepEqual(restatedIn(restoreSession(makeHub().mqtt)), [[ "lock", "true", false ]]);

  const sensed = makeHub({ doorState: { dps: "open", location_id: MAIN_DOOR, lock: "lock" } });

  assert.deepEqual(restatedIn(restoreSession(sensed.mqtt)), [ [ "dps", "true", false ], [ "lock", "true", false ] ]);

  // The controller then reports the sensor unwired. The sensor stands through the gap, as a sensor with no fresh evidence against it does, so its topic is
  // restated, saying the position is unknown.
  deliverDoorState(sensed, { dps: "none", location_id: MAIN_DOOR, lock: "lock" });

  assert.ok(hasContactSensor(sensed, AccessReservedNames.CONTACT_DPS), "the sensor outlives the gap in its evidence");
  assert.deepEqual(restatedIn(restoreSession(sensed.mqtt)), [ [ "dps", "unknown", false ], [ "lock", "true", false ] ]);
});

test("a UA Hub restates each terminal input whose sensor stands with its terminal wired, beside its door", () => {

  const harness = makeHub({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "unlock" },
    record: testHub({ configs: [ ...EVERY_PAIR_LIVE, ...inputRows({ "input_state_rel": "off", "input_state_ren": "on", "input_state_rex": "off" }) ] }) });

  assert.deepEqual(restatedIn(restoreSession(harness.mqtt)), [ [ "dps", "false", false ], [ "lock", "false", false ], [ "rel", "true", false ],
    [ "ren", "false", false ], [ "rex", "true", false ] ]);
});

test("a UA Gate restates both of its doors, and a gate whose side door is turned off restates its main door alone", () => {

  const gate = makeGate({ doorStates: new Map([ [ MAIN_DOOR, { dps: "open", location_id: MAIN_DOOR, lock: "unlock" } ],
    [ SIDE_DOOR, { dps: "close", location_id: SIDE_DOOR, lock: "lock" } ] ]), record: testHub({ configs: [ ...wiringRows({ "wiring_state_door-dps-neg": "on",
    "wiring_state_door-dps-pos": "on" }), ...inputRows({ "input_door_dps": "off" }) ], device_type: "UGT" }) });

  assert.deepEqual(restatedIn(restoreSession(gate.mqtt)), [ [ "dps", "true", false ], [ "lock", "false", false ], [ "sidedoor/dps", "false", false ],
    [ "sidedoor/lock", "true", false ] ]);

  const mainOnly = makeGate({ options: ["Disable.Hub.SideDoor"] });

  assert.deepEqual(restatedIn(restoreSession(mainOnly.mqtt)).map(([tail]) => tail), [ "dps", "lock" ]);
});

test("a UA Hub Door Mini, a UA Ultra with tamper detection, and an Enterprise hub port each restate the topics their hardware carries", () => {

  // None of these carries position evidence, so none carries a position sensor and none restates a position.
  assert.deepEqual(restatedIn(restoreSession(makeHub({ record: doorMiniHub("off") }).mqtt)), [ [ "lock", "true", false ], [ "rex", "true", false ] ]);

  // The Ultra's tamper status is restated from the verdict it adopted, which is the raised reading its record arrived with, carried by its one sensor.
  assert.deepEqual(restatedIn(restoreSession(makeHub({ record: tamperUltra({ "tamper_event": "true" }) }).mqtt)), [ [ "lock", "true", false ],
    [ "rex", "false", false ], [ "tamper", "true", false ] ]);

  assert.deepEqual(restatedIn(restoreSession(makeHub({ record: familyRecord("UAH-Ent") }).mqtt)), [[ "lock", "true", false ]]);
});

test("a reader restates its availability and no state topic, since none of a hub's topics are its to publish", () => {

  const reader = makeHub({ record: READER_RECORD });
  const session = restoreSession(reader.mqtt);

  assert.deepEqual(session[1], { payload: "online", retain: true, topic: HUB_SERIAL + "/availability" }, "a reader states its availability like any device");
  assert.deepEqual(restatedIn(session), []);
});

test("the restatement follows a terminal input's sensor from one session to the next, and says unknown while its wiring is quiet", () => {

  const harness = makeHub();

  assert.deepEqual(restatedIn(restoreSession(harness.mqtt)).map(([tail]) => tail), ["lock"]);

  // The remote release's wiring reports live mid-run, which creates its sensor, and the next session restates the reading that sensor holds.
  restateRecord(harness, { configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "off" }) ] });

  assert.deepEqual(restatedIn(restoreSession(harness.mqtt)), [ [ "lock", "true", false ], [ "rel", "true", false ] ]);

  /* The wiring then goes quiet. The sensor stands through the gap, as a sensor with no fresh evidence against it does, so the control its topic describes still
   * exists and the session restates it, saying unknown rather than the closed default the sensor holds for want of a reading.
   */
  restateRecord(harness, { configs: [] });

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the sensor outlives the gap in its evidence");
  assert.deepEqual(restatedIn(restoreSession(harness.mqtt)), [ [ "lock", "true", false ], [ "rel", "unknown", false ] ]);
});

test("the momentary topics are never restated, even mid-ring and after an attributed unlock", async () => {

  const gate = makeGate();

  gate.emit("access.remote_view", ringPacket([]));
  gate.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery({ door: MAIN_DOOR, doorName: "Main Gate" }));
  gate.deliver(ACCESS_WEBHOOK_EVENTS.doorUnlock, unlockDelivery({ door: SIDE_DOOR, doorName: "Pedestrian Gate" }));

  // The ring is still standing when the session begins, which is what makes this the sharpest moment to replay it by mistake.
  assert.equal(await gate.mqttGet("doorbell"), "true");

  const tails = restatedIn(restoreSession(gate.mqtt)).map(([tail]) => tail);

  for(const momentary of [ "doorbell", "sidedoor/unlock", "telemetry", "unlock" ]) {

    assert.ok(!tails.includes(momentary), "a replayed " + momentary + " is the event happening a second time, so it is never restated");
  }
});

test("a removed hub restates nothing on the next session", () => {

  const harness = makeHub();

  harness.hub.cleanup();

  const attempted = harness.publishes.length;

  // The registration was bound to the device's lifetime, so the session records the plugin-level statement alone.
  assert.deepEqual(restoreSession(harness.mqtt), [{ payload: "online", retain: true, topic: "availability" }]);

  /* And the hub is not asked at all. A registration that outlived the device would still attempt every publish, and the ended lifetime refusing each one would
   * leave the broker's record looking exactly the same, so the attempts are read where the controller receives them.
   */
  assert.equal(harness.publishes.length, attempted, "a removed hub attempts no restatement");
});

test("every get topic answers exactly what the session restates on it", async () => {

  const gate = makeGate({ doorStates: new Map([ [ MAIN_DOOR, { dps: "open", location_id: MAIN_DOOR, lock: "unlock" } ],
    [ SIDE_DOOR, { dps: "close", location_id: SIDE_DOOR, lock: "lock" } ] ]) });
  const hub = makeHub();
  const gateRestated = restatedIn(restoreSession(gate.mqtt)).map(([ tail, payload ]) => tail + "=" + payload);
  const hubRestated = restatedIn(restoreSession(hub.mqtt)).map(([ tail, payload ]) => tail + "=" + payload);

  // The gate restates every held state topic it carries, its side door position unknown with nothing wired behind it, and the door hub its lock, carrying no
  // position sensor. The momentary doorbell is never restated, which the arm about the momentary topics covers.
  assert.deepEqual(gateRestated, [ "dps=true", "lock=false", "sidedoor/dps=unknown", "sidedoor/lock=true" ]);
  assert.deepEqual(hubRestated, ["lock=true"]);

  // Each get answers what the session restated on its topic. The gets are read after the session, so both answers describe the same held state.
  assert.deepEqual(await getAnswers(gate, gateRestated), gateRestated, "the gate's gets and its restatement read one derivation");
  assert.deepEqual(await getAnswers(hub, hubRestated), hubRestated, "and so do the door hub's");
});

/* How many get and set registrations the broker holds on each of a hub's topics, keyed by the topic as a subscriber addresses it. The client answers a request
 * through every handler on its topic while the double's drivers run only the first match, so a count is what tells one registration from a doubled one.
 *
 * @param harness - The hub to read.
 *
 * @returns Each registered topic's tail, its get or set suffix included, beside how many registrations it holds.
 */
function registrationCounts(harness: HubHarness): Record<string, number> {

  const counts: Record<string, number> = {};

  for(const { topic } of harness.mqtt.subscriptions) {

    const tail = topic.slice((HUB_SERIAL + "/").length);

    counts[tail] = (counts[tail] ?? 0) + 1;
  }

  return counts;
}

test("each answered topic holds one registration per direction while its control exists and none once it goes, however many passes run over it", () => {

  const harness = makeHub();
  const doorHub = { "doorbell/get": 1, "lock/get": 1, "lock/set": 1 };

  assert.deepEqual(registrationCounts(harness), doorHub, "adoption registers the doorbell and the lock, and nothing for a position no sensor shows");

  restateRecord(harness, {});

  assert.deepEqual(registrationCounts(harness), doorHub, "a pass over an unchanged record registers nothing a second time");

  // Position evidence arriving on the door-state rail creates the position sensor there, and its topic follows it on that same rail rather than at the next update.
  deliverDoorState(harness, { dps: "open", location_id: MAIN_DOOR, lock: "lock" });

  assert.deepEqual(registrationCounts(harness), { ...doorHub, "dps/get": 1 }, "the position topic answers from the delivery that created its sensor");

  deliverDoorState(harness, { dps: "close", location_id: MAIN_DOOR, lock: "lock" });
  restateRecord(harness, {});

  assert.deepEqual(registrationCounts(harness), { ...doorHub, "dps/get": 1 }, "and neither a later delivery nor a later pass registers it again");

  // The record stops reporting a hub and a doorbell, which takes the door and the doorbell off the accessory and their topics with them.
  restateRecord(harness, { capabilities: [] });

  assert.deepEqual(registrationCounts(harness), { "dps/get": 1 }, "the lock and the doorbell answer nothing once their controls are gone");

  restateRecord(harness, { capabilities: [ "is_hub", "door_bell" ] });
  restateRecord(harness, {});

  assert.deepEqual(registrationCounts(harness), { ...doorHub, "dps/get": 1 }, "and the controls returning register each topic once more, and once only");
});

test("a hub carrying no doorbell publishes no ring and answers no doorbell get while its trigger switch mirrors the ring, and turning the doorbell on " +
  "brings the topic with it", async () => {

  const harness = makeHub({ options: [ "Disable.Hub.Doorbell", "Enable.Hub.Doorbell.Trigger" ] });
  const trigger = switchService(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  harness.emit("access.remote_view", ringPacket([]));

  assert.ok(!hasDoorbell(harness), "the hub carries no doorbell");
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "while its trigger switch mirrors the ring");
  assert.deepEqual(topicPayloads(harness, "doorbell"), [], "the trigger switch is no doorbell, so the ring is not published");
  await assert.rejects(harness.mqttGet("doorbell"), /no get registration's topic ends with/, "and nothing answers a doorbell get");

  harness.emit("access.remote_view.change", { data: { remote_call_request_id: "ring-1" }, event: "access.remote_view.change" });

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false, "the cancel still settles the trigger switch");
  assert.deepEqual(topicPayloads(harness, "doorbell"), [], "and is not published either");

  // The user turns the doorbell on under the running hub, which creates the doorbell on the next update, and the topic arrives with it.
  harness.reconfigure(["Enable.Hub.Doorbell.Trigger"]);
  restateRecord(harness, {});
  harness.emit("access.remote_view", ringPacket([]));

  assert.ok(hasDoorbell(harness), "the doorbell is created on the next update");
  assert.deepEqual(topicPayloads(harness, "doorbell"), ["true"], "and a ring is published from then on");
  assert.equal(await harness.mqttGet("doorbell"), "true", "and its get answers the ring the hub is holding");
});

test("a door position nothing shows in HomeKit publishes, restates, and answers nothing, while an opener rendering from that position carries the topic", async () => {

  const deselected = [listLess("Hub.Sensors", hubSensorChoices(), "DPS")];
  const lock = makeHub({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" }, options: deselected });

  deliverDoorState(lock, { dps: "open", location_id: MAIN_DOOR, lock: "lock" });

  assert.ok(!hasContactSensor(lock, AccessReservedNames.CONTACT_DPS), "the user turned the position sensor off, and a lock shows no position of its own");
  assert.deepEqual(topicPayloads(lock, "dps"), [], "so the position moving publishes nothing");
  assert.deepEqual(restatedIn(restoreSession(lock.mqtt)).map(([tail]) => tail), ["lock"], "and no session restates it");
  await assert.rejects(lock.mqttGet("dps"), /no get registration's topic ends with/, "and nothing answers a position get");

  // A garage door opener renders from the same position, so the topic describes what HomeKit shows on the opener even with the sensor turned off.
  const opener = makeOpener({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" }, options: deselected });

  deliverDoorState(opener, { dps: "open", location_id: MAIN_DOOR, lock: "lock" });

  assert.ok(!hasContactSensor(opener, AccessReservedNames.CONTACT_DPS), "the opener carries no position sensor either");
  assert.deepEqual(topicPayloads(opener, "dps"), ["true"], "while the position moving is published");
  assert.deepEqual(restatedIn(restoreSession(opener.mqtt)), [ [ "dps", "true", false ], [ "lock", "true", false ] ], "and restated");
  assert.equal(await opener.mqttGet("dps"), "true", "and answered");
});

test("a UA Gate whose side door position sensor is turned off publishes, restates, and answers nothing on that topic", async () => {

  const gate = makeGate({ options: [listLess("Hub.Sensors", hubSensorChoices(), "SideDoorDPS")] });

  deliverDoorState(gate, { dps: "open", location_id: SIDE_DOOR, lock: "lock" });

  assert.ok(!hasContactSensor(gate, AccessReservedNames.CONTACT_DPS_SIDE), "the gate carries no side door position sensor");
  assert.deepEqual(topicPayloads(gate, "sidedoor/dps"), [], "so the side door opening publishes nothing");
  assert.ok(!restatedIn(restoreSession(gate.mqtt)).map(([tail]) => tail).includes("sidedoor/dps"), "and no session restates it");
  await assert.rejects(gate.mqttGet("sidedoor/dps"), /no get registration's topic ends with/, "and nothing answers its get");
});

test("a UA Gate whose side door is turned off removes at adoption the side door position sensor its accessory was restored with, and nothing answers that " +
  "topic", async () => {

  const gate = makeGate({ existing: [carried(Service.ContactSensor, AccessReservedNames.CONTACT_DPS_SIDE)], keepAdoptionLines: true,
    options: ["Disable.Hub.SideDoor"] });

  assert.ok(!hasContactSensor(gate, AccessReservedNames.CONTACT_DPS_SIDE), "adoption removes the sensor a run with the side door on left on the accessory");
  assert.equal(lineCount(gate, "Disabling the side door position sensor."), 1, "and says so once");
  assert.ok(!restatedIn(restoreSession(gate.mqtt)).map(([tail]) => tail).includes("sidedoor/dps"), "so no session restates its topic");
  await assert.rejects(gate.mqttGet("sidedoor/dps"), /no get registration's topic ends with/, "and nothing answers its get");
});

test("a terminal input whose sensor is turned off publishes and restates nothing, whatever its wiring reports", () => {

  const harness = makeHub({ options: [listLess("Hub.Sensors", hubSensorChoices(), "REL")],
    record: testHub({ configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ] }) });

  restateRecord(harness, { configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "off" }) ] });

  assert.ok(!hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the hub carries no remote release");
  assert.deepEqual(topicPayloads(harness, "rel"), [], "so its input opening publishes nothing");
  assert.deepEqual(restatedIn(restoreSession(harness.mqtt)).map(([tail]) => tail), ["lock"], "and no session restates it");
});

test("a remote unlock naming a reader publishes nothing on a lock topic, since a reader carries no door", () => {

  const reader = makeHub({ record: READER_RECORD });

  reader.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: READER_ID });

  assert.deepEqual(lockPayloads(reader), [], "the lock topic has no door to describe on a reader");
});

test("tamper-capable hardware carrying no contact sensor publishes and restates no tamper status, while its log still follows the reading", () => {

  const harness = makeHub({ options: [listLess("Hub.Sensors", hubSensorChoices(), "REX")], record: tamperUltra({ "tamper_event": "false" }) });

  assert.ok(!harness.services.some(service => service.UUID === Service.ContactSensor.UUID), "the Ultra's one input is turned off, so it carries no sensor");

  refreshRecord(harness, tamperRows({ "tamper_event": "true" }));

  assert.equal(lineCount(harness, "Tampering detected."), 1, "the raise is still announced");
  assert.deepEqual(topicPayloads(harness, "tamper"), [], "while no characteristic carries it, so the topic says nothing");
  assert.deepEqual(restatedIn(restoreSession(harness.mqtt)).map(([tail]) => tail), ["lock"], "and no session restates it");
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
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: undefined }),

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

test("a confirmed access method write answers from the model before the controller echoes it, and a declined one changes nothing", async () => {

  const reader = { capabilities: [ "is_hub", "is_reader", "pin_code" ], configs: pinRow("no") };

  const confirmed = makeReader({ record: testHub(reader) });

  await triggerSet(switchService(confirmed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On), true);

  assert.deepEqual(confirmed.accessMethodWrites, [{ enabled: true, method: "pin", signal: confirmed.hub.signal }],
    "the write names the method by the library's name for it and carries the device's own lifetime");

  // The record still states the value the write replaced, and the model is what answers: a read landing in the gap between a confirmed write and the controller's
  // own echo says what the controller confirmed rather than what the rows have yet to restate.
  assert.equal(await switchReads(confirmed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true);

  // The negative control: the controller answered success while leaving the setting where it was. Nothing was confirmed, so nothing is folded.
  const declined = makeReader({ accessMethodWrite: async (): Promise<void> => { throw pinDecline(true); }, record: testHub(reader) });

  await triggerSet(switchService(declined, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On), true);

  assert.equal(await switchReads(declined, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "a write the controller declined leaves the model where it was");
  assert.ok(declined.errors.some(line => line === LOG_PREFIX + "The controller declined the PIN access method change."), "and the decline is announced");
});

test("a declined access method write and a failed one each say so in their own line and put the switch back once HomeKit's write has settled", async () => {

  const capabilities = [ "is_hub", "is_reader", "pin_code" ];

  // The controller declines turning PIN on, so the line names the decline and the switch goes back off after the pause.
  const declined = makeReader({ accessMethodWrite: async (): Promise<void> => { throw pinDecline(true); }, record: testHub({ capabilities, configs: pinRow("no") }) });
  const declinedOn = switchService(declined, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On);

  await triggerSet(declinedOn, true);

  assert.deepEqual(declined.errors, [LOG_PREFIX + "The controller declined the PIN access method change."], "a decline is said in its own line, and only that");
  assert.equal(declinedOn.value, true, "the switch holds HomeKit's write through the pause");

  declined.clock.advance(REVERT_DELAY_MS);

  assert.equal(declinedOn.value, false, "and goes back to where the controller left the method once it has passed");

  // No path carries turning PIN off, so the line says the change could not be made, the cause goes to debug, and the switch goes back on.
  const failed = makeReader({ accessMethodWrite: async (): Promise<void> => { throw new Error("the controller is not answering"); }, options: ["Enable.Log.Debug"],
    record: testHub({ capabilities, configs: pinRow("yes") }) });
  const failedOn = switchService(failed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On);

  await triggerSet(failedOn, false);

  assert.deepEqual(failed.errors, [LOG_PREFIX + "Unable to deactivate the PIN access method."], "a failure is said in its own line, in the direction asked for");
  assert.equal(failed.debugs.filter(line => line === LOG_PREFIX + "The access method write was refused: the controller is not answering.").length, 1,
    "and its cause is noted once, at debug");

  failed.clock.advance(REVERT_DELAY_MS);

  assert.equal(failedOn.value, true, "the switch goes back once the pause has passed");
  assert.equal(await switchReads(failed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "and the model behind it never moved");
});

test("a write the device's teardown or the library aborts passes in silence and puts nothing back", async () => {

  const capabilities = [ "is_hub", "is_reader", "pin_code" ];

  /* The write is held open while the device tears down, and the controller's decline arrives only after. The abort is weighed ahead of the decline, so a device on its
   * way out says nothing about a change it will never show.
   */
  const write = Promise.withResolvers<undefined>();
  const teardown = makeReader({ accessMethodWrite: async (): Promise<void> => write.promise, options: ["Enable.Log.Debug"],
    record: testHub({ capabilities, configs: pinRow("no") }) });
  const pending = triggerSet(switchService(teardown, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On), true);

  await settle();

  assert.equal(teardown.accessMethodWrites[0]?.signal, teardown.hub.signal, "the write carries the device's own lifetime");

  teardown.hub.cleanup();

  assert.equal(teardown.hub.signal.aborted, true, "so the device's teardown is what aborts it");

  write.reject(pinDecline(true));
  await pending;

  assert.deepEqual(teardown.errors, [], "a decline landing after teardown began is not announced");
  assert.equal(teardown.debugs.filter(line => line.startsWith(LOG_PREFIX + "The access method write was refused:")).length, 0, "nor noted at debug");

  // An AccessAbortedError reads the same way, whatever raised it, and the switch keeps the value HomeKit wrote.
  const aborted = makeReader({ accessMethodWrite: async (): Promise<void> => { throw new AccessAbortedError("The access method write was aborted."); },
    options: ["Enable.Log.Debug"], record: testHub({ capabilities, configs: pinRow("no") }) });
  const abortedOn = switchService(aborted, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On);

  await triggerSet(abortedOn, true);
  aborted.clock.advance(REVERT_DELAY_MS);

  assert.deepEqual(aborted.errors, [], "an aborted write is not announced as a failure");
  assert.equal(aborted.debugs.filter(line => line.startsWith(LOG_PREFIX + "The access method write was refused:")).length, 0, "nor noted at debug");
  assert.equal(abortedOn.value, true, "and nothing is put back");
});

test("a row filed under another tag or stating something other than yes or no gives its method no reading, and its switch reads off", async () => {

  /* The PIN row says yes, but under a tag the controller files no access method under, and the NFC row sits under the right tag stating a value outside the pair.
   * Neither establishes a reading. Each switch exists on its capability all the same and reads off, which is what a method with no reading answers in HomeKit.
   */
  const harness = makeReader({ record: testHub({ capabilities: [ "is_hub", "is_reader", "nfc_card_easy_provision", "pin_code" ],
    configs: [ { device_id: HUB_ID, key: "pin_code", tag: "input_state", value: "yes" }, { device_id: HUB_ID, key: "nfc", tag: "open_door_mode", value: "maybe" } ] }) });

  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "the rows seeded the model, so the switches stand on their capabilities");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "a yes under another tag is no access method reading");
  assert.equal(await switchReads(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), false, "and a value outside the pair is none either");
});

test("a record refresh moves the model, and a refresh restating rows already folded moves nothing", async () => {

  const row = (value: string): unknown[] => [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value }];
  const reader = { capabilities: [ "is_hub", "is_reader", "pin_code" ] };

  // A refresh carrying genuine news moves what the switch answers.
  const refreshed = makeReader({ record: testHub({ ...reader, configs: row("no") }) });

  assert.equal(await switchReads(refreshed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false);

  refreshRecord(refreshed, row("yes"));

  assert.equal(await switchReads(refreshed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), true, "a row the refresh moved moves the model");

  // A row the record has dropped must leave no entry standing behind it, which is what makes the fold a rebuild rather than a merge.
  refreshRecord(refreshed, []);

  assert.equal(await switchReads(refreshed, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), false, "a row the record dropped leaves nothing standing");

  // The recency guard: a confirmed write moves the model ahead of the rows, and the rows restating what they said before must not drag it back.
  const written = makeReader({ record: testHub({ ...reader, configs: row("no") }) });

  await triggerSet(switchService(written, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN).getCharacteristic(Characteristic.On), true);

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

  /* Both directions go through the library's rail and compose no request of their own: a door command that reached for the Access application's own endpoint would
   * show up here rather than passing quietly.
   */
  assert.equal(opening.requests.length, 0, "the opening direction goes through the library's rail rather than an endpoint composed here");
});

test("a garage door opener on a door hub closes with the momentary pulse, on a credentialed client and a token-only one alike", async () => {

  /* The pulse is the library's plain unlock, naming no door for hardware that drives one and asking for no lock rule of any kind, so what it carries beyond the
   * attribution every unlock carries is nothing at all. The attributed pulse travels only on the official API: a credential-only client refuses the attribution at
   * the library's routing gate, and this plugin resends the same unlock unattributed over the Access application's own path, which this harness's double does not
   * distinguish.
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

test("a refused close puts a gate's opener back and leaves the lock state and the pending relock exactly as they were", async () => {

  const gate = makeGate({ options: ["Enable.Hub.Lock.Trigger"], reject: ["close"] });
  const opener = openerService(gate);
  const trigger = switchService(gate, AccessReservedNames.SWITCH_LOCK_TRIGGER);

  // Unlock over MQTT first, so there is an unlocked state and a pending relock for the refused close below to leave alone, with the gate itself standing still.
  await gate.mqttSet("lock", "false");
  await settle();

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "the gate is unlocked after the trigger it opens on");

  await writeTarget(gate, Characteristic.TargetDoorState.CLOSED);
  gate.clock.advance(REVERT_DELAY_MS);

  // Nothing settled, so the transitional state HomeKit was shown goes back to where the gate actually stands.
  assert.equal(opener.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.OPEN);
  assert.equal(opener.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "a close the controller refused never locks the door behind HomeKit's back");

  // The unlock went through the library's own rail, and the close that followed it was dispatched and refused rather than never sent.
  assert.deepEqual(gate.commands, [ { options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }, { options: { doorId: MAIN_DOOR }, verb: "close" } ]);

  // A close nobody accepted ends no window, so the topic still stands where the unlock left it rather than announcing a gate that never locked.
  assert.deepEqual(lockPayloads(gate), ["false"], "a refused close announces nothing");

  // And the relock the unlock armed is still pending, because only a close that succeeded has anything to cancel.
  gate.clock.advance(RELOCK_DELAY_MS - REVERT_DELAY_MS);
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false, "the pending relock still runs its course");

  // The window ends on the relock instead, which is the announcement the refused close did not get to make.
  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);

});

test("a refused pulse puts a door hub's opener back", async () => {

  const opener = makeOpener({ reject: ["unlock"] });
  const service = openerService(opener);

  await writeTarget(opener, Characteristic.TargetDoorState.CLOSED);
  opener.clock.advance(REVERT_DELAY_MS);

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
  assert.ok(hub.errors.some(line => line.includes("Unable to manually relock the door because the lock relay is on its default settings. " +
    "Set a lock delay interval for this door to relock it from HomeKit.")), "the refusal says why the door cannot be relocked");
});

test("a UA Gate's lock accessory closes the gate, reads secured afterward, and cancels the relock it no longer needs", async () => {

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
  gate.clock.advance(RELOCK_DELAY_MS);
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

test("a UA Gate's side door relocks through the close command, on its own MQTT topic and on its own automation trigger", async () => {

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
  gate.clock.advance(RELOCK_DELAY_MS);
  assert.equal(lineCount(gate, "Side door locked."), 1, "the close cancelled the side door's pending relock");

  // And the automation trigger reaches the same verb with the same door.
  await triggerSet(switchService(gate, AccessReservedNames.SWITCH_LOCK_DOOR_SIDE_TRIGGER).getCharacteristic(Characteristic.On), false);

  assert.deepEqual(gate.commands.map(command => command.options), [ { actor: UNLOCK_ACTOR, doorId: SIDE_DOOR }, { doorId: SIDE_DOOR }, { doorId: SIDE_DOOR } ]);
  assert.deepEqual(gate.commands.map(command => command.verb), [ "unlock", "close", "close" ]);

  // That third close ended nothing: the side door was already secured, so it added no payload and said nothing a second time.
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Side door locked."), 1);

});

test("a UA Gate's own lock automation trigger closes the gate", async () => {

  const gate = makeGate({ options: ["Enable.Hub.Lock.Trigger"] });

  // The switch mirrors the lock, so turning it off is asking for the locked direction.
  await triggerSet(switchService(gate, AccessReservedNames.SWITCH_LOCK_TRIGGER).getCharacteristic(Characteristic.On), false);

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

test("an unlock a client cannot attribute is sent again unattributed, and opens the gate exactly as it always has", async () => {

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
  gate.clock.advance(RELOCK_DELAY_MS);

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false);
  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
});

test("an unlock that fails for any reason but the attribution is reported as it always has been, and never sent twice", async () => {

  /* The fallback answers one thing: a client that cannot say who acted. Anything else is a fault of the unlock itself, so it surfaces through the command's own
   * reporting and is never quietly sent a second time - a catch reaching wider than the capability refusal would open this door twice on a fault that named it.
   */
  const failure = "The controller rejected the request.";
  const gate = makeGate({ unlockRefusal: new AccessApiError(failure, { code: "CODE_OPERATION_FORBIDDEN" }) });

  await gate.mqttSet("lock", "false");
  await settle();

  assert.deepEqual(gate.commands, [{ options: { actor: UNLOCK_ACTOR, doorId: MAIN_DOOR }, verb: "unlock" }], "one dispatch, and no retry behind it");
  assert.deepEqual(gate.errors, [LOG_PREFIX + "Unable to unlock the gate: The controller rejected the request."]);

  // Nothing announced and nothing armed, which is what an unlock the controller never performed has always left behind.
  assert.deepEqual(lockPayloads(gate), []);
  assert.equal(lineCount(gate, "Gate unlocked."), 0);
});

test("a gate unlocked from HomeKit announces the window it opened, and the relock announces the end of it exactly once", async () => {

  const gate = makeGate();

  await gate.mqttSet("lock", "false");
  await settle();

  /* The controller sends nothing back over the event stream for a door command of ours, so the announcement of the window is the plugin's own to make. Every
   * surface that can unlock a gate - this topic, the lock accessory, the opener, the automation triggers - reaches the one arm that makes it.
   */
  assert.deepEqual(lockPayloads(gate), ["false"]);
  assert.equal(lineCount(gate, "Gate unlocked."), 1);

  gate.clock.advance(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);

  // A second full delay finds nothing armed: a window ends once, and the relock that ended this one did not re-arm on its way out.
  gate.clock.advance(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);
});

test("a close inside the window ends it once, and the relock it cancelled adds nothing behind it", async () => {

  const gate = makeGate();

  await gate.mqttSet("lock", "false");
  await settle();
  await gate.mqttSet("lock", "true");
  await settle();

  // The close is what ended the window, so the topic carries both halves rather than stranding at the unlock's own.
  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);

  // A relock the close failed to cancel would announce the same ending a second time.
  gate.clock.advance(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1);
});

test("a remote unlock opens the same window a command of ours does, on either of a gate's two doors", () => {

  const gate = makeGate();

  // The controller's own report of an unlock, reaching the gate under the event name, with the door it names being what the gate tells its two doors apart by.
  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: MAIN_DOOR });

  assert.deepEqual(lockPayloads(gate), ["false"]);
  assert.equal(lineCount(gate, "Gate unlocked."), 1);

  // A second unlock while the window stands announces again and replaces the pending relock rather than stacking a second one beside it.
  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: MAIN_DOOR });

  assert.deepEqual(lockPayloads(gate), [ "false", "false" ]);
  assert.equal(lineCount(gate, "Gate unlocked."), 2);

  gate.clock.advance(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1, "the replaced timer left exactly one relock to fire");

  // The side door runs the whole window on its own topic and under its own name, ending on the relock nobody cancelled.
  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: SIDE_DOOR });

  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), ["false"]);
  assert.equal(lineCount(gate, "Side door unlocked."), 1);

  gate.clock.advance(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Side door locked."), 1);
});

test("a gate ignores a remote unlock naming a door it does not drive", () => {

  const gate = makeGate();

  // Every remote unlock on the controller reaches every gate under the one event name, so what a gate applies is settled by the door the packet names.
  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: "another-door" });

  assert.deepEqual(lockPayloads(gate), [], "a door this gate does not drive moves its main lock nowhere");
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), [], "and its side door lock nowhere");
  assert.deepEqual(gate.lines, [], "and nothing is announced for it");
});

test("a repeat pass leaves an unlocked door's lock trigger on and writes nothing to it", async () => {

  const harness = makeHub({ options: ["Enable.Hub.Lock.Trigger"] });

  deliverDoorState(harness, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });

  const trigger = switchService(harness, AccessReservedNames.SWITCH_LOCK_TRIGGER);

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "an unlocked door puts the trigger on");

  harness.accessory.clearObservations();
  restateRecord(harness, {});

  assert.deepEqual(writesOn(harness.accessory, trigger), [], "a repeat pass finds the switch dressed and writes nothing to it");
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "so the unlocked door is still showing");
  assert.equal(await triggerGet(trigger.getCharacteristic(Characteristic.On)), true, "and the handler the creation registered still answers");
});

test("a repeat pass does not halt a running travel", async () => {

  const opener = makeTravellingOpener({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" } });

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);
  restateRecord(opener, {});

  assert.equal(openerService(opener).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING,
    "the travel the write started is still running, which a pass re-entering the opener's own configuration would have halted");

  // A halt drains the travel's timer, so a door it halted would stand at the transitional reading forever. Settling on the evidence is what proves the timer survived.
  opener.clock.advance(TRAVEL_MS);

  assert.equal(openerService(opener).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED,
    "and settles on its own timer, showing what the door reports by then");
});

test("a restated record with nothing changed writes nothing to any service and creates none", () => {

  for(const harness of [ makeHub({ options: [ "Enable.Hub.Doorbell.Trigger", "Enable.Hub.Lock.Trigger" ], record: wiredHub("on") }),
    makeGate({ options: ["Enable.Hub.Door.Service=Lock"] }) ]) {

    const before = [...harness.services];

    harness.accessory.clearObservations();
    restateRecord(harness, {});

    for(const service of before) {

      assert.deepEqual(writesOn(harness.accessory, service), [], "a pass over a record that did not change writes nothing to the " + service.displayName + " service");
    }

    /* Read the services member for member rather than by count alone: a pass that re-created one instead of finding it would leave a list of the same length whose
     * new members the reads above never select, and every write to those would go unseen there.
     */
    assert.equal(harness.services.length, before.length, "and creates none beside the ones it found");

    for(const [ index, service ] of before.entries()) {

      assert.equal(harness.services[index], service, "and each position carries the service the pass found rather than one it built");
    }
  }
});

test("a gate whose record rebinds its ports mid-run follows the rebind", () => {

  const gate = makeGate({ options: ["Enable.Hub.Door.Service=Lock"] });

  // What the controller has established about the door the main port is about to be bound to, which is what the seed of a moved identity reads.
  gate.setDoorState({ dps: "open", location_id: NEW_MAIN, lock: "unlock" });

  restateRecord(gate, { extensions: [ portBinding("oper2", NEW_SIDE), portBinding("oper1", NEW_MAIN) ] });

  assert.equal(lockService(gate).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
    "the door the main port now names is seeded from the map");
  assert.deepEqual(lockPayloads(gate), [], "silently, as every seed is");
  assert.equal(lineCount(gate, "Gate unlocked."), 0);

  deliverDoorState(gate, { dps: "close", location_id: MAIN_DOOR, lock: "lock" });

  assert.equal(lockService(gate).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
    "the identity the gate left behind is nobody's, so nothing delivered under it reaches the gate");

  deliverDoorState(gate, { dps: "close", location_id: NEW_MAIN, lock: "lock" });

  assert.equal(lockService(gate).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
    "while the door it moved onto reaches it through the rail as every reading does");
  assert.deepEqual(lockPayloads(gate), ["true"]);

  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: NEW_SIDE });

  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), ["false"], "the side port's new door is owned from the rebind on");
  assert.equal(lineCount(gate, "Side door unlocked."), 1);

  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: SIDE_DOOR });

  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), ["false"], "and the one it left behind owns nothing");

  // The topology carries neither door, so each announcement names the identity the binding gave it.
  assert.equal(lineCount(gate, "The gate's main door is now " + NEW_MAIN + "."), 1);
  assert.equal(lineCount(gate, "The gate's side door is now " + NEW_SIDE + "."), 1);
});

test("a gate announces each door whose identity moved by its topology name, and a record whose bindings did not move is silent", () => {

  const gate = makeGate({ options: ["Enable.Hub.Door.Service=Lock"] });

  // The two roles swapped over the doors the topology knows, so each announcement can be read for the name it renders rather than for the identity behind it.
  restateRecord(gate, { extensions: [ portBinding("oper1", SIDE_DOOR), portBinding("oper2", MAIN_DOOR) ] });

  assert.equal(lineCount(gate, "The gate's main door is now Pedestrian Gate."), 1, "a moved identity is announced under the name the topology carries for it");
  assert.equal(lineCount(gate, "The gate's side door is now Main Gate."), 1);
  assert.equal(gate.lines.length, 2, "and nothing else is said for the pass that moved them");

  restateRecord(gate, { extensions: [ portBinding("oper1", SIDE_DOOR), portBinding("oper2", MAIN_DOOR) ] });

  assert.equal(gate.lines.length, 2, "a record whose bindings did not move moves no identity, so it says nothing");
  assert.deepEqual(lockPayloads(gate), [], "and no seed of either pass reaches the topic");
});

test("a gate whose side door binding is withdrawn says so once and keeps the side door's services at their last reading", () => {

  // A topology of one door, so the side arm's name and two-door fallbacks answer nothing and the side door is the binding's to name or to withhold.
  const gate = makeGate({ doors: [{ name: "Main Gate", unique_id: MAIN_DOOR }], options: ["Enable.Hub.Door.Service=Lock"] });

  restateRecord(gate, { extensions: [ portBinding("oper1", MAIN_DOOR), portBinding("oper2", NEW_SIDE) ] });

  assert.equal(lineCount(gate, "The gate's side door is now " + NEW_SIDE + "."), 1, "the binding names a side door the topology never resolved");

  restateRecord(gate, { extensions: [portBinding("oper1", MAIN_DOOR)] });

  assert.equal(warnCount(gate, "The controller no longer reports a door for the gate's side door; its accessories keep the last state they showed."), 1,
    "and the binding going is warned, because a role nothing occupies is not a role the gate can drive");
  assert.ok(lockService(gate, AccessReservedNames.LOCK_DOOR_SIDE), "the side door's lock is option-gated, so it stands where the user asked for it");

  deliverDoorState(gate, { dps: "open", location_id: NEW_SIDE, lock: "unlock" });

  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), [], "and nothing delivered under the withdrawn identity moves it");

  restateRecord(gate, { extensions: [portBinding("oper1", MAIN_DOOR)] });

  assert.equal(warnCount(gate, "The controller no longer reports a door for the gate's side door; its accessories keep the last state they showed."), 1,
    "a role that was already vacant did not move, so the warning is not repeated");
});

test("a rebind retires the relock window opened for the door that left the role", () => {

  const gate = makeGate({ options: ["Enable.Hub.Door.Service=Lock"] });

  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: MAIN_DOOR });

  assert.deepEqual(lockPayloads(gate), ["false"], "the unlock opens the window");
  assert.equal(lineCount(gate, "Gate unlocked."), 1);

  gate.setDoorState({ dps: "open", location_id: NEW_MAIN, lock: "unlock" });
  restateRecord(gate, { extensions: [ portBinding("oper2", NEW_SIDE), portBinding("oper1", NEW_MAIN) ] });

  assert.deepEqual(lockPayloads(gate), ["false"], "the seed of the door that took the role agrees with what the gate already reads, so it is silent");

  gate.clock.advance(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), ["false"], "a window of ours belongs to the door it was opened for, so it leaves with that door");
  assert.equal(lineCount(gate, "Gate locked."), 0, "and fires against neither the door that took the role nor the one that left it");

  deliverDoorState(gate, { dps: "close", location_id: NEW_MAIN, lock: "lock" });

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ], "the controller's own report of the new door still reaches it through the rail");
  assert.equal(lineCount(gate, "Gate locked."), 1);
});

test("a gate whose bindings name no side door keeps each door in its role, whichever order the controller delivers the bindings in", () => {

  const gate = makeGate({ options: ["Enable.Hub.Door.Service=Lock"] });

  /* Neither binding names the side door's port, so neither identifies a role: the main door stays the one the record's location names and the side door the one
   * the topology names like a side door, in both delivery orders. A rule taking the main door from the first binding delivered would announce NEW_MAIN on the
   * first restatement and NEW_SIDE on the second.
   */
  restateRecord(gate, { extensions: [ portBinding("oper1", NEW_MAIN), portBinding("oper3", NEW_SIDE) ] });

  assert.equal(gate.lines.length, 0, "bindings that identify no role move no door");

  restateRecord(gate, { extensions: [ portBinding("oper3", NEW_SIDE), portBinding("oper1", NEW_MAIN) ] });

  assert.equal(gate.lines.length, 0, "and the same bindings delivered in the other order move none either");

  // The main door is still the one the location names, so readings delivered under it reach the gate's lock in both directions.
  deliverDoorState(gate, { dps: "open", location_id: MAIN_DOOR, lock: "unlock" });

  assert.equal(lockService(gate).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);

  deliverDoorState(gate, { dps: "close", location_id: MAIN_DOOR, lock: "lock" });

  assert.equal(lockService(gate).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
    "the main door never left the door the location names");
});

test("a gate carrying a third binding beside its side door's takes the side door from its port and leaves the main door where it stood", () => {

  const gate = makeGate({ options: ["Enable.Hub.Door.Service=Lock"] });

  /* The side door's port names its binding, so the side door moves to it. The main door's binding is trusted only as the one other binding beside the side door's,
   * so with two others there the main door stays the one the location names. A rule trusting any binding beside the side door's would move the main door to
   * NEW_MAIN and announce it as well.
   */
  restateRecord(gate, { extensions: [ portBinding("oper1", NEW_MAIN), portBinding("oper2", NEW_SIDE), portBinding("oper3", SIDE_DOOR) ] });

  assert.equal(lineCount(gate, "The gate's side door is now " + NEW_SIDE + "."), 1, "the side door follows the port that names it");
  assert.equal(gate.lines.length, 1, "and the main door stays where it stood, silently");
});

test("a gate whose record binds two of the controller's doors takes its roles from them, so another hub's door its location names takes neither", () => {

  /* The topology lists another hub's door first, under a name the main arm matches, and the record's location names it. The bindings carry the names of the doors
   * they serve, so neither identifies a role, and the arms below them choose among the gate's two bound doors alone.
   */
  const gate = makeGate({ doors: [ { name: "Front Door", unique_id: OTHER_DOOR }, { name: "Main Gate", unique_id: MAIN_DOOR },
    { name: "Pedestrian Gate", unique_id: SIDE_DOOR } ], options: ["Enable.Hub.Door.Service=Lock"], record: testHub({ device_type: "UGT",
    extensions: [ portBinding("Main Gate", MAIN_DOOR), portBinding("Pedestrian Gate", SIDE_DOOR) ], location_id: OTHER_DOOR }) });

  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: OTHER_DOOR });

  assert.deepEqual(lockPayloads(gate), [], "an unlock of the other hub's door reaches neither of the gate's locks");
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), []);

  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: MAIN_DOOR });
  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: SIDE_DOOR });

  assert.deepEqual(lockPayloads(gate), ["false"], "while the gate's own main door holds the main role");
  assert.deepEqual(lockPayloads(gate, "sidedoor/lock"), ["false"], "and its own side door the side role");
});

/* The sentence a gate writes at debug level for one resolution of its doors, as the debug sink carries it: the bindings it resolved from and the door each role
 * landed on. The bindings the harness builds carry a name and no port, so each one's port reads as unnamed.
 *
 * @param bindings - Each binding as the name the controller wrote beside it and the door it is bound to, in delivered order.
 * @param mainDoor - The door the main role landed on, or none.
 * @param sideDoor - The door the side role landed on, or none.
 *
 * @returns The line as the debug sink carries it.
 */
function resolution(bindings: [ string, string ][], mainDoor: string, sideDoor: string): string {

  const rendered = bindings.map(([ name, doorId ]) => name + " on an unnamed port bound to " + doorId);

  return LOG_PREFIX + "Gate doors resolved from the port bindings (" + (bindings.length ? rendered.join(", ") : "none") + ") to main door " + mainDoor +
    " and side door " + sideDoor + ".";
}

/* Every resolution a gate has written at debug level, oldest first, which is how a pass that said one is told from a pass that said none.
 *
 * @param harness - The gate to read.
 *
 * @returns The resolution lines in the debug sink.
 */
function resolutionLines(harness: HubHarness): string[] {

  return harness.debugs.filter(line => line.startsWith(LOG_PREFIX + "Gate doors resolved"));
}

test("a gate says at debug level what its bindings resolved to on every pass that moved a role, adoption included, and nothing on a pass that moved none", () => {

  const gate = makeGate({ keepAdoptionLines: true, options: [ "Enable.Hub.Door.Service=Lock", "Enable.Log.Debug" ] });
  const adoption = resolution([], MAIN_DOOR, SIDE_DOOR);

  // Adoption moves every role off the empty seed, so a fresh start carries its own evidence. A line held back for a pass that follows would leave this empty.
  assert.deepEqual(resolutionLines(gate), [adoption], "adoption says what the record resolved to");

  // A device update that moves nothing says nothing, so a debug-enabled log does not repeat the resolution on every restatement.
  restateRecord(gate, {});

  assert.deepEqual(resolutionLines(gate), [adoption], "a pass that moved no role adds no line");

  const rebind = resolution([ [ "oper2", NEW_SIDE ], [ "oper1", NEW_MAIN ] ], NEW_MAIN, NEW_SIDE);

  restateRecord(gate, { extensions: [ portBinding("oper2", NEW_SIDE), portBinding("oper1", NEW_MAIN) ] });

  assert.deepEqual(resolutionLines(gate), [ adoption, rebind ], "a rebind that moved both roles says what each binding named and where each role landed");

  // The main door alone moves back while the side door stays, so a pass counts as moved when any role moved rather than when the last role it read did.
  restateRecord(gate, { extensions: [ portBinding("oper2", NEW_SIDE), portBinding("oper1", MAIN_DOOR) ] });

  assert.deepEqual(resolutionLines(gate), [ adoption, rebind, resolution([ [ "oper2", NEW_SIDE ], [ "oper1", MAIN_DOOR ] ], MAIN_DOOR, NEW_SIDE) ],
    "a pass that moved one role says so as well");
});

test("a gate says at debug level what its bindings resolved to when a role is withdrawn, which moves no door into it", () => {

  // A topology of one door, so the side arm's name and two-door fallbacks answer nothing and the side door is the binding's to name or to withhold.
  const gate = makeGate({ doors: [{ name: "Main Gate", unique_id: MAIN_DOOR }], keepAdoptionLines: true,
    options: [ "Enable.Hub.Door.Service=Lock", "Enable.Log.Debug" ] });
  const adoption = resolution([], MAIN_DOOR, "none");

  assert.deepEqual(resolutionLines(gate), [adoption], "adoption says the side role holds no door");

  const arrival = resolution([ [ "oper1", MAIN_DOOR ], [ "oper2", NEW_SIDE ] ], MAIN_DOOR, NEW_SIDE);

  restateRecord(gate, { extensions: [ portBinding("oper1", MAIN_DOOR), portBinding("oper2", NEW_SIDE) ] });

  assert.deepEqual(resolutionLines(gate), [ adoption, arrival ], "the side door alone arrives");

  /* The side door's binding goes while the main door stays, so no door moves into any role. The withdrawal still changed a role, which is what earns the line...a
   * line keyed to the doors that moved in would stay silent here.
   */
  restateRecord(gate, { extensions: [portBinding("oper1", MAIN_DOOR)] });

  assert.deepEqual(resolutionLines(gate), [ adoption, arrival, resolution([[ "oper1", MAIN_DOOR ]], MAIN_DOOR, "none") ], "and its withdrawal is said as well");
});

test("a gate the controller reports locked retires the relock our own unlock armed", async () => {

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
  gate.clock.advance(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.equal(lineCount(gate, "Gate locked."), 1, "and the retired relock announced nothing on top of it");
});

test("a rail-reported lock and re-unlock inside the window leave no stale relock to announce over them", async () => {

  const gate = makeGate();

  await gate.mqttSet("lock", "false");
  await settle();

  /* The controller's own reading outranks the window we model. A relock still pending when the rail reports the door locked has nothing left to do, and left
   * armed it fires against whatever the door has become by the time it expires. The reports below are what tell the retirement from its absence: with
   * the door reported unlocked again, a surviving relock would both flip the state and speak over the controller's fresher truth.
   */
  deliverDoorState(gate, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });
  deliverDoorState(gate, { dps: "open", location_id: MAIN_DOOR, lock: "unlocked" });

  gate.clock.advance(RELOCK_DELAY_MS);

  // A relock the rail's report failed to retire would fire here and announce a close over the controller's fresher reading, so the payloads and the count below
  // prove none did.
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

test("a UA Gate's side door reported locked retires the relock its own unlock armed", async () => {

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

  gate.clock.advance(RELOCK_DELAY_MS);

  // A relock the rail's report failed to retire would fire here and announce a close over the controller's fresher reading, so the payloads and the count below
  // prove none did.
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
  assert.deepEqual(departing.publishes, [adoptionStatement(departing)]);
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

test("a door hub announces one remote unlock once, whichever of its two rails reports it first", (t) => {

  /* The controller reports an unlock on its remote-unlock rail and reports the door unlocked on the door-state rail, and either can arrive first. One physical
   * event is one announcement whichever ordering this hub sees. The packet names the hub itself, which is how hub-class hardware reports the unlock it performed.
   */
  const first = makeHub();
  const packet = { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: HUB_ID };

  /* The rail delivers one packet twice to a hub registered under both its event name and its own identity, and whether that reaches the handler once or twice is not
   * observable from the lock, whose guarded write swallows a repeat. So the handler itself is what this half counts, which is why the arm reaches for a private one.
   */
  const handled = t.mock.method(first.hub as unknown as { handleRemoteUnlock: (delivered: unknown) => void }, "handleRemoteUnlock");

  first.emit(ACCESS_REMOTE_UNLOCK_EVENT, packet);
  first.emit(HUB_ID, packet);
  deliverDoorState(first, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });

  assert.equal(handled.mock.callCount(), 1, "the rail's two emissions of one packet reach the handler once");
  assert.deepEqual(lockPayloads(first), ["false"]);
  assert.equal(lineCount(first, "Door unlocked."), 1);
  assert.equal(lockService(first).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);

  // The same pair in the other order, which is the ordering the field's own same-second duplicate was read in.
  const second = makeHub();

  deliverDoorState(second, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });
  second.emit(ACCESS_REMOTE_UNLOCK_EVENT, packet);
  second.emit(HUB_ID, packet);

  assert.deepEqual(lockPayloads(second), ["false"]);
  assert.equal(lineCount(second, "Door unlocked."), 1);
  assert.equal(lockService(second).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED);

  // And the door still moves on the next genuine transition rather than being left settled by the pair that reached it.
  deliverDoorState(second, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });

  assert.deepEqual(lockPayloads(second), [ "false", "true" ]);
  assert.equal(lineCount(second, "Door locked."), 1);
  assert.equal(lockService(second).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED);
});

test("a remote unlock is settled by the identity it names: the hub that performed it, one of its doors, or another device altogether", () => {

  /* The controller reports this notification in two identity spaces - hub-class hardware names the device that performed the unlock, and a gate names the door - and
   * every hub on the controller sees every one of them under the event name, so what a hub applies is settled by the identity the packet names and nothing else.
   */
  const foreign = makeHub();

  foreign.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: "another-hub" });

  assert.deepEqual(lockPayloads(foreign), [], "an unlock another device performed moves this hub's lock nowhere");
  assert.deepEqual(foreign.lines, [], "and nothing is announced for it");
  assert.equal(lockService(foreign).getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED);

  const byDoor = makeHub();

  byDoor.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: MAIN_DOOR });

  assert.deepEqual(lockPayloads(byDoor), ["false"], "a packet naming this hub's door in the gate's identity space is applied as the same unlock");
  assert.equal(lineCount(byDoor, "Door unlocked."), 1);

  const gate = makeGate();

  gate.emit(ACCESS_REMOTE_UNLOCK_EVENT, { event: ACCESS_REMOTE_UNLOCK_EVENT, event_object_id: HUB_ID });

  assert.deepEqual(lockPayloads(gate), ["false"], "and a gate named by its own identity reads it as its main door");
  assert.equal(lineCount(gate, "Gate unlocked."), 1);
});

test("the lock logging preference silences a door's lock lines and never its topic", async () => {

  const hub = makeHub({ options: [listLess("Log.Events", logEventChoices(), "Lock")] });

  deliverDoorState(hub, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });
  deliverDoorState(hub, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });

  // The lock lines alone are read: a first delivery also gives the position sensor its evidence, which the sensor announces on its own account.
  assert.deepEqual(lockPayloads(hub), [ "false", "true" ]);
  assert.deepEqual(hub.lines.filter(line => line.endsWith(" locked.") || line.endsWith(" unlocked.")), []);

  // A gate's own window speaks through the same helper, so the preference silences the window exactly as it silences the rail.
  const gate = makeGate({ options: [listLess("Log.Events", logEventChoices(), "Lock")] });

  await gate.mqttSet("lock", "false");
  await settle();
  gate.clock.advance(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), [ "false", "true" ]);
  assert.deepEqual(gate.lines.filter(line => line.endsWith(" locked.") || line.endsWith(" unlocked.")), []);
});

test("an unlock the controller refuses says so and opens no window at all", async () => {

  const gate = makeGate({ reject: ["unlock"] });

  await gate.mqttSet("lock", "false");
  await settle();

  // The refusal is the error the command dispatch raised, carried verbatim inside the wrapper this command reports every failure in.
  assert.deepEqual(gate.errors, [LOG_PREFIX + "Unable to unlock the gate: The controller refused this command."]);

  // Nothing announced and nothing armed: a window that never opened has no state to flip and no ending to reach.
  assert.deepEqual(lockPayloads(gate), []);
  assert.equal(lineCount(gate, "Gate unlocked."), 0);

  gate.clock.advance(RELOCK_DELAY_MS);

  assert.deepEqual(lockPayloads(gate), []);
});

test("a write on a standing door starts the travel the opener renders, in the direction it was asked for", async () => {

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

test("a travel nobody confirms ends on its own timer, showing whatever the door reports by then", async () => {

  /* Each door below reports the same position throughout, and it is the opposite of what the travel was heading for. A settle that rendered the destination
   * rather than the evidence would answer the other way in every one of them.
   */
  const closing = makeTravellingOpener({ doorState: { dps: "open", location_id: MAIN_DOOR, lock: "unlock" } });

  await writeTarget(closing, Characteristic.TargetDoorState.CLOSED);
  closing.clock.advance(TRAVEL_MS - 1);

  assert.equal(openerService(closing).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING,
    "the travel runs for the whole duration configured for it");

  closing.clock.advance(1);

  assert.equal(openerService(closing).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN);

  const opening = makeTravellingOpener({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" } });

  await writeTarget(opening, Characteristic.TargetDoorState.OPEN);
  opening.clock.advance(TRAVEL_MS);

  assert.equal(openerService(opening).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  // And a door halted mid-travel comes to rest the same way, on the timer the halt re-armed.
  const halted = makeTravellingOpener({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" } });

  await writeTarget(halted, Characteristic.TargetDoorState.OPEN);
  await writeTarget(halted, Characteristic.TargetDoorState.CLOSED);

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);

  halted.clock.advance(TRAVEL_MS - 1);

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED,
    "the halt re-arms the travel timer rather than inheriting what was left of the old one");

  halted.clock.advance(1);

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

test("a gate operated mid-travel is halted through the library's own stop, from either direction", async () => {

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

test("a gate whose client cannot carry a stop is halted all the same, and says why once", async () => {

  const gate = makeGate({ options: ["Enable.Log.Debug"], reject: ["stop"] });

  await writeTarget(gate, Characteristic.TargetDoorState.CLOSED);
  await writeTarget(gate, Characteristic.TargetDoorState.OPEN);

  // The gate stands where its travel left it whether or not the controller could be told to stop it, so the machine proceeds identically.
  assert.equal(openerService(gate).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);
  assert.deepEqual(gate.debugs.filter(line => line.includes("Unable to halt the gate")).length, 1, "the refusal is said once, at debug");
  assert.deepEqual(gate.errors, [], "and a halt the client cannot carry is not an error the user has to read");
});

test("a door hub's opener halts on its own pulse, and only once that pulse comes back", async () => {

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
  refusing.clock.advance(REVERT_DELAY_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING);
  assert.equal(service.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.CLOSED);

  // The timer the first write armed is still the live one, so the travel ends on its own schedule rather than on one the refusal re-armed.
  refusing.clock.advance(TRAVEL_MS - REVERT_DELAY_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

test("a halted door resumes the direction its own hardware answers to: a gate the target written, a momentary operator the reverse of the interrupted travel",
  async () => {

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

test("a closed reading settles every travel, and an open reading settles only an opening one", async () => {

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

  closingOpen.clock.advance(TRAVEL_MS);

  assert.equal(openerService(closingOpen).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN,
    "and the travel still ends on its own timer, on the evidence it finds there");
});

test("a halted door settles on a closed reading and waits out an open one", async () => {

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

test("a halted door whose sensor says nothing new still comes to rest on its own timer", async () => {

  const halted = makeTravellingOpener({ doorState: { dps: "open", location_id: MAIN_DOOR, lock: "unlock" } });

  await writeTarget(halted, Characteristic.TargetDoorState.CLOSED);
  await writeTarget(halted, Characteristic.TargetDoorState.OPEN);

  // The same reading the door already held, which the delivery's own change detection swallows...so the timer is the halt's guaranteed way out.
  deliverDoorState(halted, { dps: "open", location_id: MAIN_DOOR, lock: "unlock" });

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED);

  halted.clock.advance(TRAVEL_MS);

  assert.equal(openerService(halted).getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN);
});

test("a door with no travel time to model renders instantly, and a UA Gate falls back to the window its hardware is given", async () => {

  const opener = makeOpener();
  const service = openerService(opener);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);

  // Nothing transitional is shown and no timer is armed: the door goes on reporting where the evidence puts it.
  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  opener.clock.advance(TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  const gate = makeGate();
  const gateService = openerService(gate);

  await writeTarget(gate, Characteristic.TargetDoorState.CLOSED);

  assert.equal(gateService.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING);

  gate.clock.advance(GATE_TRAVEL_MS - 1);

  assert.equal(gateService.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING,
    "an unconfigured gate travels for the window that hardware is given");

  gate.clock.advance(1);

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

  opener.accessory.clearObservations();

  // One delivery moving the position and the relay at once, which is the shape that renders twice if each reading announces itself.
  deliverDoorState(opener, { dps: "open", location_id: MAIN_DOOR, lock: "unlock" });

  assert.deepEqual(writesOn(opener.accessory, openerService(opener)), [
    { characteristic: Characteristic.TargetDoorState.UUID, value: Characteristic.TargetDoorState.OPEN },
    { characteristic: Characteristic.CurrentDoorState.UUID, value: Characteristic.CurrentDoorState.OPEN } ]);
});

test("a UA Gate's MQTT position topic answers the state it holds, a kept sensor with no evidence answers unknown, and a hub showing no position " +
  "answers nothing", async () => {

  const gate = makeGate();

  // Drive the gate's position away from the state it was born holding, so an answer that ignored the live state cannot pass.
  deliverDoorState(gate, { dps: "open", location_id: MAIN_DOOR, lock: "locked" });

  assert.equal(await gate.mqttGet("dps"), "true");

  deliverDoorState(gate, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });

  assert.equal(await gate.mqttGet("dps"), "false");

  // A door hub whose sensor stands through a gap in its evidence still says the position is unknown rather than repeating the reading the sensor last held.
  const kept = makeHub({ doorState: { dps: "open", location_id: MAIN_DOOR, lock: "lock" } });

  deliverDoorState(kept, { dps: "none", location_id: MAIN_DOOR, lock: "lock" });

  assert.equal(await kept.mqttGet("dps"), "unknown");

  // A door hub with no position evidence at all carries no position sensor, so nothing answers on the topic that would describe one.
  await assert.rejects(makeHub().mqttGet("dps"), /no get registration's topic ends with/, "a hub showing no position has no position topic to answer on");
});

test("a command the controller refuses leaves the machine standing and puts the characteristics back", async () => {

  const opener = makeTravellingOpener({ reject: ["unlock"] });
  const service = openerService(opener);

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);
  opener.clock.advance(REVERT_DELAY_MS);

  assert.equal(service.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.CLOSED);
  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);

  // Nothing was armed, so nothing is waiting to expire: a travel that never began cannot end.
  opener.clock.advance(TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

test("the opener reports no obstruction, and a door is presented as one accessory or the other", async () => {

  // The accessory arrives carrying the lock a previous run presented the door as, which is what gives the opener's acquisition a lock to replace.
  const opener = makeOpener({ existing: [new Service.LockMechanism("Test Hub")] });

  assert.equal(await triggerGet(openerService(opener).getCharacteristic(Characteristic.ObstructionDetected)), false);
  assert.equal(opener.services.filter(entry => entry.UUID === Service.LockMechanism.UUID).length, 0, "acquiring the opener removes the lock it replaces");

  const lock = makeHub();

  assert.equal(lock.services.filter(entry => entry.UUID === Service.GarageDoorOpener.UUID).length, 0, "and a door presented as a lock has no opener beside it");
  assert.equal(lock.services.filter(entry => entry.UUID === Service.LockMechanism.UUID).length, 1);
});

test("the travel time is read at the write, so a door reconfigured while it runs travels for its new duration", async () => {

  const opener = makeTravellingOpener();
  const service = openerService(opener);

  opener.reconfigure([ "Enable.Hub.Door.Service=GarageDoorOpener", "Enable.Hub.Door.TransitionDuration." + HUB_SERIAL + ".30" ]);

  await writeTarget(opener, Characteristic.TargetDoorState.OPEN);
  opener.clock.advance(TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING,
    "the duration the hub was built with is not the one in force");

  opener.clock.advance(30000 - TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
});

test("the opener shows the travel before the command behind it settles, and the machine takes only once it has", async () => {

  const opener = makeTravellingOpener({ defer: "unlock" });
  const service = openerService(opener);
  const writing = writeTarget(opener, Characteristic.TargetDoorState.OPEN);

  await settle();

  // HomeKit already sees the travel while the command that carries it is still in flight.
  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING);

  // And nothing is armed behind it yet, so an expiry here would be the expiry of a travel that has not begun.
  opener.clock.advance(TRAVEL_MS);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING);

  opener.release();
  await writing;

  // Now that the command has come back, the travel is the machine's and its own expiry is what ends it.
  opener.clock.advance(TRAVEL_MS - 1);

  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING);

  opener.clock.advance(1);

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

  assert.deepEqual(filtered.mqtt.published.filter(entry => entry.topic === HUB_SERIAL + "/doorbell"),
    [{ payload: "true", retain: false, topic: HUB_SERIAL + "/doorbell" }]);
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

/* A UA Gate on its default opener presentation carries its side door's lock beside the opener, and every device update re-gates the gate's services. The pass
 * removes the presentation that is not selected, which is a lock with no subtype, so the side door's lock, which has one, has to come through it untouched: a pass
 * that removed it would re-create it, handing HomeKit a new service and the log a second announcement on every update.
 */
test("a UA Gate presenting its door as an opener keeps its side door lock through a device update rather than removing and re-creating it", () => {

  const gate = makeGate({ keepAdoptionLines: true });
  const sideLock = lockService(gate, AccessReservedNames.LOCK_DOOR_SIDE);
  const announced = lineCount(gate, "Configuring side door lock.");

  assert.equal(announced, 1, "adoption creates the side door lock and announces it once");

  restateRecord(gate, {});

  assert.equal(lockService(gate, AccessReservedNames.LOCK_DOOR_SIDE), sideLock, "the device update finds the side door lock adoption created");
  assert.equal(gate.services.filter(service => service.UUID === Service.LockMechanism.UUID).length, 1, "and it stays the only lock the accessory carries");
  assert.equal(lineCount(gate, "Configuring side door lock."), announced, "and nothing announces the side door lock a second time");
});

/* HAP refuses a service with no subtype beside any other service of its type. A UA Gate switched from the opener to the lock presentation arrives carrying the
 * opener it is leaving and its side door's lock, with no main door lock yet. The acquisition makes room for the main door's lock, and the side door's lock comes
 * through as the same service rather than a re-created one.
 */
test("a UA Gate switched to the lock presentation beside the side door lock it carries creates its main door lock rather than being refused", () => {

  const sideDoorLock = carried(Service.LockMechanism, AccessReservedNames.LOCK_DOOR_SIDE);
  const existing = [ sideDoorLock, new Service.GarageDoorOpener("Test Hub") ];
  let gate: HubHarness | undefined;

  assert.doesNotThrow(() => {

    gate = makeGate({ existing, options: ["Enable.Hub.Door.Service=Lock"] });
  }, "the gate stands up as a lock beside its side door lock");

  assert.ok(gate);
  assert.equal(gate.services.filter(service => service.UUID === Service.GarageDoorOpener.UUID).length, 0, "the opener it is leaving is removed");
  assert.equal(gate.services.filter(service => service.UUID === Service.LockMechanism.UUID).length, 2, "and it carries exactly two locks");
  assert.equal(lockService(gate, AccessReservedNames.LOCK_DOOR_SIDE), sideDoorLock, "one of them the side door's, the same service it arrived with");
  assert.ok(lockService(gate).isPrimaryService, "and the other the main door's, with no subtype, as the primary service");
});

/* An earlier run marked the doorbell primary, and Homebridge's accessory cache keeps each service's marking. HAP restores the services without recording any of
 * them as the accessory's primary, so a door marked primary at adoption demotes nothing on its own, and the cache would carry more than one primary service. The row
 * reaches that state the way Homebridge does, through a serialize and deserialize round trip, because an accessory built here records its primary as HAP adds it.
 */
test("a hub restored from the cache with its doorbell marked primary leaves its door as the one primary service", () => {

  const cached = makeAccessory([ new Service.LockMechanism("Test Hub"), new Service.Doorbell("Test Hub") ]);
  const cachedDoorbell = cached.getService(Service.Doorbell);

  assert.ok(cachedDoorbell, "the cached accessory carries its doorbell");
  cachedDoorbell.setPrimaryService(true);

  // The plugin and the platform are what Homebridge's cache stamps on an accessory, and what its serialization requires.
  cached._associatedPlugin = PLUGIN_NAME;
  cached._associatedPlatform = PLATFORM_NAME;

  const restored = runtime.PlatformAccessory.deserialize(runtime.PlatformAccessory.serialize(cached)) as TestAccessAccessory;

  assert.ok(restored.getService(Service.Doorbell)?.isPrimaryService, "the restored doorbell carries the marking the earlier run gave it");

  const harness = makeHub({ accessory: restored });

  assert.deepEqual(harness.services.filter(service => service.isPrimaryService), [lockService(harness)],
    "the door's lock is the one primary service, the doorbell's cached marking taken off");
  assert.ok(hasDoorbell(harness), "while the doorbell itself stays");

  // A doorbell created on a hub with no cache behind it is never marked at all.
  const fresh = makeHub();

  assert.deepEqual(fresh.services.filter(service => service.isPrimaryService), [lockService(fresh)], "a fresh hub's door is its one primary service too");
});

/* An accessory restored from the cache can carry the side door's lock ahead of the main door's. A lookup by type alone answers whichever lock comes first, so the
 * main door's reading reaches the main door's lock only through the exact lookup.
 */
test("a UA Gate presented as a lock writes its main door's state to the main door's lock even where the side door's lock comes first", () => {

  /* HAP's own add refuses a service with no subtype beside one of its type, so the order this arm is about is laid out the way the cache reaches it. Homebridge
   * restores a cached accessory through HAP's deserialize, whose sideload sets the accessory's services array to the saved list as it stands, with no add to
   * refuse it. The locks are added here in the order HAP admits, the main door's first, and then swapped inside that same array.
   */
  const accessory = makeTestAccessory("Test Hub", HUB_ID);
  const cachedMain = accessory.addService(new Service.LockMechanism("Test Hub"));
  const cachedSide = accessory.addService(carried(Service.LockMechanism, AccessReservedNames.LOCK_DOOR_SIDE));
  const mainAt = accessory.services.indexOf(cachedMain);
  const sideAt = accessory.services.indexOf(cachedSide);

  accessory.services[mainAt] = cachedSide;
  accessory.services[sideAt] = cachedMain;

  const gate = makeGate({ accessory, options: ["Enable.Hub.Door.Service=Lock"] });
  const mainLock = lockService(gate);
  const sideLock = lockService(gate, AccessReservedNames.LOCK_DOOR_SIDE);

  assert.ok(gate.services.indexOf(sideLock) < gate.services.indexOf(mainLock), "the side door's lock comes first on the accessory");

  /* The writes are read rather than the values they leave behind, because a lock nothing has written reads unsecured by HAP's own default, which is the reading
   * the delivery below carries.
   */
  const lockStates = (writes: { characteristic: string; value: unknown }[]): unknown[] => {

    return writes.filter(write => write.characteristic === Characteristic.LockCurrentState.UUID).map(write => write.value);
  };

  gate.accessory.clearObservations();
  deliverDoorState(gate, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });

  assert.deepEqual(lockStates(writesOn(gate.accessory, mainLock)), [Characteristic.LockCurrentState.UNSECURED],
    "the main door's unlock is written to the main door's lock");
  assert.deepEqual(lockStates(writesOn(gate.accessory, sideLock)), [], "and nothing is written to the side door's");
  assert.equal(sideLock.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED, "which still reads secured");
});

/* The presentation line and the trigger lines each announce a creation, so a gate says each of them once at adoption, and a device update that finds every one
 * of those services standing says none of them again. Both presentations are stood up, because the presentation line names the one the door took.
 */
test("a UA Gate announces its door presentation and its lock triggers once at adoption and never again on a device update, under either presentation", () => {

  for(const { noun, presentation } of [ { noun: "garage door opener", presentation: "GarageDoorOpener" }, { noun: "lock", presentation: "Lock" } ]) {

    const gate = makeGate({ keepAdoptionLines: true,
      options: [ "Enable.Hub.Door.Service=" + presentation, "Enable.Hub.Lock.Trigger", "Enable.Hub.SideDoor.Lock.Trigger" ] });
    const announcements = [ "Presenting the door in HomeKit as a " + noun + ".", "Enabling the lock automation trigger.",
      "Enabling the side door lock automation trigger." ];

    for(const sentence of announcements) {

      assert.equal(lineCount(gate, sentence), 1, "adoption announces this once: " + sentence);
    }

    restateRecord(gate, {});

    for(const sentence of announcements) {

      assert.equal(lineCount(gate, sentence), 1, "and a device update does not announce it again: " + sentence);
    }
  }
});

test("a reader with no access method selected creates no switch and retires one the accessory carried", () => {

  const harness = makeHub({

    existing: [carried(Service.Switch, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC)],
    record: testHub({ capabilities: [ "is_hub", "is_reader", "nfc_card_easy_provision", "pin_code" ],
      configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] })
  });

  // The model seeded from the rows, so the pass ran; with nothing selected it materialized nothing and retired the switch a previous run left.
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_PIN), "no switch is created for a method nobody selected");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "and a switch nobody selects any longer is retired");
});

test("a selection creates exactly the selected switches, at the device's own scope over the global one, in any case the entry spelled them", async () => {

  const record = testHub({ capabilities: [ "is_hub", "is_reader", "nfc_card_easy_provision", "pin_code", "qr_code" ],
    configs: [ { device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }, { device_id: HUB_ID, key: "nfc", tag: "open_door_mode", value: "no" } ] });

  // The global selection names more methods than the device's own, spelled in lower case, and it is the device's that counts.
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

// The wiring rows behind a terminal input's live circuit detection, which is the evidence a sensor is created on.
function wiringRows(pairs: Record<string, string>): AccessDeviceEntryConfig[] {

  return configRows({ deviceId: HUB_ID, entries: pairs, tag: "wiring" });
}

// The rows a hub reports its terminal input readings through, which is what a created sensor answers from.
function inputRows(readings: Record<string, string>): AccessDeviceEntryConfig[] {

  return configRows({ deviceId: HUB_ID, entries: readings, tag: "input" });
}

// Every wiring key a terminal input is detected through on the UA Hub's fixed pairs and a single-port hub's d1-button pair, so an arm can offer a family all of
// that evidence at once.
const EVERY_WIRE = [ "wiring_state_d1-button-neg", "wiring_state_d1-button-pos", "wiring_state_rel-neg", "wiring_state_rel-pos", "wiring_state_ren-neg",
  "wiring_state_ren-pos", "wiring_state_rex-neg", "wiring_state_rex-pos" ];

// Every one of those pairs reporting a live circuit, which is the most a record can say about its terminal inputs.
const EVERY_PAIR_LIVE = wiringRows(Object.fromEntries(EVERY_WIRE.map(key => [ key, "on" ])));

// The remote release pair alone, which is what the arms about one input's own lifecycle vary.
const REL_PAIR_LIVE = wiringRows({ "wiring_state_rel-neg": "on", "wiring_state_rel-pos": "on" });

// The request to exit pair a UA Hub Door Mini reports its one input through.
const D1_PAIR_LIVE = wiringRows({ "wiring_state_d1-button-neg": "on", "wiring_state_d1-button-pos": "on" });

/* Every wiring pair above reporting live, beside a UA Hub's reading rows, stated beside the record so an arm laying other rows next to them takes the same list the
 * record does. It deliberately carries more than a UA Hub reports, the d1-button pair among them, so an arm can hand a family every evidence there is.
 *
 * @param reading - What each input reports.
 *
 * @returns The rows.
 */
function wiredRows(reading: string): AccessDeviceEntryConfig[] {

  return [ ...EVERY_PAIR_LIVE, ...inputRows({ "input_state_rel": reading, "input_state_ren": reading, "input_state_rex": reading }) ];
}

// A UA Hub reporting every terminal input wired, with each input reading whatever the arm names.
function wiredHub(reading: string): AccessStateDevice & { mac: string } {

  return testHub({ configs: wiredRows(reading) });
}

// A UA Hub Door Mini reporting its one terminal input wired, reading whatever the arm names.
function doorMiniHub(reading: string): AccessStateDevice & { mac: string } {

  return testHub({ configs: [ ...D1_PAIR_LIVE, ...inputRows({ "input_d1_button": reading }) ], device_type: "UA-Hub-Door-Mini" });
}

// The port rows a UA Ultra reports its two terminal families through, each reading whatever the arm names, which is what the library keys those families on.
function ultraRows(reading: string): AccessDeviceEntryConfig[] {

  return inputRows({ "input_d1_button": reading, "input_d1_dps": reading });
}

/* A UA Ultra whose one multiplexed terminal input is configured for the mode an arm names, carried in the port setting extension the controller reports it through.
 *
 * @param mode    - What the input is configured for.
 * @param reading - What the port rows report, which is what a sensor built on them answers with.
 *
 * @returns The record.
 */
function ultraRecord(mode: string, reading = "on"): AccessStateDevice & { mac: string } {

  return testHub({ configs: ultraRows(reading), device_type: "UA-ULTRA", extensions: [{ device_id: HUB_ID, extension_name: "port_setting",
    target_config: [{ config_key: "rex_button_mode", config_tag: "", config_value: mode }], target_type: "device", unique_id: "extension-1" }] });
}

/* The rows the field has shown each family reporting about its terminals, so what the library reads for a fixture is what it would read for the hardware. It is
 * distinct from wiredHub, which also carries the d1-button pair a UA Hub never reports: that record is offered so an arm can hand a family every evidence there is,
 * where this one is the family's own report.
 *
 * @param deviceType - The hardware family the record stands for.
 *
 * @returns The record.
 */
function familyRecord(deviceType: string): AccessStateDevice & { mac: string } {

  switch(deviceType) {

    case "UA-Hub-Door-Mini":

      return testHub({ configs: [ ...D1_PAIR_LIVE, ...inputRows({ "input_d1_button": "on" }) ], device_type: deviceType });

    case "UA-ULTRA":

      return ultraRecord("rex");

    case "UAH-Ent":

      return testHub({ configs: [ ...wiringRows({ "wiring_state_d1-button-neg": "on", "wiring_state_d1-button-pos": "on", "wiring_state_d2-button-neg": "on",
        "wiring_state_d2-button-pos": "on" }), ...inputRows({ "input_d1_button": "on", "input_d2_button": "on" }) ], device_type: deviceType });

    case "UGT":

      return testHub({ configs: inputRows({ "input_door_dps": "on", "input_gate_dps": "on" }), device_type: deviceType });

    default:

      // The UA Hub, whose fixed wiring pairs and the rows beside them are the vocabulary every other family here is read against.
      return testHub({ configs: [ ...wiringRows({ "wiring_state_rel-neg": "on", "wiring_state_rel-pos": "on", "wiring_state_ren-neg": "on",
        "wiring_state_ren-pos": "on", "wiring_state_rex-neg": "on", "wiring_state_rex-pos": "on" }),
      ...inputRows({ "input_state_rel": "on", "input_state_ren": "on", "input_state_rex": "on" }) ], device_type: deviceType });
  }
}

// The rows a record carries its tamper reading and its tampering-alert setting through, which is what the tamper arms vary against each other.
function tamperRows(rows: Record<string, string>): AccessDeviceEntryConfig[] {

  return configRows({ deviceId: HUB_ID, entries: rows });
}

/* A UA Ultra whose hardware detects tampering, reporting whatever tamper rows the arm names. The Ultra is a hub family carrying that capability, and its
 * multiplexed terminal input is what gives the record a contact sensor to carry the characteristic at all.
 *
 * @param rows    - The tamper rows the record reports.
 * @param mode    - What the multiplexed terminal input is configured for, which is what decides whether the request to exit sensor exists.
 * @param reading - What the port rows report, which is what that sensor answers with.
 *
 * @returns The record.
 */
function tamperUltra(rows: Record<string, string>, mode = "rex", reading = "on"): AccessStateDevice & { mac: string } {

  return testHub({ capabilities: [ "is_hub", "tamper_proofing" ], configs: [ ...ultraRows(reading), ...tamperRows(rows) ], device_type: "UA-ULTRA",
    extensions: ultraRecord(mode).extensions });
}

// What a hub says when the controller's tampering alert is switched off, spelled once here so every arm counts the sentence a user actually reads.
const TAMPER_WITHDRAWN = "Tampering alerts are turned off on the controller, so the tamper status reads normal until they are turned on again.";

// And what it says when its hardware stops reporting the capability at all, which is the other cause of a status reading normal.
const TAMPER_UNREPORTED = "The device no longer reports tamper detection, so its tamper status is withdrawn until it does.";

// A doorbell-capable reader hanging off this hub, as the client's device snapshot carries it, which is the device a dispatched ring is addressed to.
const READER_RECORD = testHub({ capabilities: [ "is_reader", "remote_view" ], connected_uah_id: HUB_ID, device_type: "UA-G2-PRO", unique_id: READER_ID });

// Every terminal input sensor, which most of the arms below sweep over together.
const TERMINAL_SUBTYPES = [ AccessReservedNames.CONTACT_REL, AccessReservedNames.CONTACT_REN, AccessReservedNames.CONTACT_REX ];

// What each of those sensors says for itself when it is created, in the sentence a user reads.
const TERMINAL_ENABLED = [ "Enabling the remote release.", "Enabling the request to enter sensor.", "Enabling the request to exit sensor." ];

test("a hub creates a terminal input's sensor the moment its wiring reports live, announces it once, and seeds it from the input's own reading", async () => {

  const harness = makeHub();

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(!hasContactSensor(harness, subtype), "a record offering no wiring evidence carries no " + subtype + " to begin with");
  }

  restateRecord(harness, { configs: [ ...EVERY_PAIR_LIVE, ...inputRows({ "input_state_rel": "on", "input_state_ren": "on", "input_state_rex": "on" }) ] });

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(hasContactSensor(harness, subtype), subtype + " is created the moment its wiring reports live");
    assert.equal(contactSensor(harness, subtype).getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_DETECTED, subtype + " is seeded from the reading its record carries");
  }

  const availability = await Promise.all(TERMINAL_SUBTYPES.map(async (subtype): Promise<unknown> => {

    return triggerGet(contactSensor(harness, subtype).getCharacteristic(Characteristic.StatusActive));
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

  // One terminal of a pair is a half-wired sensor, which is not a sensor. The reading rows are carried so the withholding is the pair's own rather than an absent
  // family's.
  const half = makeHub({ record: testHub({ configs: [ ...wiringRows({ "wiring_state_rel-neg": "on", "wiring_state_ren-neg": "on", "wiring_state_rex-neg": "on" }),
    ...inputRows({ "input_state_rel": "on", "input_state_ren": "on", "input_state_rex": "on" }) ] }) });

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(!hasContactSensor(half, subtype), "a UA Hub reporting one terminal of a pair carries no " + subtype);
  }

  /* A UA Gate reports its gate position and its side door position, and an Enterprise hub reports one request to exit per port. Neither reports a terminal input
   * this loop drives: the gate's rows belong to other families altogether, and the Enterprise hub names so many ports that no single family answers for it.
   */
  const gate = makeGate({ record: familyRecord("UGT") });
  const enterprise = makeHub({ record: familyRecord("UAH-Ent") });

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
  const unconfigured = makeHub({ record: testHub({ device_type: "UA-ULTRA" }) });

  assert.ok(hasContactSensor(ultra, AccessReservedNames.CONTACT_REX), "a UA Ultra configured for a request to exit carries that sensor, with no wiring row at all");
  assert.ok(!hasContactSensor(ultra, AccessReservedNames.CONTACT_REL), "and a UA Ultra carries no remote release");
  assert.ok(!hasContactSensor(ultra, AccessReservedNames.CONTACT_REN), "and a UA Ultra carries no request to enter sensor");

  for(const subtype of TERMINAL_SUBTYPES) {

    assert.ok(!hasContactSensor(positioned, subtype), "a UA Ultra configured for a door position sensor carries no " + subtype);
    assert.ok(!hasContactSensor(unconfigured, subtype), "and a UA Ultra reporting no extensions at all carries no " + subtype);
  }

  // The duty is read for the position input the same way, which is the other half of the same evidence: the mode that withholds one input is what offers the other.
  assert.ok(hasContactSensor(positioned, AccessReservedNames.CONTACT_DPS), "the position duty is what makes a UA Ultra's position sensor eligible");
  assert.ok(!hasContactSensor(ultra, AccessReservedNames.CONTACT_DPS), "and the exit-button duty is what withholds it");
});

// Every sensor a hub reporting all of its wiring can carry, which is what an arm about the selection rather than the evidence reads.
const EVERY_SENSOR = [ ...TERMINAL_SUBTYPES, AccessReservedNames.CONTACT_DPS ];

/* A UA Hub reporting every terminal input live with a door state delivered beneath it, which is what gives its position sensor evidence alongside the other three.
 *
 * @param options - Whatever the arm varies, the record included.
 *
 * @returns The harness, with its position evidence already established.
 */
function everySensorHub(options: HubOptions = {}): HubHarness {

  const harness = makeHub({ record: wiredHub("on"), ...options });

  deliverDoorState(harness, { dps: "close", location_id: MAIN_DOOR, lock: "locked" });

  return harness;
}

test("an unconfigured hub selects every sensor and every logged category, whatever model the tables name it as", () => {

  const harness = everySensorHub();

  for(const subtype of EVERY_SENSOR) {

    assert.ok(hasContactSensor(harness, subtype), "a hub nobody has configured carries " + subtype + ", exactly as it did when each sensor was its own option");
  }

  assert.deepEqual([...harness.hub.hints.logEvents], logEventChoices().map(choice => choice.value), "and announces every category the table carries");

  /* The same for a hub whose display model no member of either table names. The narrowing to a model is the settings page's job alone - the hub reads its
   * selection against the WHOLE table - so an Enterprise hub's port keeps everything its wiring supports rather than resolving to nothing at all.
   */
  const unnamed = everySensorHub({ record: testHub({ configs: wiredRows("on"), device_type: "UAH-Ent" }) });

  assert.deepEqual(hubSensorChoices({ capabilities: ["is_hub"], display_model: officialDeviceModel("UAH-Ent") }), [],
    "the settings page offers this model no member at all, which is the reading the hub must not take");

  for(const subtype of EVERY_SENSOR) {

    assert.ok(hasContactSensor(unnamed, subtype), "and the hub itself carries " + subtype + " all the same");
  }

  assert.deepEqual([...unnamed.hub.hints.logEvents], logEventChoices().map(choice => choice.value), "and logs every category too");
});

test("a narrowed sensor list is what decides each sensor, through the gates the wiring evidence runs", () => {

  // The pair that tells the selection apart from the evidence: the same hardware, the same wiring, and one sensor the list names while another it does not.
  const harness = everySensorHub({ options: ["Enable.Hub.Sensors=REL,REN"] });

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "a member the list names is carried");
  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REN), "as is every other member it names");
  assert.ok(!hasContactSensor(harness, AccessReservedNames.CONTACT_REX), "while a member it leaves out is withheld");
  assert.ok(!hasContactSensor(harness, AccessReservedNames.CONTACT_DPS), "the position sensor included, which reads the same list through a gate of its own");
});

test("a hub enabled for the sensor list with nothing named keeps every sensor its wiring supports", () => {

  /* A hand-written enable at a scope carries no selection at all. That means the list is on for this hub and nothing was named, which reads as the registered
   * default - every member - and never as an empty selection that would silently withhold the lot.
   */
  const bare = everySensorHub({ options: ["Enable.Hub.Sensors." + HUB_SERIAL] });

  for(const subtype of EVERY_SENSOR) {

    assert.ok(hasContactSensor(bare, subtype), "a bare enable leaves " + subtype + " exactly where it was");
  }

  // The selection a user emptied on purpose is a different reading, and it still answers empty.
  const emptied = everySensorHub({ options: ["Enable.Hub.Sensors="] });

  for(const subtype of EVERY_SENSOR) {

    assert.ok(!hasContactSensor(emptied, subtype), "while a list emptied on purpose withholds " + subtype);
  }
});

test("a hub whose sensor selection is emptied says so once at adoption and says it no second time on a later update", () => {

  /* An emptied selection is a deviation from the default that nothing else in the log states: no sensor is created, so no per-sensor line is written, and a user
   * who sees a hub carrying nothing has nothing to read about why. The once-at-adoption placement is what the count taken after the update below is about.
   */
  const emptied = makeHub({ keepAdoptionLines: true, options: ["Enable.Hub.Sensors="], record: wiredHub("on") });

  assert.equal(lineCount(emptied, "No sensors enabled."), 1, "a hub carrying no sensor at all says why, once, as it is adopted");

  refreshRecord(emptied, wiredRows("off"));

  assert.equal(lineCount(emptied, "No sensors enabled."), 1,
    "and the re-gate every device update runs says it no second time, which a check reading the selection without the adoption guard would fail");

  const selected = makeHub({ keepAdoptionLines: true, record: wiredHub("on") });

  assert.equal(lineCount(selected, "No sensors enabled."), 0, "while the default selection is not a deviation and is not announced");

  // A device whose model the sensor list offers no member for has nothing to state, whatever the selection reads, because it would carry no sensor either way.
  const reader = makeHub({ keepAdoptionLines: true, options: ["Enable.Hub.Sensors="],
    record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code" ], device_type: "UA-G2-PRO" }) });

  assert.deepEqual(hubSensorChoices({ capabilities: reader.hub.uda.capabilities, display_model: officialDeviceModel(reader.hub.uda.device_type) }), [],
    "the fixture is a model the list offers nothing for, which is what makes the silence below mean something rather than agree by accident");
  assert.equal(lineCount(reader, "No sensors enabled."), 0, "and a device with no sensor to offer says nothing about a selection it could not have filled");
});

test("the logging list is what decides which categories a hub announces", () => {

  const silent = makeHub({ options: ["Disable.Log.Events"] });

  assert.deepEqual([...silent.hub.hints.logEvents], [], "a hub told to log no category at all holds none");

  const locksOnly = makeHub({ options: ["Enable.Log.Events=Lock"] });

  assert.deepEqual([...locksOnly.hub.hints.logEvents], ["Lock"], "and a list naming one category holds exactly that one");

  deliverDoorState(locksOnly, { dps: "close", location_id: MAIN_DOOR, lock: "unlocked" });

  assert.equal(lineCount(locksOnly, "Door unlocked."), 1, "which is the category that still speaks");
});

test("a hub whose logged-category selection is emptied says so once, whichever way the user emptied it", () => {

  const emptied = makeHub({ keepAdoptionLines: true, options: ["Enable.Log.Events="] });

  assert.equal(lineCount(emptied, "No event categories enabled."), 1, "the one read of the list is where a hub announcing nothing says so");

  // Turning the option off altogether reaches the same empty set through the other half of the grammar, and a user who did that has made the same deviation.
  const silenced = makeHub({ keepAdoptionLines: true, options: ["Disable.Log.Events"] });

  assert.equal(lineCount(silenced, "No event categories enabled."), 1, "and the option turned off reads as the same empty selection");

  const selected = makeHub({ keepAdoptionLines: true });

  assert.equal(lineCount(selected, "No event categories enabled."), 0, "while every category being announced is the default and says nothing");
});

test("a hub keeps a terminal input's sensor through a silence about its wiring and retires it only when the user turns the option off", () => {

  const harness = makeHub({ record: testHub({ configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ] }) });

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the pair reporting live is what creates the sensor");

  // The hardware falling silent about the wiring is a window to sit through rather than a removal to act on, so the sensor stays and nothing is said.
  restateRecord(harness, { configs: [] });

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "a record that stops reporting the pair keeps the sensor already standing");
  assert.equal(lineCount(harness, "Disabling the remote release."), 0, "and the hub says nothing about a sensor it kept");

  // The user's own toggle is absolute, and the next update is what carries it into HomeKit.
  harness.reconfigure([listLess("Hub.Sensors", hubSensorChoices(), "REL")]);
  restateRecord(harness, { configs: [] });

  assert.ok(!hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the toggle turned off retires the sensor");
  assert.equal(lineCount(harness, "Disabling the remote release."), 1, "and the retirement is announced exactly once");

  // A hub adopted with the toggle already off never carries the sensor, whatever its wiring reports.
  const disabled = makeHub({ options: [listLess("Hub.Sensors", hubSensorChoices(), "REL")],
    record: testHub({ configs: [ ...EVERY_PAIR_LIVE, ...inputRows({ "input_state_rel": "on", "input_state_ren": "on", "input_state_rex": "on" }) ] }) });

  assert.ok(!hasContactSensor(disabled, AccessReservedNames.CONTACT_REL), "and a hub adopted with the toggle off never carries it");
  assert.ok(hasContactSensor(disabled, AccessReservedNames.CONTACT_REN), "while the inputs the user left alone are untouched by it");
});

test("a hub carries a terminal input's change to the characteristic, the topic, and the log exactly once, and carries a repeat of the same reading nowhere", () => {

  const harness = makeHub({ record: testHub({ configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ] }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REL);

  restateRecord(harness, { configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "off" }) ] });

  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    "the input opening reaches the characteristic");
  assert.equal(lineCount(harness, "Remote release is open."), 1, "and is announced once");

  restateRecord(harness, { configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ] });

  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_DETECTED,
    "the input closing reaches it too");
  assert.equal(lineCount(harness, "Remote release is closed."), 1, "and is announced once");

  // The same reading restated is not a change, so it reaches none of them.
  restateRecord(harness, { configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ] });

  assert.deepEqual(topicPayloads(harness, "rel"), [ "true", "false" ], "each change publishes exactly once, and a repeat publishes nothing");
  assert.equal(lineCount(harness, "Remote release is closed."), 1, "and a repeat is announced no second time");

  // The Door Mini reports the same kind of input through a key of its own, and its readings travel the request to exit surface the same way.
  const mini = makeHub({ record: doorMiniHub("on") });
  const miniSensor = contactSensor(mini, AccessReservedNames.CONTACT_REX);

  restateRecord(mini, { configs: [ ...D1_PAIR_LIVE, ...inputRows({ "input_d1_button": "off" }) ] });

  assert.equal(miniSensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
  assert.equal(lineCount(mini, "Request to exit sensor is open."), 1);

  restateRecord(mini, { configs: [ ...D1_PAIR_LIVE, ...inputRows({ "input_d1_button": "on" }) ] });

  assert.deepEqual(topicPayloads(mini, "rex"), [ "true", "false" ], "the Door Mini's readings reach the request to exit topic");
  assert.equal(lineCount(mini, "Request to exit sensor is closed."), 1);

  // The log option is the user's own, and turning it off silences the sentence without withholding the reading from anything else.
  const quiet = makeHub({ options: [listLess("Log.Events", logEventChoices(), "REL")],
    record: testHub({ configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ] }) });

  restateRecord(quiet, { configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "off" }) ] });

  assert.equal(contactSensor(quiet, AccessReservedNames.CONTACT_REL).getCharacteristic(Characteristic.ContactSensorState).value,
    Characteristic.ContactSensorState.CONTACT_NOT_DETECTED, "the reading still reaches HomeKit");
  assert.deepEqual(topicPayloads(quiet, "rel"), ["true"], "and is still published");
  assert.equal(lineCount(quiet, "Remote release is open."), 0, "while the sentence the user turned off is not written");
});

test("every position and terminal sensor is the subject of its own sentence, named by the one spelling its label is held under", () => {

  const hub = makeHub();

  deliverDoorState(hub, { dps: "open", location_id: MAIN_DOOR, lock: "lock" });

  assert.equal(lineCount(hub, "Door position sensor is open."), 1, "the main door's position sensor opens its line and the reading completes it");

  // The side door's label is spelled in a constant of its own, so a line composing the main door's spelling with a prefix would read wrong here and nowhere else.
  const gate = securedGate({ doorStates: new Map([[ SIDE_DOOR, { dps: "open", location_id: SIDE_DOOR, lock: "lock" } ]]) });

  deliverDoorState(gate, { dps: "close", location_id: SIDE_DOOR, lock: "lock" });

  assert.equal(lineCount(gate, "Side door position sensor is closed."), 1, "and the side door names itself in full");

  const wired = makeHub({ record: testHub({ configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ] }) });

  refreshRecord(wired, [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "off" }) ]);

  assert.equal(lineCount(wired, "Remote release is open."), 1, "while a terminal input reads the label the table holds for it");
});

test("a UA Hub reads each terminal input from its own row, so no input can answer with another's reading", () => {

  /* Every other arm drives a UA Hub's rows to one value together, which cannot tell the rows apart: a table naming the wrong row for an input would answer
   * identically. Here each restate moves exactly one row, so each sensor is read against the rows that did not move.
   */
  const harness = makeHub({ record: wiredHub("off") });
  const readings = (): unknown[] => TERMINAL_SUBTYPES.map(subtype => contactSensor(harness, subtype).getCharacteristic(Characteristic.ContactSensorState).value);
  const closed = Characteristic.ContactSensorState.CONTACT_DETECTED;
  const open = Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;

  refreshRecord(harness, [ ...EVERY_PAIR_LIVE, ...inputRows({ "input_state_rel": "on", "input_state_ren": "off", "input_state_rex": "off" }) ]);

  assert.deepEqual(readings(), [ closed, open, open ], "the remote release row alone reads on, and the remote release alone answers closed");

  refreshRecord(harness, [ ...EVERY_PAIR_LIVE, ...inputRows({ "input_state_rel": "off", "input_state_ren": "on", "input_state_rex": "off" }) ]);

  assert.deepEqual(readings(), [ open, closed, open ], "the request to enter row alone reads on, and only that sensor follows it");

  refreshRecord(harness, [ ...EVERY_PAIR_LIVE, ...inputRows({ "input_state_rel": "off", "input_state_ren": "off", "input_state_rex": "on" }) ]);

  assert.deepEqual(readings(), [ open, open, closed ], "and the request to exit row alone reads on");
});

test("a terminal input whose wiring falls silent keeps its sensor, reads closed, says unknown on its topic, and announces nothing", () => {

  const harness = makeHub({ record: testHub({ configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "off" }) ] }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REL);

  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    "a wired input whose row reads off is open");

  /* The wiring rows go away while the reading row stays exactly where it was. The service survives, because the gate keeps one already standing through a wiring
   * silence, and the reading falls back to the closed default an input carrying no wiring evidence has.
   */
  refreshRecord(harness, inputRows({ "input_state_rel": "off" }));

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the sensor already standing survives the silence");
  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_DETECTED,
    "and an input with no wiring evidence reads closed whatever its row still says");
  assert.deepEqual(topicPayloads(harness, "rel"), ["unknown"], "the closed default is no reading the input made, so the topic says the reading is unknown");
  assert.equal(lineCount(harness, "Remote release is closed."), 0, "and not a change to announce");
});

test("a terminal input whose wiring goes and comes back while its reading stays put says unknown on its topic, and then the reading again", () => {

  const harness = makeHub({ record: testHub({ configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ] }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REL);
  const closed = Characteristic.ContactSensorState.CONTACT_DETECTED;

  /* The input reads closed, which is also the default its sensor holds through a gap in its wiring, so the wiring going moves no characteristic: the evidence is
   * the whole of the change, and it is what the topic has to follow.
   */
  refreshRecord(harness, inputRows({ "input_state_rel": "on" }));

  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, closed, "the sensor holds the closed reading it held before the gap");
  assert.deepEqual(topicPayloads(harness, "rel"), ["unknown"], "while the topic says the reading is unknown once the wiring behind it goes");

  // The wiring comes back onto the same reading, and again the evidence alone moves.
  refreshRecord(harness, [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ]);

  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, closed, "the sensor still holds that reading");
  assert.deepEqual(topicPayloads(harness, "rel"), [ "unknown", "false" ], "and the topic states the reading again once the wiring returns");
  assert.equal(lineCount(harness, "Remote release is closed."), 0, "while nothing announces a reading that never moved");

  // A record restating the same wiring and the same reading moves nothing at all, so the topic hears nothing further.
  refreshRecord(harness, [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ]);

  assert.deepEqual(topicPayloads(harness, "rel"), [ "unknown", "false" ]);
});

/* A UA Gate carrying whatever side door terminal rows an arm names, over a topology of one door. The one-door topology is what keeps the construction seed off the
 * side door: with no side door resolved there is nothing in the door-state map to seed from, so the sensor and the topic answer the terminal read itself, while the
 * user's option leaves the sensor and the topic standing either way.
 *
 * @param rows - The configuration rows the record carries.
 *
 * @returns The gate.
 */
function sideDoorGate(rows: AccessDeviceEntryConfig[]): HubHarness {

  return makeGate({ doors: [{ name: "Main Gate", unique_id: MAIN_DOOR }], record: testHub({ configs: rows, device_type: "UGT" }) });
}

test("a UA Gate reads its side door position from the library's terminal read, and its topic answers unknown where nothing is wired", async () => {

  const opened = sideDoorGate([ ...wiringRows({ "wiring_state_door-dps-neg": "on", "wiring_state_door-dps-pos": "on" }),
    ...inputRows({ "input_door_dps": "off" }) ]);

  assert.equal(contactSensor(opened, AccessReservedNames.CONTACT_DPS_SIDE).getCharacteristic(Characteristic.ContactSensorState).value,
    Characteristic.ContactSensorState.CONTACT_NOT_DETECTED, "a terminal in service whose row reads off is an open contact");
  assert.equal(await opened.mqttGet("sidedoor/dps"), "true", "and the topic carries that reading");

  // A gate reporting nothing about the terminal reads closed, and its topic says the reading is not established rather than answering the default as a reading.
  const silent = sideDoorGate([]);

  assert.equal(contactSensor(silent, AccessReservedNames.CONTACT_DPS_SIDE).getCharacteristic(Characteristic.ContactSensorState).value,
    Characteristic.ContactSensorState.CONTACT_DETECTED, "a terminal nothing is wired to renders closed");
  assert.equal(await silent.mqttGet("sidedoor/dps"), "unknown", "and answers unknown on its topic");

  // The same pair behind a row reading on is the other direction of the same read.
  const closed = sideDoorGate([ ...wiringRows({ "wiring_state_door-dps-neg": "on", "wiring_state_door-dps-pos": "on" }),
    ...inputRows({ "input_door_dps": "on" }) ]);

  assert.equal(await closed.mqttGet("sidedoor/dps"), "false", "a terminal in service whose row reads on is a closed contact");

  /* One half of the pair is no pair, and a gate has no duty selector to fall back on, so the row beside it is a reading nothing qualified. This is the REL, REN,
   * and REX loop's half-wired fixture on the one path that does not go through it.
   */
  const halfWired = sideDoorGate([ ...wiringRows({ "wiring_state_door-dps-neg": "on" }), ...inputRows({ "input_door_dps": "off" }) ]);

  assert.equal(contactSensor(halfWired, AccessReservedNames.CONTACT_DPS_SIDE).getCharacteristic(Characteristic.ContactSensorState).value,
    Characteristic.ContactSensorState.CONTACT_DETECTED, "a half-wired terminal renders closed whatever its row says");
  assert.equal(await halfWired.mqttGet("sidedoor/dps"), "unknown", "and answers unknown for the same reason");
});

test("the door's position and a UA Gate's side door position say unknown while their evidence is gone, and their reading again once it returns", () => {

  /* The door reads closed, and a door-state entry saying nothing is wired renders closed as well, so the evidence going and coming back moves no reading: the
   * door-state delivery is what has to state the topic, since the position evidence arrives on that rail.
   */
  const hub = makeHub({ doorState: { dps: "close", location_id: MAIN_DOOR, lock: "lock" } });

  deliverDoorState(hub, { dps: "none", location_id: MAIN_DOOR, lock: "lock" });

  assert.ok(hasContactSensor(hub, AccessReservedNames.CONTACT_DPS), "the position sensor outlives the gap in its evidence");
  assert.deepEqual(topicPayloads(hub, "dps"), ["unknown"], "and its topic says the position is unknown once nothing reports it");

  deliverDoorState(hub, { dps: "close", location_id: MAIN_DOOR, lock: "lock" });

  assert.deepEqual(topicPayloads(hub, "dps"), [ "unknown", "false" ], "and states the closed reading again once the position is reported");

  // The side door's evidence is its terminal's wiring, which arrives on the device update rather than the door-state delivery, on a reading that stays closed.
  const sidePair = wiringRows({ "wiring_state_door-dps-neg": "on", "wiring_state_door-dps-pos": "on" });
  const gate = sideDoorGate([ ...sidePair, ...inputRows({ "input_door_dps": "on" }) ]);

  refreshRecord(gate, inputRows({ "input_door_dps": "on" }));

  assert.deepEqual(topicPayloads(gate, "sidedoor/dps"), ["unknown"], "the side door's topic says unknown once its terminal stops reporting wired");

  refreshRecord(gate, [ ...sidePair, ...inputRows({ "input_door_dps": "on" }) ]);

  assert.deepEqual(topicPayloads(gate, "sidedoor/dps"), [ "unknown", "false" ], "and the closed reading again once it reports wired");
});

test("a hub's wiring table and the option catalog's model lists agree about which family drives which terminal input", () => {

  const families = [ "UAH", "UA-Hub-Door-Mini", "UA-ULTRA", "UGT" ];
  const inputs = [ { name: "REL", subtype: AccessReservedNames.CONTACT_REL }, { name: "REN", subtype: AccessReservedNames.CONTACT_REN },
    { name: "REX", subtype: AccessReservedNames.CONTACT_REX } ];

  /* The sensor table and the wiring table state model support in different vocabularies - the sensor table names display models and the wiring table names device
   * types - so the plugin's own resolver is what puts them on one footing. Reading the table the settings page narrows its list with is what makes this an
   * agreement rather than a copy.
   *
   * The Enterprise hub is left out: its display model names no member of the sensor table, so the page offers it nothing and there is no statement to agree with.
   * What it carries at runtime is the arm "an unconfigured hub selects every sensor and every logged category, whatever model the tables name it as", which reads
   * an Enterprise port's wiring alone.
   */
  for(const deviceType of families) {

    const harness = makeHub({ record: familyRecord(deviceType) });
    const offered = hubSensorChoices({ capabilities: ["is_hub"], display_model: officialDeviceModel(deviceType) }).map(choice => choice.value);

    for(const { name, subtype } of inputs) {

      assert.equal(hasContactSensor(harness, subtype), offered.includes(name), "the " + name + " sensor on a " + deviceType + " follows the sensor table's own " +
        "model list");
    }
  }
});

test("a tamper-capable hub dresses its sensors from the reading it adopted and publishes nothing for that adoption", () => {

  const harness = makeHub({ record: tamperUltra({ "tamper_event": "true" }) });

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REX), "the Ultra's multiplexed input is what gives this hub a sensor to carry the reading");

  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  // Presence is read through testCharacteristic because getCharacteristic adds an optional characteristic a service does not carry, so a read through it
  // could never fail.
  assert.ok(sensor.testCharacteristic(Characteristic.StatusTampered), "a contact sensor of tamper-capable hardware carries the tamper characteristic");
  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED,
    "and is dressed from the raised reading the record arrived with, which an implementation dressing normal whatever the record said would fail");
  assert.deepEqual(topicPayloads(harness, "tamper"), [], "and an adoption is nothing anybody observed changing, so it publishes nothing");
});

test("a tamper-capable hub carries a raise to the characteristic, the warning, and the topic exactly once, and carries a restated raise nowhere", () => {

  const harness = makeHub({ record: tamperUltra({ "tamper_event": "false" }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  refreshRecord(harness, tamperRows({ "tamper_event": "true" }));

  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED,
    "the raise reaches the characteristic through the sweep alone, which an implementation writing nothing would fail by leaving it normal");
  assert.equal(lineCount(harness, "Tampering detected."), 1, "and is warned exactly once");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["true"], "and published exactly once");

  // The same reading restated is not a change, so it reaches none of them.
  refreshRecord(harness, tamperRows({ "tamper_event": "true" }));

  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED,
    "a restated raise leaves the characteristic where it stands");
  assert.equal(lineCount(harness, "Tampering detected."), 1, "warns no second time");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["true"], "and publishes no second payload");
});

test("a delivery that changes nothing writes nothing to a sensor the hub already holds, and a change reaches it through one write", () => {

  const harness = makeHub({ record: tamperUltra({ "tamper_event": "false" }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  harness.accessory.clearObservations();
  refreshRecord(harness, tamperRows({ "tamper_event": "false" }));

  assert.deepEqual(writesOn(harness.accessory, sensor), [], "a restated record is not a change, so a sensor the hub already holds is written nowhere");

  refreshRecord(harness, tamperRows({ "tamper_event": "true" }));

  assert.deepEqual(writesOn(harness.accessory, sensor), [{ characteristic: Characteristic.StatusTampered.UUID, value: Characteristic.StatusTampered.TAMPERED }],
    "and a raise reaches it through the sweep's one write, which a configure path that re-dressed every sensor on each delivery would fail by writing three more");
});

test("a tamper-capable hub carries a clear to the characteristic, the note, and the topic exactly once, and carries a restated clear nowhere", () => {

  const harness = makeHub({ record: tamperUltra({ "tamper_event": "true" }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  refreshRecord(harness, tamperRows({ "tamper_event": "false" }));

  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.NOT_TAMPERED, "the clear reaches the characteristic");
  assert.equal(lineCount(harness, "Tampering no longer detected."), 1, "and is noted exactly once");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["false"], "and published exactly once");

  refreshRecord(harness, tamperRows({ "tamper_event": "false" }));

  assert.equal(lineCount(harness, "Tampering no longer detected."), 1, "a restated clear is noted no second time");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["false"], "and publishes no second payload");
});

test("a reading the library withdraws clears the status, says why once, publishes unknown, and re-adopts on the log in silence while the topic says so", () => {

  const harness = makeHub({ record: tamperUltra({ "tamper_event": "true" }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  /* The alert switched off with the input row deliberately left raised: the hardware has stopped revising that row, so what it holds is a stale reading rather
   * than a quiet one, and an implementation reading the input row on its own would leave the status raised here.
   */
  refreshRecord(harness, tamperRows({ "tamper_event": "true", "tampering": "false" }));

  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.NOT_TAMPERED, "the withdrawn reading clears the status");
  assert.equal(lineCount(harness, TAMPER_WITHDRAWN), 1, "and says why exactly once");
  assert.equal(lineCount(harness, "Tampering no longer detected."), 0, "and is not announced as a clear, which is what tells a withdrawal from a quiet reading");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["unknown"], "and the topic says the reading is no longer established");

  // The verdict is forgotten along with the reading, so the same rows restated are not a change to say or publish a second time.
  refreshRecord(harness, tamperRows({ "tamper_event": "true", "tampering": "false" }));

  assert.equal(lineCount(harness, TAMPER_WITHDRAWN), 1, "a restated withdrawal says nothing further");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["unknown"], "and publishes nothing further");

  // The alert coming back on is a reading arriving over none, which is adopted on the log in silence and said on the topic.
  refreshRecord(harness, tamperRows({ "tamper_event": "true", "tampering": "true" }));

  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED, "the reading returning raises the status again");
  assert.equal(lineCount(harness, "Tampering detected."), 0,
    "and is not warned, which an implementation that kept the held verdict through the withdrawal would fail by warning here");
  assert.deepEqual(topicPayloads(harness, "tamper"), [ "unknown", "true" ], "while the topic tells a subscriber holding unknown that the reading came back");
});

test("a reading withdrawn from a quiet one still says why and publishes unknown, without moving the status it leaves normal", () => {

  const harness = makeHub({ record: tamperUltra({ "tamper_event": "false" }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  refreshRecord(harness, tamperRows({ "tamper_event": "false", "tampering": "false" }));

  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.NOT_TAMPERED,
    "the status stands where it stood, which is the control that the setting is what moved rather than the condition");
  assert.equal(lineCount(harness, TAMPER_WITHDRAWN), 1, "the setting changing is worth saying once even where the status did not move");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["unknown"], "and the topic says the reading is no longer established");
});

test("a hub whose hardware cannot detect tampering carries the characteristic on no sensor, announces nothing, and publishes nothing", () => {

  const harness = makeHub({ record: testHub({ configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }),
    ...tamperRows({ "tamper_event": "true" }) ] }) });

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the wired pair is what gives this hub a sensor at all");

  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REL);

  assert.ok(!sensor.testCharacteristic(Characteristic.StatusTampered), "hardware without the capability carries the characteristic nowhere, whatever its rows say");
  assert.deepEqual(topicPayloads(harness, "tamper"), [], "and publishes nothing for a reading it does not project");

  refreshRecord(harness, [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }), ...tamperRows({ "tamper_event": "false" }) ]);

  assert.ok(!sensor.testCharacteristic(Characteristic.StatusTampered), "a reading changing on such hardware still reaches no characteristic");
  assert.equal(lineCount(harness, "Tampering detected."), 0, "and neither sentence is written for it");
  assert.equal(lineCount(harness, "Tampering no longer detected."), 0);
  assert.deepEqual(topicPayloads(harness, "tamper"), [], "and nothing is published for it");
});

test("a sensor of tamper-capable hardware carries the characteristic from creation, and a first reading over none is written, published, and not announced", () => {

  const harness = makeHub({ record: tamperUltra({}) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  assert.ok(sensor.testCharacteristic(Characteristic.StatusTampered),
    "a sensor created with nothing established carries the characteristic, which a design leaving it bare until a verdict is held would fail");
  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.NOT_TAMPERED,
    "and reads normal until a verdict says otherwise");

  refreshRecord(harness, tamperRows({ "tamper_event": "true" }));

  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED,
    "the first reading to arrive reaches the sensor on that same delivery");
  assert.equal(lineCount(harness, "Tampering detected."), 0, "a reading seen for the first time is not one anybody observed changing, so it is not warned");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["true"], "while the topic carries every change of the held verdict, an adoption included");
});

test("a sensor the accessory arrived carrying is dressed at adoption from what the hub holds, and refuses availability and its tamper status once the " +
  "device cannot be reached", async () => {

  const restored = carried(Service.ContactSensor, AccessReservedNames.CONTACT_REX);

  /* What a previous run left in the accessory cache: a reading, a raised tamper status, and an availability, every one of them stale. The record below reads open
   * and establishes no tamper reading, so a carried sensor written closed and raised is what tells a dressing that ran from one that skipped the sensor it found.
   */
  restored.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED);
  restored.updateCharacteristic(Characteristic.StatusTampered, Characteristic.StatusTampered.TAMPERED);
  restored.updateCharacteristic(Characteristic.StatusActive, false);

  const harness = makeHub({ existing: [restored], record: tamperUltra({}, "rex", "off") });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);
  const carriers = harness.services.filter(service => (service.UUID === Service.ContactSensor.UUID) && (service.subtype === AccessReservedNames.CONTACT_REX));

  assert.equal(sensor, restored, "the hub acquires the sensor the accessory arrived carrying");
  assert.equal(carriers.length, 1, "and carries exactly one under that subtype rather than creating a second beside it");
  assert.equal(sensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    "the reading the record carries replaces the stale one");
  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.NOT_TAMPERED,
    "nothing established renders normal, which a dressing that skipped the sensor it found would fail by leaving it raised");
  assert.equal(await triggerGet(sensor.getCharacteristic(Characteristic.StatusActive)), true,
    "the handler is registered on a sensor the hub never created, which a creation-only dressing would fail by answering the cached false");
  assert.strictEqual(await triggerGet(sensor.getCharacteristic(Characteristic.StatusTampered)), Characteristic.StatusTampered.NOT_TAMPERED,
    "and its tamper status is answered by the handler registered on that same sensor");

  harness.health.isHealthy = false;

  await assert.rejects(triggerGet(sensor.getCharacteristic(Characteristic.StatusActive)), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
    "and a read once the connection moved is refused rather than answered from what was last written");
  await assert.rejects(triggerGet(sensor.getCharacteristic(Characteristic.StatusTampered)), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
    "and so is its tamper status");
  assert.deepEqual(topicPayloads(harness, "tamper"), [], "while an adoption publishes nothing");
});

test("a tamper capability appearing mid-run dresses every standing sensor once, from the verdict the delivery brings", () => {

  const harness = makeHub({ record: wiredHub("on") });
  const sensors = TERMINAL_SUBTYPES.map(subtype => contactSensor(harness, subtype));

  harness.accessory.clearObservations();

  for(const sensor of sensors) {

    assert.ok(!sensor.testCharacteristic(Characteristic.StatusTampered), "hardware reporting no capability carries the characteristic on no sensor");
  }

  restateRecord(harness, { capabilities: [ "is_hub", "tamper_proofing" ], configs: [ ...wiredRows("on"), ...tamperRows({ "tamper_event": "true" }) ] });

  for(const sensor of sensors) {

    assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED,
      "the capability arriving reaches every sensor already standing, reading the verdict that same delivery established");
    assert.deepEqual(writesOn(harness.accessory, sensor).filter(write => write.characteristic === Characteristic.StatusTampered.UUID),
      [{ characteristic: Characteristic.StatusTampered.UUID, value: Characteristic.StatusTampered.TAMPERED }],
      "written exactly once, which a pass run ahead of the projection would fail by writing normal and then the verdict over it");
  }

  assert.deepEqual(topicPayloads(harness, "tamper"), ["true"], "the topic carries the verdict the projection adopted");
  assert.equal(lineCount(harness, "Tampering detected."), 0, "and a reading seen for the first time is not announced");
});

test("a tamper capability appearing while alerts are off dresses every standing sensor as not tampered", () => {

  const harness = makeHub({ record: wiredHub("on") });
  const sensors = TERMINAL_SUBTYPES.map(subtype => contactSensor(harness, subtype));

  harness.accessory.clearObservations();

  restateRecord(harness, { capabilities: [ "is_hub", "tamper_proofing" ], configs: wiredRows("on") });

  for(const sensor of sensors) {

    assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.NOT_TAMPERED,
      "a capability arriving with no reading behind it still puts the characteristic on the sensor, reading normal");
    assert.deepEqual(writesOn(harness.accessory, sensor).filter(write => write.characteristic === Characteristic.StatusTampered.UUID),
      [{ characteristic: Characteristic.StatusTampered.UUID, value: Characteristic.StatusTampered.NOT_TAMPERED }],
      "written once, which dropping the write the attach earns would fail by leaving the characteristic bare");
  }

  assert.deepEqual(topicPayloads(harness, "tamper"), [], "the verdict did not move, so the projection publishes nothing");
  assert.deepEqual(harness.lines, [], "and says nothing");
});

test("a tamper capability withdrawn mid-run takes the characteristic off every sensor without writing it, takes the topic silent with it, says why once, " +
  "and a return is adopted in silence and heard on the topic", () => {

  const harness = makeHub({ record: testHub({ capabilities: [ "is_hub", "tamper_proofing" ],
    configs: [ ...wiredRows("on"), ...tamperRows({ "tamper_event": "true" }) ] }) });
  const sensors = TERMINAL_SUBTYPES.map(subtype => contactSensor(harness, subtype));

  harness.accessory.clearObservations();

  for(const sensor of sensors) {

    assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED,
      "adoption dresses every sensor from the reading the record arrived with");
  }

  assert.equal(lineCount(harness, "Tampering detected."), 0, "and says nothing about it, adoption being silent");

  // The rows stand; the capability alone is gone, which is what tells hardware that stopped reporting from a reading that changed.
  restateRecord(harness, { capabilities: ["is_hub"] });

  for(const sensor of sensors) {

    assert.ok(!sensor.testCharacteristic(Characteristic.StatusTampered), "the capability going takes the characteristic off every sensor");
    assert.deepEqual(writesOn(harness.accessory, sensor).filter(write => write.characteristic === Characteristic.StatusTampered.UUID), [],
      "and nothing is written to a characteristic the pass is about to remove, which a sweep run without its capability guard would fail");
  }

  assert.deepEqual(topicPayloads(harness, "tamper"), [], "no sensor carries the characteristic once the pass is done, so the topic has no control to describe");
  assert.equal(lineCount(harness, TAMPER_UNREPORTED), 1, "the withdrawal is said once, as the withdrawal it is");
  assert.equal(lineCount(harness, TAMPER_WITHDRAWN), 0, "rather than as the controller's alert being switched off");

  restateRecord(harness, { capabilities: [ "is_hub", "tamper_proofing" ] });

  for(const sensor of sensors) {

    assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED,
      "the capability returning puts the characteristic back, reading what the record still reports");
    assert.deepEqual(writesOn(harness.accessory, sensor).filter(write => write.characteristic === Characteristic.StatusTampered.UUID),
      [{ characteristic: Characteristic.StatusTampered.UUID, value: Characteristic.StatusTampered.TAMPERED }], "written exactly once for the return");
  }

  assert.deepEqual(topicPayloads(harness, "tamper"), ["true"],
    "and the reading is published as the first sighting a forgotten verdict makes it, once the pass has put the characteristic back");
  assert.equal(lineCount(harness, "Tampering detected."), 0, "rather than announced");
});

test("a sensor the accessory arrived carrying loses its tamper characteristic at adoption when the hardware reports no capability", () => {

  // The cache of a run on hardware that reported the capability: a raised status with nothing behind it any more.
  const restored = carried(Service.ContactSensor, AccessReservedNames.CONTACT_REL);

  restored.updateCharacteristic(Characteristic.StatusTampered, Characteristic.StatusTampered.TAMPERED);

  const harness = makeHub({ existing: [restored], record: testHub({ configs: [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ] }) });

  assert.equal(contactSensor(harness, AccessReservedNames.CONTACT_REL), restored, "the hub acquires the sensor the accessory arrived carrying");
  assert.ok(!restored.testCharacteristic(Characteristic.StatusTampered),
    "and takes the characteristic off it, hardware reporting no capability having nothing to say through it");
  assert.deepEqual(topicPayloads(harness, "tamper"), [], "a cached characteristic is not a held verdict, so nothing is published for its going");
  assert.equal(lineCount(harness, TAMPER_UNREPORTED), 0, "and nothing is said about it");
});

test("the side door position sensor announces its creation at adoption and its retirement when the option turns it off", () => {

  const created = makeGate({ keepAdoptionLines: true });

  assert.equal(lineCount(created, "Enabling the side door position sensor."), 1, "a gate discovering its side door says so once as it creates the sensor");
  assert.ok(hasContactSensor(created, AccessReservedNames.CONTACT_DPS_SIDE), "and the sensor it announced is the one it carries");
  assert.deepEqual(created.lines.filter(line => line.includes("The gate's")), [], "the construction pass says nothing about door identities");

  const retired = makeGate({ existing: [carried(Service.ContactSensor, AccessReservedNames.CONTACT_DPS_SIDE)], keepAdoptionLines: true,
    options: [listLess("Hub.Sensors", hubSensorChoices(), "SideDoorDPS")] });

  assert.equal(lineCount(retired, "Disabling the side door position sensor."), 1, "a sensor the user turned off is said to be going once as it goes");
  assert.ok(!hasContactSensor(retired, AccessReservedNames.CONTACT_DPS_SIDE), "and the accessory does not carry it");

  const plain = makeGate();

  assert.equal(lineCount(plain, "Enabling the side door position sensor."), 0,
    "a harness that clears construction's lines keeps none of them, which is what tells the option apart from a clear that stopped running");
});

test("the side door position sensor retires on the next update once the user turns its selection off under a running gate", () => {

  const harness = makeGate();

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_DPS_SIDE), "the gate carries the sensor before its selection moves");

  // The selection is read at every configure pass, so the next update is what carries the user's choice into HomeKit.
  harness.reconfigure([listLess("Hub.Sensors", hubSensorChoices(), "SideDoorDPS")]);
  restateRecord(harness, {});

  assert.ok(!hasContactSensor(harness, AccessReservedNames.CONTACT_DPS_SIDE), "the selection turned off retires the sensor on the next update");
  assert.equal(lineCount(harness, "Disabling the side door position sensor."), 1, "and the retirement is announced exactly once");

  // A later update finds no sensor left to retire.
  restateRecord(harness, {});

  assert.equal(lineCount(harness, "Disabling the side door position sensor."), 1, "and an update after it has nothing left to announce");
});

test("a hub constructed while the tampering alert is off reads normal, and the alert returning is published and not announced", () => {

  const harness = makeHub({ record: tamperUltra({ "tamper_event": "true", "tampering": "false" }) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  assert.ok(sensor.testCharacteristic(Characteristic.StatusTampered), "the hardware detects tampering, so its sensor carries the characteristic from creation");
  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.NOT_TAMPERED,
    "and reads normal, which an ungated reading of the stale input row would fail by reading raised");
  assert.deepEqual(topicPayloads(harness, "tamper"), [], "and an adoption publishes nothing");

  refreshRecord(harness, tamperRows({ "tamper_event": "true", "tampering": "true" }));

  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED,
    "the alert coming back on establishes the reading");
  assert.equal(lineCount(harness, "Tampering detected."), 0, "which is a first sighting rather than a transition, so it is not warned");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["true"], "while the topic says it, so a subscriber holding unknown hears the reading return");
});

test("a first reading over none that reports no tampering is published and not announced", () => {

  const harness = makeHub({ record: tamperUltra({}) });
  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  refreshRecord(harness, tamperRows({ "tamper_event": "false" }));

  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.NOT_TAMPERED,
    "the status stands where it stood, which is the control that a reading rather than a condition is what arrived");
  assert.equal(lineCount(harness, "Tampering no longer detected."), 0,
    "the silence follows from nothing having been held rather than from the reading being quiet, which an implementation gating on its truth would fail");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["false"], "while the topic carries a quiet first sighting the way it carries every other change");
});

test("a sensor the re-gate creates on the delivery that changes the verdict reads that verdict", () => {

  const harness = makeHub({ record: tamperUltra({ "tamper_event": "false" }, "dps") });

  assert.ok(!hasContactSensor(harness, AccessReservedNames.CONTACT_REX), "an Ultra multiplexed onto its position sensor carries no request to exit sensor yet");

  // One delivery carries both the input mode that creates the sensor and the reading that raises the verdict, so the two land together rather than in sequence.
  restateRecord(harness, { configs: [ ...ultraRows("on"), ...tamperRows({ "tamper_event": "true" }) ], extensions: ultraRecord("rex").extensions });

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REX), "the input mode changing is what creates the sensor on this delivery");

  const sensor = contactSensor(harness, AccessReservedNames.CONTACT_REX);

  assert.ok(sensor.testCharacteristic(Characteristic.StatusTampered), "the sensor carries the characteristic from its creation");
  assert.equal(sensor.getCharacteristic(Characteristic.StatusTampered).value, Characteristic.StatusTampered.TAMPERED,
    "and reads the verdict this delivery established, which a sensor dressed from the verdict held before it and never swept would fail");
  assert.equal(lineCount(harness, "Tampering detected."), 1, "the raise is warned exactly once");
  assert.deepEqual(topicPayloads(harness, "tamper"), ["true"], "and published exactly once");
});

test("a hub delivers a doorbell ring to HomeKit, its trigger switch, the topic, and the log, and delivers a ring that is not its own nowhere", async () => {

  const harness = makeHub({ options: ["Enable.Hub.Doorbell.Trigger"] });
  const press = doorbellService(harness).getCharacteristic(Characteristic.ProgrammableSwitchEvent);
  const trigger = switchService(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  harness.accessory.clearObservations();

  assert.deepEqual(eventsFrom(harness.accessory, press), [], "nothing is delivered before a ring arrives");

  harness.emit("access.remote_view", ringPacket([]));

  assert.deepEqual(eventsFrom(harness.accessory, press), [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS], "the ring reaches HomeKit as a single press");
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "the trigger switch mirrors the ring");
  assert.equal(await triggerGet(trigger.getCharacteristic(Characteristic.On)), true, "and answers a read from the ring the hub is holding");
  assert.deepEqual(topicPayloads(harness, "doorbell"), ["true"], "the ring is published");
  assert.equal(lineCount(harness, "Doorbell ring detected."), 1, "and announced once");

  // A ring the controller attributed to another hub is not this hub's to answer.
  const foreign = makeHub({ options: ["Enable.Hub.Doorbell.Trigger"] });
  const foreignPress = doorbellService(foreign).getCharacteristic(Characteristic.ProgrammableSwitchEvent);

  foreign.accessory.clearObservations();

  foreign.emit("access.remote_view", { data: { channel: "ring", connected_uah_id: "another-hub", device_id: READER_ID, door_guard_ids: [], request_id: "ring-9" },
    event: "access.remote_view" });

  assert.deepEqual(eventsFrom(foreign.accessory, foreignPress), [], "a ring naming another hub reaches HomeKit nowhere");
  assert.equal(switchService(foreign, AccessReservedNames.SWITCH_DOORBELL_TRIGGER).getCharacteristic(Characteristic.On).value, false,
    "and moves no trigger switch");
  assert.deepEqual(topicPayloads(foreign, "doorbell"), [], "and publishes nothing");
  assert.equal(lineCount(foreign, "Doorbell ring detected."), 0, "and says nothing");

  // Hardware with no doorbell has no ring to answer, whatever the wire says.
  const mute = makeHub({ record: testHub({ capabilities: ["is_hub"] }) });

  mute.emit("access.remote_view", ringPacket([]));

  assert.ok(!hasDoorbell(mute), "a hub reporting no doorbell hardware carries no doorbell");
  assert.deepEqual(topicPayloads(mute, "doorbell"), [], "and publishes nothing for a ring addressed to it");
  assert.equal(lineCount(mute, "Doorbell ring detected."), 0, "and says nothing");

  // The user's own toggles govern each surface separately: the doorbell can be withheld, and the trigger switch is offered rather than assumed.
  assert.ok(!hasDoorbell(makeHub({ options: ["Disable.Hub.Doorbell"] })), "a hub told to carry no doorbell carries none");

  const untriggered = makeHub();
  const untriggeredPress = doorbellService(untriggered).getCharacteristic(Characteristic.ProgrammableSwitchEvent);

  untriggered.accessory.clearObservations();

  assert.ok(!hasSwitch(untriggered, AccessReservedNames.SWITCH_DOORBELL_TRIGGER), "the trigger switch is off by default");

  untriggered.emit("access.remote_view", ringPacket([]));

  assert.deepEqual(eventsFrom(untriggered.accessory, untriggeredPress), [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS],
    "and a ring still reaches HomeKit without one");
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

test("the doorbell trigger switch rings and cancels through the official API and settles back onto the ring the controller reports", async () => {

  const harness = makeHub({ devices: [READER_RECORD], official: true, options: ["Enable.Hub.Doorbell.Trigger"] });
  const trigger = harness.services.find(service => service.subtype === AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  assert.ok(trigger, "the hub should have configured the doorbell trigger switch");

  await triggerSet(trigger.getCharacteristic(Characteristic.On), true);

  assert.deepEqual(harness.rings, [{ cancel: false, readerId: READER_ID }], "a write while the doorbell is quiet rings the reader that carries the call surface");

  // A dispatched ring earns the longer window, so the pause a refused write settles in passes without moving the switch.
  harness.clock.advance(REVERT_DELAY_MS);

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "the switch stands while the controller still has time to confirm");

  harness.clock.advance(DOORBELL_RECONCILE_DELAY_MS - REVERT_DELAY_MS);

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false, "and settles back onto ring truth when no ring ever arrived");

  // A ring arriving inside that window is what the wake finds, so the switch stays where the dispatch put it.
  const confirmed = makeHub({ devices: [READER_RECORD], official: true, options: ["Enable.Hub.Doorbell.Trigger"] });
  const confirmedTrigger = switchService(confirmed, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  await triggerSet(confirmedTrigger.getCharacteristic(Characteristic.On), true);
  confirmed.emit("access.remote_view", ringPacket([]));
  confirmed.clock.advance(DOORBELL_RECONCILE_DELAY_MS);

  assert.equal(confirmedTrigger.getCharacteristic(Characteristic.On).value, true, "the ring the controller confirmed is what the switch settles onto");

  await triggerSet(confirmedTrigger.getCharacteristic(Characteristic.On), false);

  assert.deepEqual(confirmed.rings, [ { cancel: false, readerId: READER_ID }, { cancel: true, readerId: READER_ID } ],
    "and a write against a live ring cancels it through the same reader");

  // A write that agrees with the mirror asks for what is already true, which is nothing to dispatch and nothing to complain about.
  const agreeing = makeHub({ devices: [READER_RECORD], official: true, options: ["Enable.Hub.Doorbell.Trigger"] });

  await triggerSet(switchService(agreeing, AccessReservedNames.SWITCH_DOORBELL_TRIGGER).getCharacteristic(Characteristic.On), false);

  assert.deepEqual(agreeing.rings, [], "a write agreeing with the mirror dispatches nothing");
  assert.deepEqual(agreeing.errors, [], "and is not an error the user has to read");

  // The endpoint addresses a reader rather than the hub, so a hub with none attached has nowhere to send the ring.
  const unattached = makeHub({ official: true, options: ["Enable.Hub.Doorbell.Trigger"] });
  const unattachedTrigger = switchService(unattached, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  await triggerSet(unattachedTrigger.getCharacteristic(Characteristic.On), true);

  assert.deepEqual(unattached.rings, [], "a hub with no doorbell-capable reader dispatches nothing");
  assert.deepEqual(unattached.errors, [LOG_PREFIX + "Unable to ring the doorbell: no doorbell-capable reader is connected to this hub."]);

  unattached.clock.advance(REVERT_DELAY_MS);

  assert.equal(unattachedTrigger.getCharacteristic(Characteristic.On).value, false, "and the switch is put back on the shorter pause");

  // Without an official path the switch reflects ring events and drives nothing, which is what the user is told rather than left to discover.
  const tokenless = makeHub({ options: ["Enable.Hub.Doorbell.Trigger"] });
  const tokenlessTrigger = switchService(tokenless, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  await triggerSet(tokenlessTrigger.getCharacteristic(Characteristic.On), true);

  assert.deepEqual(tokenless.rings, [], "a hub with no official path dispatches nothing");
  assert.deepEqual(tokenless.errors, [LOG_PREFIX + "Ringing the doorbell requires the official Access API, which needs an API token to be configured."]);

  tokenless.clock.advance(REVERT_DELAY_MS);

  assert.equal(tokenlessTrigger.getCharacteristic(Characteristic.On).value, false, "and the switch is put back where the mirror stands");
});

test("a doorbell ring the controller refuses says so and puts the switch back on the shorter pause", async () => {

  const harness = makeHub({ devices: [READER_RECORD], official: true, options: ["Enable.Hub.Doorbell.Trigger"],
    ringRefusal: new Error("The controller refused the ring.") });
  const trigger = switchService(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  await triggerSet(trigger.getCharacteristic(Characteristic.On), true);

  assert.deepEqual(harness.rings, [{ cancel: false, readerId: READER_ID }], "the ring reached the reader, so the refusal is the controller's answer to it");
  assert.deepEqual(harness.errors, [LOG_PREFIX + "Unable to ring the doorbell: The controller refused the ring."]);

  harness.clock.advance(REVERT_DELAY_MS);

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false, "and a dispatch the controller refused keeps the shorter pause rather than the window");
});

test("a doorbell capability appearing mid-run creates the doorbell and its trigger, a repeat pass leaves a pending ring's trigger on, and the capability " +
  "withdrawn at a refresh retires both", async () => {

  const harness = makeHub({ options: ["Enable.Hub.Doorbell.Trigger"], record: testHub({ capabilities: ["is_hub"] }) });

  // How many registrations the broker holds for the doorbell's get topic. A registration whose own lifetime aborts leaves the double's list, so this counts
  // whether the topic answers at all rather than what it answers.
  const doorbellGets = (): number => harness.mqtt.subscriptions.filter(entry => entry.topic === mqttGetTopic(HUB_SERIAL + "/doorbell")).length;

  assert.ok(!hasDoorbell(harness), "hardware reporting no doorbell carries neither the doorbell");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER), "nor its automation trigger");
  assert.equal(doorbellGets(), 0, "and nothing is registered on the topic that would answer for one");

  restateRecord(harness, { capabilities: [ "is_hub", "door_bell" ] });

  const trigger = switchService(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

  assert.ok(hasDoorbell(harness), "the capability arriving creates the doorbell on that delivery rather than at the next restart");
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, false, "and its trigger, seeded off");
  assert.equal(lineCount(harness, "Enabling the doorbell."), 1, "each announcing itself once, as a creation does");
  assert.equal(lineCount(harness, "Enabling the doorbell automation trigger."), 1);
  assert.equal(doorbellGets(), 1, "and the get topic is registered with the service it answers for");
  assert.equal(await harness.mqttGet("doorbell"), "false", "answering the quiet doorbell it was registered beside");

  harness.emit("access.remote_view", ringPacket([]));

  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "a ring puts the trigger on");

  harness.accessory.clearObservations();
  restateRecord(harness, {});

  assert.deepEqual(writesOn(harness.accessory, trigger), [], "a repeat pass finds both dressed and writes nothing to either");
  assert.equal(trigger.getCharacteristic(Characteristic.On).value, true, "so the pending ring is still showing");
  assert.equal(doorbellGets(), 1, "and the topic is registered once rather than a second time beside the first");
  assert.equal(await harness.mqttGet("doorbell"), "true", "answering the ring the hub is holding");

  restateRecord(harness, { capabilities: ["is_hub"] });

  assert.ok(!hasDoorbell(harness), "the capability going retires the doorbell");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER), "and its trigger");
  assert.equal(doorbellGets(), 0, "and releases the topic, so a subscriber asking after the withdrawal is answered by nobody");
});

test("a synchronized alias reaches the information service's names and the accessory's display name", () => {

  const harness = makeHub({ options: ["Enable.Device.SyncName"], record: testHub({ alias: "Front Gate \u{1F6AA}" }) });
  const information = harness.hub.accessory.getService(Service.AccessoryInformation);

  assert.ok(information, "the accessory was stood up carrying an information service, which is what a rename writes into");

  assert.equal(information.getCharacteristic(Characteristic.Name).value, "Front Gate");
  assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, "Front Gate",
    "the configured name is what a rename has to reach for the Home app to follow it");

  assert.equal(harness.hub.accessoryName, "Front Gate");
  assert.equal(harness.hub.accessory.displayName, "Front Gate", "and Homebridge's own display name follows through its own setter");
});

// The warning adoption gives a hub whose controller name HomeKit can display nothing of, as a user reads it.
function fallbackWarning(passedOver: string, name: string): string {

  return "The name \"" + passedOver + "\" leaves nothing HomeKit can display, so this device is named " + name + " until a Name set in the plugin's settings " +
    "replaces it.";
}

// How many lines the hub warned about a name falling back, whatever names the line carries, so an arm expecting none cannot miss one worded otherwise.
function fallbackWarnings(harness: HubHarness): number {

  return harness.debugs.filter(line => line.includes("leaves nothing HomeKit can display")).length;
}

test("a hub whose alias HomeKit can display nothing of warns once at adoption, naming the name it carries in its place", () => {

  // A fresh accessory is minted under the name the rule falls back to, so it carries that name when its hub is adopted.
  const minted = makeHub({ accessory: makeTestAccessory("UA-HUB-5B9C", HUB_ID), keepAdoptionLines: true, record: testHub({ alias: "\u{1F6AA}" }) });

  assert.equal(warnCount(minted, fallbackWarning("\u{1F6AA}", "UA-HUB-5B9C")), 1);
  assert.equal(fallbackWarnings(minted), 1, "and nothing else about the name");

  // With name synchronization on, adoption applies the fallback name itself, so a cached accessory under another name carries it by the time the warning is weighed.
  const synced = makeHub({ keepAdoptionLines: true, options: ["Enable.Device.SyncName"], record: testHub({ alias: "\u{1F6AA}" }) });

  assert.equal(synced.hub.accessoryName, "UA-HUB-5B9C", "synchronization applied the record's own name in place of the alias");
  assert.equal(warnCount(synced, fallbackWarning("\u{1F6AA}", "UA-HUB-5B9C")), 1);
  assert.equal(fallbackWarnings(synced), 1);
});

test("a hub whose cached accessory carries another name is not warned about a name it does not carry", () => {

  /* The accessory carries a name of its own, minted under an earlier alias, and with name synchronization off it keeps that name. A Home app rename is the arm
   * below, because the Home app writes the information service's configured name and leaves this name alone.
   */
  const harness = makeHub({ keepAdoptionLines: true, record: testHub({ alias: "\u{1F6AA}" }) });

  assert.equal(harness.hub.accessoryName, "Test Hub", "the accessory keeps the name it carries");
  assert.equal(fallbackWarnings(harness), 0, "so the fallback name it does not carry goes unmentioned");
});

test("a hub whose configured name carries a Home app rename is not warned, though its name still reads the fallback", () => {

  /* The accessory was minted under the name the rule falls back to, and an earlier rename by the plugin wrote its information service's configured name, which is
   * where the Home app then wrote the user's own name. The Home app never writes the name beside it, so that name still reads the fallback, and a warning weighing
   * it alone would speak at every start about a fallback the user has already renamed.
   */
  const accessory = makeTestAccessory("UA-HUB-5B9C", HUB_ID);
  const information = accessory.getService(Service.AccessoryInformation);

  assert.ok(information, "HAP gives every accessory an information service at construction");
  assert.equal(setAccessoryName(accessory, "UA-HUB-5B9C"), true, "the plugin's rename adds the configured name the accessory was minted without");

  information.updateCharacteristic(Characteristic.ConfiguredName, "My Door");

  const harness = makeHub({ accessory, keepAdoptionLines: true, record: testHub({ alias: "\u{1F6AA}" }) });

  assert.equal(harness.hub.accessoryName, "UA-HUB-5B9C", "the name still reads the fallback");
  assert.equal(fallbackWarnings(harness), 0, "yet the configured name carries the user's rename, so the fallback goes unmentioned");
});

test("a hub named by a custom name is not warned about the alias it passed by", () => {

  // The accessory carries the custom name, as the mint and every configure pass name it, and the controller's alias is one HomeKit can display nothing of.
  const harness = makeHub({ accessory: makeTestAccessory("Porch", HUB_ID), keepAdoptionLines: true, options: ["Enable.Device.Name." + HUB_SERIAL + "=Porch"],
    record: testHub({ alias: "\u{1F6AA}" }) });

  assert.equal(harness.hub.accessoryName, "Porch", "the custom name names the device");
  assert.equal(lineCount(harness, "Custom HomeKit name set to Porch."), 1);
  assert.equal(fallbackWarnings(harness), 0, "so nothing fell back, and the line pointing the user at the setting they already used never speaks");
});

test("a rename the record loop applies never warns, whatever the name falls back to", async () => {

  const harness = makeHub({ accessory: makeTestAccessory("Front Door", HUB_ID), keepAdoptionLines: true, options: ["Enable.Device.SyncName"],
    record: testHub({ alias: "Front Door" }), script: [testHub({ alias: "\u{1F6AA}" })] });

  await harness.loop();

  assert.equal(harness.hub.accessoryName, "UA-HUB-5B9C", "the loop applied the name the rule fell back to");
  assert.equal(lineCount(harness, "Detected a name change on the controller; updating the HomeKit name to UA-HUB-5B9C."), 1, "and said so as a rename");
  assert.equal(fallbackWarnings(harness), 0, "but warned nothing, since the warning is adoption's alone");
});

// The custom name the naming arms below set at the hub's own scope, and the entry storing it in the grammar the settings page writes.
const CUSTOM_NAME = "Porch";
const CUSTOM_NAME_ENTRY = "Enable.Device.Name." + HUB_SERIAL + "=" + CUSTOM_NAME;

// How many restores the hub logged, read by the sentence alone, since the context object beside it carries the names each restore wrote.
function restoreCount(harness: HubHarness): number {

  return harness.lines.filter(line => line.startsWith(LOG_PREFIX + RESTORED_LINE)).length;
}

// Rename a service the way the Home app does, through triggerSet, which hands HAP a connection as the write's originator, then let the restore a watch arranged
// run, since a restore waits for the turn after HAP's write.
async function renameInHomeApp(service: Service, name: string): Promise<void> {

  await triggerSet(service.getCharacteristic(Characteristic.ConfiguredName), name);
  await settle();
}

// The names HomeKit holds for one service, read together: its display name, its Name, and the configured name the Home app edits, read only where the service
// carries one so the read never attaches it.
function namesOf(service: Service): { configured: unknown; displayName: string; name: unknown } {

  return { configured: service.testCharacteristic(Characteristic.ConfiguredName) ? service.getCharacteristic(Characteristic.ConfiguredName).value : undefined,
    displayName: service.displayName, name: service.getCharacteristic(Characteristic.Name).value };
}

// The writes the hub made to one service's names, read apart from the state writes a dressing makes beside them.
function nameWritesOn(harness: HubHarness, service: Service): { characteristic: string; value: unknown }[] {

  return writesOn(harness.accessory, service).filter(write => [ Characteristic.ConfiguredName.UUID, Characteristic.Name.UUID ].includes(write.characteristic));
}

// The registrations the hub's signal holds for its abort, a name watch's among them, so an arm reads whether a watch was registered or released.
function abortRegistrations(harness: HubHarness): number {

  return getEventListeners(harness.hub.signal, "abort").length;
}

// The listeners a service carries for its characteristic changes, which is where a name watch listens.
function changeListeners(service: Service): number {

  return service.listenerCount(ServiceEventTypes.CHARACTERISTIC_CHANGE);
}

/* A part a previous run left on the accessory under a name of its own, written the way the plugin's own rename writes one, so the part carries a configured name
 * where its kind supports one, and an arm reads what the hub does to a part it keeps rather than creates.
 *
 * @param serviceType - The HAP service class to carry.
 * @param subtype     - The reserved subtype the hub will look it up under.
 * @param name        - The name the previous run left it carrying.
 *
 * @returns The service.
 */
function restoredPart<T extends Service>(serviceType: new (displayName?: string, subtype?: string) => T, subtype: string, name: string): T {

  const service = carried(serviceType, subtype);

  setServiceName(service, name);

  return service;
}

test("a custom name renames each part an accessory is restored with at adoption, to the custom name followed by the part's suffix", () => {

  // The parts come back from the cache under the name an earlier run gave them, so each is kept rather than created, and only the rule can move it off that name.
  const sensor = restoredPart(Service.ContactSensor, AccessReservedNames.CONTACT_DPS_SIDE, "Old Gate Side Door Position Sensor");
  const sideLock = restoredPart(Service.LockMechanism, AccessReservedNames.LOCK_DOOR_SIDE, "Old Gate Side Door");
  const trigger = restoredPart(Service.Switch, AccessReservedNames.SWITCH_LOCK_TRIGGER, "Old Gate Lock Trigger");
  const gate = makeGate({ existing: [ sensor, sideLock, trigger ], options: [ CUSTOM_NAME_ENTRY, "Enable.Hub.Lock.Trigger" ] });

  assert.ok([ sensor, sideLock, trigger ].every(part => gate.services.includes(part)), "the gate kept every part it was restored with");
  assert.deepEqual(namesOf(sensor), { configured: "Porch Side Door Position Sensor", displayName: "Porch Side Door Position Sensor",
    name: "Porch Side Door Position Sensor" }, "the side door position sensor took the custom name followed by its suffix");
  assert.deepEqual(namesOf(trigger), { configured: "Porch Lock Trigger", displayName: "Porch Lock Trigger", name: "Porch Lock Trigger" }, "and so did the lock trigger");
  assert.deepEqual(namesOf(sideLock), { configured: undefined, displayName: "Porch Side Door", name: "Porch Side Door" },
    "and the side door lock, a kind HomeKit names with Name alone");
  assert.equal(openerService(gate).getCharacteristic(Characteristic.Name).value, CUSTOM_NAME, "while the main door's opener, declaring no suffix, is the custom name");
});

test("under a custom name a rename in the Home app of the accessory's tile or of a part named from it is put back at once, each with one line at info", async () => {

  const harness = makeHub({ options: [ CUSTOM_NAME_ENTRY, "Enable.Hub.Lock.Trigger" ] });
  const information = harness.accessory.getService(Service.AccessoryInformation);
  const trigger = switchService(harness, AccessReservedNames.SWITCH_LOCK_TRIGGER);

  assert.ok(information, "HAP gives every accessory an information service at construction");

  await renameInHomeApp(information, "Den");

  assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, CUSTOM_NAME, "the custom name is back on the tile");
  assert.equal(restoreCount(harness), 1, "and the restore was logged once");

  await renameInHomeApp(trigger, "Den Trigger");

  assert.equal(trigger.getCharacteristic(Characteristic.ConfiguredName).value, CUSTOM_NAME + " Lock Trigger", "the owned name is back on the part");
  assert.equal(restoreCount(harness), 2, "and that restore was logged once as well");
});

test("with neither a custom name nor SyncName a Home app rename stands on the tile and on a part, from an earlier run or this one, and nothing is written " +
  "over it", async () => {

  // The lock trigger carries the name the user gave it in the Home app during an earlier run, written where the Home app writes it.
  const trigger = restoredPart(Service.Switch, AccessReservedNames.SWITCH_LOCK_TRIGGER, "Test Hub Lock Trigger");

  trigger.updateCharacteristic(Characteristic.ConfiguredName, "My Trigger");

  const accessory = makeAccessory([trigger]);
  const information = accessory.getService(Service.AccessoryInformation);

  assert.ok(information, "HAP gives every accessory an information service at construction");

  accessory.clearObservations();

  const harness = makeHub({ accessory, options: ["Enable.Hub.Lock.Trigger"] });

  assert.equal(trigger.getCharacteristic(Characteristic.ConfiguredName).value, "My Trigger", "adoption keeps the name the user gave the part");

  await renameInHomeApp(information, "Den");
  await renameInHomeApp(trigger, "Den Trigger");

  assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, "Den", "the tile's rename stands");
  assert.equal(trigger.getCharacteristic(Characteristic.ConfiguredName).value, "Den Trigger", "and so does the part's");
  assert.deepEqual([ ...nameWritesOn(harness, information), ...nameWritesOn(harness, trigger) ], [], "the hub wrote no name, at adoption or after the renames");
  assert.equal(restoreCount(harness), 0, "and logged no restore");
});

test("with neither a custom name nor SyncName a part is created from the name the accessory carries, never from the controller's name for the hub", () => {

  // The accessory keeps the name it carries while the controller's name for the hub reads otherwise, since nothing renames an accessory whose name the user owns.
  const harness = makeHub({ options: ["Enable.Hub.Lock.Trigger"], record: testHub({ alias: "Front Door" }) });

  assert.equal(harness.hub.accessoryName, "Test Hub", "precondition: the accessory keeps the name it carries");
  assert.equal(switchService(harness, AccessReservedNames.SWITCH_LOCK_TRIGGER).getCharacteristic(Characteristic.Name).value, "Test Hub Lock Trigger",
    "the lock trigger is created as that name followed by its suffix");
});

test("reconcile passes keep a held part's watch rather than attaching another, and one rename in the Home app after them draws one restore", async () => {

  const harness = makeHub({ options: [ CUSTOM_NAME_ENTRY, "Enable.Hub.Lock.Trigger" ] });
  const trigger = switchService(harness, AccessReservedNames.SWITCH_LOCK_TRIGGER);
  const listeners = trigger.listeners(ServiceEventTypes.CHARACTERISTIC_CHANGE);
  const registrations = abortRegistrations(harness);

  // Each restatement is a device update over an unchanged record, so every pass re-validates the trigger and hands back the service held.
  for(const _pass of [ 1, 2, 3 ]) {

    restateRecord(harness, {});
  }

  assert.deepEqual(trigger.listeners(ServiceEventTypes.CHARACTERISTIC_CHANGE), listeners, "the part carries the very listeners it carried before the passes");
  assert.equal(abortRegistrations(harness), registrations, "and the device's signal holds no registration more");

  await renameInHomeApp(trigger, "Den Trigger");

  assert.equal(trigger.getCharacteristic(Characteristic.ConfiguredName).value, CUSTOM_NAME + " Lock Trigger", "the owned name is back on the part");
  assert.equal(restoreCount(harness), 1, "and one restore was logged");
});

test("a watched part a device update adds is let go when a later update's verdict removes it, leaving the device's signal holding what it held before", () => {

  const harness = makeHub({ options: [CUSTOM_NAME_ENTRY] });
  const standing = abortRegistrations(harness);

  harness.reconfigure([ CUSTOM_NAME_ENTRY, "Enable.Hub.Lock.Trigger" ]);
  restateRecord(harness, {});

  assert.ok(switchService(harness, AccessReservedNames.SWITCH_LOCK_TRIGGER).testCharacteristic(Characteristic.ConfiguredName),
    "precondition: the update added the lock trigger, a kind the Home app renames");
  assert.equal(abortRegistrations(harness), standing + 1, "and its watch registered once on the device's signal");

  harness.reconfigure([CUSTOM_NAME_ENTRY]);
  restateRecord(harness, {});

  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_LOCK_TRIGGER), "the later update's verdict removed the lock trigger");
  assert.equal(abortRegistrations(harness), standing, "and its watch released its registration on the device's signal");
});

test("the lock an accessory is restored with is renamed under a custom name and carries no watch, a kind HomeKit names with Name alone", () => {

  const plain = makeHub({ existing: [new Service.LockMechanism("Old Lock")] });
  const owned = makeHub({ existing: [new Service.LockMechanism("Old Lock")], options: [CUSTOM_NAME_ENTRY] });
  const plainLock = lockService(plain);
  const ownedLock = lockService(owned);

  assert.equal(plainLock.getCharacteristic(Characteristic.Name).value, "Old Lock", "with no custom name the lock keeps its name");
  assert.equal(ownedLock.getCharacteristic(Characteristic.Name).value, CUSTOM_NAME, "with one it takes the custom name");
  assert.equal(changeListeners(ownedLock), changeListeners(plainLock), "and it carries no change listener beyond the ones the unwatched lock carries");
});

test("a controller rename under SyncName renames every held part on the yield that renames the accessory, and a yield leaving the accessory's names as they " +
  "stand writes no part", async () => {

  const harness = makeHub({ accessory: makeTestAccessory("Front Door", HUB_ID), options: [ "Enable.Device.SyncName", "Enable.Hub.Lock.Trigger" ],
    record: testHub({ alias: "Front Door" }), script: [ testHub({ alias: "Front Door" }), testHub({ alias: "Back Door" }) ] });
  const trigger = switchService(harness, AccessReservedNames.SWITCH_LOCK_TRIGGER);

  assert.equal(trigger.getCharacteristic(Characteristic.ConfiguredName).value, "Front Door Lock Trigger",
    "precondition: the trigger starts under the controller's first name for the hub");

  /* The trigger's configured name is moved off the owned name the way only the plugin writes, so no watch puts it back: a part whose name drifted while the
   * accessory's did not. The first yield restates the name the accessory already carries, so its rename writes nothing and the part is left as it stands, and the
   * second carries the controller's rename, which reaches the accessory and then every held part.
   */
  trigger.updateCharacteristic(Characteristic.ConfiguredName, "Drifted Trigger");
  harness.accessory.clearObservations();

  await harness.loop();

  assert.deepEqual(nameWritesOn(harness, trigger), [ { characteristic: Characteristic.ConfiguredName.UUID, value: "Back Door Lock Trigger" },
    { characteristic: Characteristic.Name.UUID, value: "Back Door Lock Trigger" } ], "the trigger is written once, on the yield that renamed the accessory");
  assert.equal(lockService(harness).getCharacteristic(Characteristic.Name).value, "Back Door", "and the main door's lock, declaring no suffix, takes the new name");
  assert.equal(lineCount(harness, "Detected a name change on the controller; updating the HomeKit name to Back Door."), 1, "and the rename is said once");
});

test("a yield under SyncName whose rename of the accessory writes without moving its display name renames every held part, and says no rename", async () => {

  const harness = makeHub({ accessory: makeTestAccessory("Front Door", HUB_ID), options: [ "Enable.Device.SyncName", "Enable.Hub.Lock.Trigger" ],
    record: testHub({ alias: "Front Door" }), script: [testHub({ alias: "Front Door" })] });
  const information = harness.accessory.getService(Service.AccessoryInformation);
  const trigger = switchService(harness, AccessReservedNames.SWITCH_LOCK_TRIGGER);

  assert.ok(information, "HAP gives every accessory an information service at construction");

  /* The tile's and the trigger's configured names are moved off the owned name the way only the plugin writes, so no watch puts them back. The yield restates
   * the name the accessory already displays, so its rename writes the tile's configured name back and leaves the display name where it stands: the parts follow
   * any write the rename makes, while the rename line waits for the display name to move.
   */
  information.updateCharacteristic(Characteristic.ConfiguredName, "Drifted Tile");
  trigger.updateCharacteristic(Characteristic.ConfiguredName, "Drifted Trigger");

  await harness.loop();

  assert.equal(harness.accessory.displayName, "Front Door", "the display name did not move");
  assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, "Front Door", "the accessory's rename wrote the tile's name back");
  assert.equal(trigger.getCharacteristic(Characteristic.ConfiguredName).value, "Front Door Lock Trigger", "and the trigger followed that write");
  assert.equal(lineCount(harness, "Detected a name change on the controller; updating the HomeKit name to Front Door."), 0, "while no rename is said");
});

test("an access method switch a reader is restored with is held, renamed, and watched once the reader's access method model seeds, and not before", async () => {

  const nfc = restoredPart(Service.Switch, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC, "Old Reader NFC");
  const answer = Promise.withResolvers<unknown>();
  const harness = makeReader({ existing: [nfc], official: true, options: [CUSTOM_NAME_ENTRY],
    record: testHub({ capabilities: [ "is_hub", "is_reader", "nfc_card_easy_provision" ], configs: undefined }),
    settings: async (): Promise<unknown> => answer.promise });
  const unwatched = changeListeners(nfc);

  // The settings read is still out, so the model has not seeded and no pass has reconciled the switch.
  assert.deepEqual(namesOf(nfc), { configured: "Old Reader NFC", displayName: "Old Reader NFC", name: "Old Reader NFC" }, "the switch keeps its name before the seed");

  answer.resolve({ access_methods: { nfc: { enabled: "yes" } } });
  await settle();

  assert.deepEqual(namesOf(nfc), { configured: "Porch NFC", displayName: "Porch NFC", name: "Porch NFC" },
    "the seed's pass holds the switch, renaming it to the custom name followed by its method");
  assert.equal(changeListeners(nfc), unwatched + 1, "and watching it");

  await renameInHomeApp(nfc, "Den NFC");

  assert.equal(nfc.getCharacteristic(Characteristic.ConfiguredName).value, "Porch NFC", "so a rename in the Home app is put back at once");
  assert.equal(restoreCount(harness), 1, "with one line at info");
});

test("a presentation change under SyncName lets go of the lock the door left, so a controller rename after it reaches the opener and never the " +
  "detached lock", async () => {

  const harness = makeHub({ accessory: makeTestAccessory("Front Door", HUB_ID), options: ["Enable.Device.SyncName"], record: testHub({ alias: "Front Door" }),
    script: [testHub({ alias: "Back Door" })] });
  const lock = lockService(harness);

  harness.reconfigure([ "Enable.Device.SyncName", "Enable.Hub.Door.Service=GarageDoorOpener" ]);
  restateRecord(harness, {});

  const opener = openerService(harness);

  assert.ok(!harness.services.includes(lock), "the update detached the lock the door is leaving");

  await harness.loop();

  assert.equal(opener.getCharacteristic(Characteristic.Name).value, "Back Door", "the controller's rename reaches the opener the door moved to");
  assert.equal(lock.getCharacteristic(Characteristic.Name).value, "Front Door", "and never the lock the presentation change let go of");
});

/* The saves a bridged hub makes over the next save window: whatever the arm changed before asking is marked already, and the window that change opened closes
 * inside the advance, so an arm reads exactly what its change saved. Adoption marks the accessory as it writes its context, so a hub's first window carries
 * everything adoption set up with that mark, and an arm reads past it with this same call before it changes anything of its own.
 *
 * @param harness - The bridged hub.
 *
 * @returns The UUIDs each save over the window named.
 */
function windowSaves(harness: HubHarness): string[][] {

  const before = harness.saves.length;

  harness.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

  return harness.saves.slice(before);
}

// The services an accessory carries, each by its type and subtype, so an arm can show a device update left every one of them standing where it stood.
function serviceIdentities(harness: HubHarness): string[] {

  return harness.services.map(service => service.UUID + "/" + (service.subtype ?? ""));
}

/* A restart onto an accessory already carrying everything the hub presents, restored the way Homebridge restores its cache, through a serialize and deserialize
 * round trip. Adoption attaches nothing to it, so the context its write replaces is the one change the accessory cache has to hear about.
 */
test("a hub adopted onto an accessory already carrying its services saves the accessory once, for the context its adoption rewrote", () => {

  const earlier = makeHub();

  // The plugin and the platform are what Homebridge's cache stamps on an accessory, and what its serialization requires. The context is one a stale run wrote.
  earlier.accessory._associatedPlugin = PLUGIN_NAME;
  earlier.accessory._associatedPlatform = PLATFORM_NAME;
  earlier.accessory.context = { controller: "5.6.7.8" };

  const restored = runtime.PlatformAccessory.deserialize(runtime.PlatformAccessory.serialize(earlier.accessory)) as TestAccessAccessory;
  const harness = makeHub({ accessory: restored, bridged: true });

  assert.deepEqual(harness.accessory.context, { controller: "1.2.3.4", id: HUB_SERIAL, mac: HUB_MAC }, "adoption rewrites the context the stale run left");
  assert.deepEqual(serviceIdentities(harness), serviceIdentities(earlier), "and attaches or removes nothing, the accessory already carrying every service");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "so the context's own mark is what saves the accessory, once");
});

test("a device update that attaches a terminal input's sensor saves the accessory once, one that retires it saves once more, and one changing nothing " +
  "saves nothing", () => {

  const harness = makeHub({ bridged: true });

  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "adoption saves the accessory once, a window after it began");

  refreshRecord(harness, [ ...REL_PAIR_LIVE, ...inputRows({ "input_state_rel": "on" }) ]);

  assert.ok(hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the pair reporting live attaches the sensor on the update that carries it");
  assert.equal(harness.saves.length, 1, "and the attach waits for its window rather than saving at once");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "then saves the accessory once, when that window closes");

  harness.reconfigure([listLess("Hub.Sensors", hubSensorChoices(), "REL")]);
  restateRecord(harness, {});

  assert.ok(!hasContactSensor(harness, AccessReservedNames.CONTACT_REL), "the user's toggle retires the sensor on the next update");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "and the retirement saves the accessory once as well");

  restateRecord(harness, {});

  assert.deepEqual(windowSaves(harness), [], "an update that changes nothing on the accessory saves nothing");
});

test("a device update that creates one access method switch and retires another saves the creation and the retirement together, once", () => {

  const harness = makeReader({ bridged: true, record: testHub({ capabilities: [ "is_hub", "is_reader", "pin_code", "qr_code" ],
    configs: [{ device_id: HUB_ID, key: "pin_code", tag: "open_door_mode", value: "yes" }] }) });

  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "adoption saves the accessory once");
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), "the reader adopted with a QR switch to retire");

  restateRecord(harness, { capabilities: [ "is_hub", "is_reader", "nfc_card_easy_provision", "pin_code" ] });

  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_NFC), "the capability arriving creates its switch");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_ACCESSMETHOD_QR), "and the one going retires its own");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "the creation and the retirement reach the cache in the one save their window gathers");
});

test("a device update that retires the side door position sensor saves the gate's accessory once", () => {

  const harness = makeGate({ bridged: true });

  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "adoption saves the accessory once");

  harness.reconfigure([listLess("Hub.Sensors", hubSensorChoices(), "SideDoorDPS")]);
  restateRecord(harness, {});

  assert.ok(!hasContactSensor(harness, AccessReservedNames.CONTACT_DPS_SIDE), "the selection turned off retires the sensor on the next update");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "and the retirement saves the accessory once");
});

test("a doorbell capability arriving mid-run saves the doorbell and its trigger in one save, and its withdrawal saves their retirement in another", () => {

  const harness = makeHub({ bridged: true, options: ["Enable.Hub.Doorbell.Trigger"], record: testHub({ capabilities: ["is_hub"] }) });

  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "adoption saves the accessory once");

  restateRecord(harness, { capabilities: [ "is_hub", "door_bell" ] });

  assert.ok(hasDoorbell(harness), "the capability arriving creates the doorbell");
  assert.ok(hasSwitch(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER), "and its trigger");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "and the doorbell and its trigger reach the cache in one save");

  restateRecord(harness, { capabilities: ["is_hub"] });

  assert.ok(!hasDoorbell(harness), "the capability going retires the doorbell");
  assert.ok(!hasSwitch(harness, AccessReservedNames.SWITCH_DOORBELL_TRIGGER), "and its trigger");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "and their retirement reaches the cache in one save of its own");
});

/* The door's presentation moving under a running hub removes the service it is leaving through the removal pass ahead of the door's own gate, and attaches the one
 * it moves to, so the one pass makes a removal and an attach the accessory cache has to hear about.
 */
test("a presentation change under a running hub saves the presentation it left and the one it took in a single save", () => {

  const harness = makeHub({ bridged: true });

  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "adoption saves the accessory once");

  harness.reconfigure(["Enable.Hub.Door.Service=GarageDoorOpener"]);
  restateRecord(harness, {});

  assert.equal(harness.services.filter(service => service.UUID === Service.LockMechanism.UUID).length, 0, "the update removes the lock the door is leaving");
  assert.ok(openerService(harness), "and presents the door as an opener");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "and the removal and the attach reach the cache in one save");
});

test("a tamper characteristic attached or withdrawn by a device update saves the accessory once each, with every service standing where it stood", () => {

  const harness = makeHub({ bridged: true, record: wiredHub("on") });
  const sensors = TERMINAL_SUBTYPES.map(subtype => contactSensor(harness, subtype));

  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "adoption saves the accessory once");

  const standing = serviceIdentities(harness);

  // The doorbell's capability is restated beside the tamper capability, so the update moves the characteristic alone.
  restateRecord(harness, { capabilities: [ "is_hub", "door_bell", "tamper_proofing" ], configs: [ ...wiredRows("on"), ...tamperRows({ "tamper_event": "true" }) ] });

  assert.ok(sensors.every(sensor => sensor.testCharacteristic(Characteristic.StatusTampered)), "the capability arriving puts the characteristic on every sensor");
  assert.deepEqual(serviceIdentities(harness), standing, "while every service stands where it stood, so the save below is the characteristic's alone");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "and the attach saves the accessory once");

  restateRecord(harness, { capabilities: [ "is_hub", "door_bell" ] });

  assert.ok(sensors.every(sensor => !sensor.testCharacteristic(Characteristic.StatusTampered)), "the capability going takes it off every sensor");
  assert.deepEqual(serviceIdentities(harness), standing, "with every service still standing");
  assert.deepEqual(windowSaves(harness), [[harness.accessory.UUID]], "and the withdrawal saves the accessory once");
});
