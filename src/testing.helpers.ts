/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The fixture builders more than one suite reads - the Homebridge runtime and the builder of every Homebridge API double, the accessories
 * built on that runtime and the readers of what HAP recorded on them, the line a name watch logs as it restores a name, the topology documents, the configuration
 * rows, the managed device records, and the platform and controller doubles every suite stands its devices up over.
 *
 * Every accessory, service and characteristic a suite touches is the real thing. This file loads the Homebridge runtime once, through homebridge-plugin-utils'
 * Homebridge double, and makeTestApi builds every API double a suite uses over it, so an accessory is Homebridge's own PlatformAccessory over the hap-nodejs copy
 * Homebridge loads, and the API the platform double hands production runs Homebridge's own bridge bookkeeping and records the calls Homebridge accepted. A suite's
 * assertion about HomeKit state therefore reads what production would leave there, and the harness restates no part of HAP or Homebridge to get it.
 *
 * Each record builder states one Access document or record shape, so every suite seeding that shape seeds the same one and a change to the shape is a change in one
 * place. A harness only one file reads stays in that file: the status feed's client stub is an instrument for one suite's questions rather than shared vocabulary,
 * and moving it here would buy nothing.
 *
 * The record builders default to the members every suite that spells one agrees on, and to nothing beyond that. Overrides can add a member or restate one but
 * cannot take a defaulted member away, so a default carrying more than the agreed set would change what an arm reads in a suite that deliberately left that member
 * out. Everything past the agreed set is the calling suite's own override.
 *
 * The reduced device type requires members the agreed set does not carry, so each record builder asserts its literal onto that type directly. One assertion is
 * enough, because the type is a superset of the literal...nothing here needs the wider trip through unknown.
 *
 * Co-located under src/ so the type-check pass covers this file alongside everything else, while tsconfig.build.json excludes every *.helpers.ts from the emitted
 * dist/, so none of it reaches the published package.
 */
/* eslint-disable camelcase */
import { ACCESS_WEBHOOK_PORT, PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { API, CharacteristicValue, Logging } from "homebridge";
import type { AccessAccessory, AccessAccessoryContext } from "./types.ts";
import type { AccessBootstrapConfig, AccessCapabilities, AccessClient, AccessDeviceEntryConfig, AccessDoorStateEntry, AccessEventPacket,
  AccessStateDevice } from "unifi-access";
import type { AccessControllerOptions, AccessOptions } from "./options.ts";
import type { AccessEvents, AccessListener } from "./controller/events.ts";
import type { AccessLoginOutcome, ControllerIdentity, ControllerOwnershipKeys, DecoratedSerial, MembershipClaims } from "./policy.ts";
import { AccessoryPersistence, ChangeReason, FeatureOptions } from "homebridge-plugin-utils";
import type { Clock, HomebridgePluginLogging, HttpListener, MqttClient, Nullable } from "homebridge-plugin-utils";
import { TestClock, loadHomebridge, silentLog, watchServerWarnings } from "homebridge-plugin-utils/testing";
import type { TestHomebridgeApi, TestMqttClient, TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import { controllerIdentity, deviceModel } from "./policy.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { AccessController } from "./controller/controller.ts";
import type { AccessPlatform } from "./platform.ts";

/**
 * The Homebridge runtime every suite runs on: the hap-nodejs copy and the classes Homebridge loads from this repository's tree, resolved once for the whole process.
 * Every API double makeTestApi builds runs on it, so every accessory a suite meets shares one HAP.
 */
export const runtime = await loadHomebridge(import.meta.url);

/**
 * The builder every Homebridge API double in the suites comes from: each call makes a TestHomebridgeApi over the runtime above and holds it for the check
 * homebridge-plugin-utils' watchServerWarnings runs after each test.
 *
 * This module evaluates once per process, before any suite creates its tests, and the test runner gives each file a process of its own, so the builder's one
 * after-each hook sits at the root of each file's test tree and checks every double built through it once each test's own cleanups have run. A warning Homebridge
 * logged on a double that the test left untaken fails the test it is checked after, and one a before hook or a timer logs lands on the next test, as
 * homebridge-plugin-utils documents for the check. A second builder in a file would lose its check in any test whose first check failed, so no suite calls
 * watchServerWarnings itself and every double, the platform double's default included, comes from here.
 */
export const makeTestApi = watchServerWarnings(runtime);

/**
 * The runtime's HAP namespace, the one production reaches as `api.hap`.
 */
export const hap = runtime.hap;

/**
 * HAP's own Characteristic and Service classes, the namespaces a suite names a kind by (`Characteristic.On`, `Service.Switch`), each exported as a value and, below,
 * as the instance type, the way the class itself serves as a value and a type.
 */
export const { Characteristic, Service } = hap;

export type Characteristic = InstanceType<typeof hap.Characteristic>;

export type Service = InstanceType<typeof hap.Service>;

/**
 * The accessory the accessory builder hands back: Homebridge's own PlatformAccessory over the runtime's HAP, carrying the plugin's typed context, made through an API
 * double so it records every value change and characteristic warning HAP raises on it.
 */
export type TestAccessAccessory = TestPlatformAccessory<AccessAccessoryContext>;

// The API double whose accessory class builds every accessory makeTestAccessory hands back. An accessory made here is placed on another API's bridge by that API's
// own restore or registration, because each API double runs on the one runtime above and accepts any accessory of its PlatformAccessory class.
const constructionApi = makeTestApi();

// The counter behind each default accessory identity, so accessories built without a seed, same-named or not, never share a UUID: Homebridge skips a registration
// whose UUID it already holds, which would leave a later accessory off the bridge in silence.
let accessorySeeds = 0;

// The next default seed, unique within the process.
function nextSeed(): string {

  accessorySeeds++;

  return "homebridge-unifi-access.test-accessory." + accessorySeeds.toString();
}

/**
 * The UUID an accessory seeded by `seed` carries, derived through HAP's own generator exactly as production derives each accessory's UUID, so a suite seeds a device's
 * accessory by the same identity production composes for it: the device's decorated serial.
 *
 * @param seed - The identity the accessory's UUID derives from.
 *
 * @returns The UUID HAP generates for that seed.
 */
export function accessoryUuid(seed: string): string {

  return hap.uuid.generate(seed);
}

/**
 * Build an accessory through the construction API: Homebridge's own PlatformAccessory, born off the bridge as every new accessory is, with the AccessoryInformation
 * service HAP gives it at construction and its Name set to the display name.
 *
 * @param displayName - The accessory's display name. Defaults to "Test Accessory".
 * @param seed        - The identity its UUID derives from through {@link accessoryUuid}. Defaults to a seed unique within the process, so accessories a row builds
 *                      without one never collide.
 *
 * @returns A fresh accessory, typed with the plugin's context.
 */
export function makeTestAccessory(displayName = "Test Accessory", seed = nextSeed()): TestAccessAccessory {

  return new constructionApi.platformAccessory<AccessAccessoryContext>(displayName, accessoryUuid(seed));
}

/**
 * The event notifications one characteristic sent HomeKit through HAP's `sendEventNotification`, in the order it sent them. HAP stores each notified value as the
 * characteristic's value and raises a change for it, so a row reads what HomeKit was told from this rather than from the final value, and a notification on another
 * instance of the same kind elsewhere on the accessory stays out. The reason it selects by is homebridge-plugin-utils' runtime mirror of HAP's own enum, the value
 * HAP stamps on each change an event notification raises.
 *
 * @param accessory      - The accessory whose recorded changes to read.
 * @param characteristic - The characteristic instance whose notifications to select.
 *
 * @returns The value of each notification the characteristic sent.
 */
export function eventsFrom(accessory: TestPlatformAccessory, characteristic: Characteristic): Nullable<CharacteristicValue>[] {

  return accessory.changes.filter((change) => (change.characteristic === characteristic) && (change.reason === ChangeReason.EVENT))
    .map((change) => change.newValue);
}

/**
 * The writes production made to one service through HAP's update path (`updateValue` and `updateCharacteristic`), each as the characteristic's UUID beside the
 * value written, in the order HAP raised them. HAP raises a change for every such write, a write of an unchanged value included, so a row proving production wrote
 * nothing reads this rather than the final values, and a row about the order one update reaches HomeKit in reads it across the service's characteristics. HomeKit's
 * own writes and reads and the event notifications the service sent carry other reasons and stay out, as does a write to another service of the same kind
 * elsewhere on the accessory. The service is selected by identity rather than its characteristics by kind, so a characteristic the service gains or loses inside
 * the window keeps the writes HAP raised on it there. A row opens the window it reads with the accessory's `clearObservations()`.
 *
 * @param accessory - The accessory whose recorded changes to read.
 * @param service   - The service instance whose writes to select.
 *
 * @returns Each update the service raised, as the characteristic's UUID and the value written.
 */
export function writesOn(accessory: TestPlatformAccessory, service: Service): { characteristic: string; value: Nullable<CharacteristicValue> }[] {

  return accessory.changes.filter((change) => (change.service === service) && (change.reason === ChangeReason.UPDATE))
    .map((change) => ({ characteristic: change.characteristic.UUID, value: change.newValue }));
}

/**
 * The line homebridge-plugin-utils logs at info each time a name watch puts the name the plugin owns back on a service after a rename in the Home app.
 */
export const RESTORED_LINE = "Restored the name the plugin owns for a service after the Home app renamed it.";

/**
 * The building every topology document below roots at, and the location an Enterprise hub is recognized as building-hosted by.
 */
export const ROOT_ID = "root1";

/**
 * Build a minimal topology document carrying the given device records directly under the building, with no floors and no doors of its own.
 *
 * Only the members the library's reducer and its selectors read are meaningful; the rest satisfies the document's shape. Hardware hung straight off the building
 * serves no door, so a document from this builder establishes nothing about one.
 *
 * @param devices - The device records to place in the building's device group.
 *
 * @returns The topology document.
 */
export function buildingTopology(devices: Record<string, unknown>[]): AccessBootstrapConfig {

  return {

    device_groups: [devices],
    extra_type: "building",
    extras: {},
    floors: [],
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

/**
 * Build a minimal topology document whose doors each carry their own serving hardware, on a single floor under the building.
 *
 * The library resolves a door's serving hardware from that door's own device group, so this is the document any arm about door state has to seed: hardware placed
 * under a door serves that door and seeds what the door establishes.
 *
 * @param doors - Each door's identity, the device records serving it, and the name it carries. The name defaults to the identity in prose form, and a door's full
 *                name always reads the same as its name.
 *
 * @returns The topology document.
 */
export function doorsTopology(doors: { devices: Record<string, unknown>[]; id: string; name?: string }[]): AccessBootstrapConfig {

  return {

    device_groups: [[]],
    extra_type: "building",
    extras: {},
    floors: [{

      doors: doors.map(({ devices, id, name = "Door " + id }) => ({ device_groups: [devices], extras: {}, full_name: name, level: 2, location_type: "door", name,
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

/**
 * Build the configuration rows a device record carries, in the key/tag/value shape the controller writes them as.
 *
 * @param options - deviceId: the device the rows are addressed to, defaulting to the identity the shared hub record carries; entries: the key each row is read by
 *                  and the reading it reports; tag: the family the rows belong to, defaulting to the terminal input readings.
 *
 * @returns One row per entry, in the order the entries were given.
 */
export function configRows({ deviceId = "device1", entries, tag = "input_state" }: { deviceId?: string; entries: Record<string, string>;
  tag?: string; }): AccessDeviceEntryConfig[] {

  return Object.entries(entries).map(([ key, value ]) => ({ device_id: deviceId, key, tag, value }));
}

/**
 * Build a managed hub record: the members every suite that seeds one agrees on, with whatever the calling arm cares about layered over them.
 *
 * @param overrides - The members to add to the record or to restate on it.
 *
 * @returns The record.
 */
export function hubRecord(overrides: Record<string, unknown> = {}): AccessStateDevice & { mac: string } {

  return { capabilities: ["is_hub"], device_type: "UAH", is_managed: true, mac: "aabbccddee01", name: "Test Hub", unique_id: "device1",
    ...overrides } as AccessStateDevice & { mac: string };
}

/**
 * Build a managed reader record: the members every suite that seeds one agrees on, with whatever the calling arm cares about layered over them. The hub a reader
 * hangs off is a caller's override, because a reader's own record says nothing about one until a suite asks it to.
 *
 * @param overrides - The members to add to the record or to restate on it.
 *
 * @returns The record.
 */
export function readerRecord(overrides: Record<string, unknown> = {}): AccessStateDevice & { mac: string } {

  return { capabilities: ["is_reader"], device_type: "UA-G2-PRO", is_managed: true, mac: "aabbccddee02", name: "Test Reader", unique_id: "reader1",
    ...overrides } as AccessStateDevice & { mac: string };
}

// The platform double.

/* The platform members the plugin reads, which is what a double has to carry and all a double has to carry. The list is the receipt of a grep over the plugin's
 * reads of its platform, so a member the plugin starts reading enters here by the same grep, and a double missing a listed member is a compile error in this one
 * place rather than a silent fallback at every site that stands one up.
 */
type PlatformSurface = Pick<AccessPlatform, "accessories" | "api" | "clock" | "config" | "featureOptions" | "localAddressFor" | "log" | "persistence" |
  "registerAccessory" | "signal" | "stopping" | "unregisterAccessory" | "webhookListener" | "webhookPort">;

// What an arm varies about the platform it stands up. Every member has a default, so an arm names only what it reads or records.
export interface PlatformDoubleOptions {

  accessories?: AccessAccessory[];
  // The Homebridge API double, for an arm that reads its calls or its events. An arm handing none gets one from makeTestApi, checked like every other.
  api?: TestHomebridgeApi;
  clock?: Clock;
  config?: AccessOptions;
  // The feature-option entries an engine is built from, when the arm does not hand over an engine of its own.
  entries?: string[];
  featureOptions?: FeatureOptions;
  localAddressFor?: (host: string) => Promise<string>;
  log?: Pick<Logging, "error" | "info" | "warn">;
  signal?: AbortSignal;
  webhookListener?: () => HttpListener;
  webhookPort?: number;
}

/* Stand up the platform as a controller or a device reads it: every member the plugin reads, defaulted, with the accessory entry and exit reaching the same api calls
 * and the same list the real ones do. The api is a Homebridge API double, so those calls run Homebridge's own checks and bridge bookkeeping, and an accessory the
 * list holds has to be registered or restored on that api before an exit or a save reaches it, as under Homebridge. The casts live here, stated once: the platform
 * class carries private fields nothing structural can satisfy, so a double typed against the members the plugin reads is widened to the class at this boundary and
 * nowhere else, and the API double answers only the part of Homebridge's API the plugin reaches, so it is widened to that API at the same boundary.
 *
 * @param options - What the arm varies; see {@link PlatformDoubleOptions}.
 *
 * @returns The platform double, typed as the platform.
 */
export function makePlatformDouble(options: PlatformDoubleOptions = {}): AccessPlatform {

  const accessories = options.accessories ?? [];
  const api = options.api ?? makeTestApi();
  const clock = options.clock ?? new TestClock();
  /* The real persistence, built over the double's api and on its clock as the platform builds its own over Homebridge's API and the plugin's clock, so every save
   * production asks for lands among the api's update calls once its window comes due on that clock, and the exit below drops a save still pending for the
   * accessory leaving. The persistence reaches only the part of the API homebridge-plugin-utils names for it, which the api double carries, so it takes the double
   * as it is.
   */
  const persistence = new AccessoryPersistence({ api, clock, platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });
  const surface: PlatformSurface = {

    accessories,
    api: api as unknown as API,
    clock,
    config: options.config ?? { controllers: [], options: [] },
    featureOptions: options.featureOptions ?? new FeatureOptions(featureOptionCategories, featureOptions, options.entries ?? []),
    localAddressFor: options.localAddressFor ?? (async (): Promise<string> => "10.0.0.7"),
    log: (options.log ?? { error: (): void => undefined, info: (): void => undefined, warn: (): void => undefined }) as Logging,
    persistence,
    registerAccessory: (accessory: AccessAccessory): void => {

      api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      accessories.push(accessory);
    },
    signal: options.signal ?? new AbortController().signal,
    // A double never begins a shutdown of its own, so an arm ends the platform it stands up by aborting the signal it handed over.
    stopping: false,
    unregisterAccessory: (accessory: AccessAccessory): void => {

      const index = accessories.indexOf(accessory);

      if(index < 0) {

        return;
      }

      persistence.unregister([accessory]);
      accessories.splice(index, 1);
    },
    webhookListener: options.webhookListener ?? ((): HttpListener => {

      throw new Error("This platform double carries no webhook listener.");
    }),
    webhookPort: options.webhookPort ?? ACCESS_WEBHOOK_PORT
  };

  return surface as unknown as AccessPlatform;
}

/**
 * The saves Homebridge accepted on an API double, in the order it accepted them, each read as the UUIDs of the accessories it named. A save is one update call, so
 * the accessories one save window gathered read as one entry however often each was marked, and an accessory off the bridge, which the persistence never hands
 * Homebridge, reads in none.
 *
 * @param api - The API double whose calls to read.
 *
 * @returns The UUIDs each save named.
 */
export function savesOn(api: TestHomebridgeApi): string[][] {

  return api.calls.flatMap((call) => (call.kind === "update") ? [call.accessories.map((accessory) => accessory.UUID)] : []);
}

// The controller double.

/* The controller members the plugin reads, which is what a double has to carry and all a double has to carry. The list is the receipt of a grep over the plugin's
 * reads of its controller, so a member the plugin starts reading enters here by the same grep, and a double missing a listed member is a compile error in this one
 * place rather than a silent fallback at every site that stands one up.
 */
type ControllerSurface = Pick<AccessController, "client" | "config" | "events" | "getDeviceName" | "hasFeature" | "id" | "log" | "login" | "mqtt" |
  "mqttPublish" | "name" | "ownershipKey" | "platform" | "reclaimClaims" | "reclaimKeys" | "resolveDeviceModel" | "signal" | "spawnLoop">;

/* The client members the plugin reads, each optional because an arm supplies only the ones its path reaches: the official surface and the transport are whatever the
 * arm hands over, the connection and the state answer what a device composes its own availability and membership from, the capabilities say which kind of client
 * the arm stands up, and the subscription is a disposable.
 */
export interface ControllerClientDouble {

  capabilities?: Pick<AccessCapabilities, "mode">;
  connection?: { readonly isHealthy: boolean };
  doorStates?: ReadonlyMap<string, AccessDoorStateEntry>;
  official?: unknown;
  on?: (event: string, handler: (packet: AccessEventPacket) => void) => Disposable;
  state?: { snapshot: () => unknown };
  transport?: unknown;
}

// The event-rail members the plugin reads, each optional for the same reason the client's are: an arm records the half of the rail its own question is about.
export interface ControllerEventsDouble {

  emitPacket?: (packet: AccessEventPacket) => void;
  off?: (event: string, handler: AccessListener) => void;
  on?: (event: string, handler: AccessListener) => void;
}

// What an arm varies about the controller it stands up. Every member has a default, so an arm names only what it reads or records.
export interface ControllerDoubleOptions {

  client?: ControllerClientDouble;
  config?: AccessControllerOptions;
  events?: ControllerEventsDouble;
  getDeviceName?: AccessController["getDeviceName"];
  hasFeature?: AccessController["hasFeature"];
  id?: ControllerIdentity;
  // Merged over a silent log, so an arm names only the channel it reads and hears nothing from the rest.
  log?: Partial<HomebridgePluginLogging>;
  login?: () => Promise<AccessLoginOutcome>;
  mqtt?: TestMqttClient;
  mqttPublish?: AccessController["mqttPublish"];
  name?: string;
  platform?: AccessPlatform;
  reclaimClaims?: () => MembershipClaims | undefined;
  reclaimKeys?: ControllerOwnershipKeys;
  resolveDeviceModel?: (device: AccessStateDevice) => string;
  signal?: AbortSignal;
  spawnLoop?: (title: string, loop: () => Promise<void>) => void;
}

/* Stand up the controller as a device or the platform reads it: every member the plugin reads, defaulted, with each derived member deriving from the same resolved
 * one the real controller derives it from - the identity comes from the same policy function the real controller answers by, so a double an arm gives no identity
 * to answers by its configured address exactly as a controller reached with an API token alone does, and the ownership key answers the reclaim keys. An arm's
 * override always wins, so an arm names the one fact its question is about and inherits the rest.
 *
 * Each double-typed dependency is widened once here, and the surface once at the return: the client, the event rail, and the broker are classes carrying
 * private state nothing structural satisfies, and so is the controller itself. Every cast this factory needs lives here and at no site that stands a
 * controller up.
 *
 * @param options - What the arm varies; see {@link ControllerDoubleOptions}.
 *
 * @returns The controller double, typed as the controller.
 */
export function makeControllerDouble(options: ControllerDoubleOptions = {}): AccessController {

  const config = options.config ?? { address: "1.2.3.4" };
  const id = options.id ?? controllerIdentity({ address: config.address });
  const mqtt = options.mqtt ?? null;
  const platform = options.platform ?? makePlatformDouble();
  const resolveDeviceModel = options.resolveDeviceModel ?? deviceModel;
  const surface: ControllerSurface = {

    client: { capabilities: { mode: "credential" }, connection: { isHealthy: true }, doorStates: new Map<string, AccessDoorStateEntry>(), official: null,
      on: (): Disposable => ({ [Symbol.dispose]: (): void => undefined }),
      state: { snapshot: (): unknown => ({ devices: new Map(), doors: new Map() }) }, transport: null,
      ...options.client } as unknown as AccessClient,
    config,
    events: { emitPacket: (): void => undefined, off: (): void => undefined, on: (): void => undefined, ...options.events } as unknown as AccessEvents,
    getDeviceName: options.getDeviceName ?? ((): string => "Test Hub [UA Hub]"),
    hasFeature: options.hasFeature ?? ((option: string, device?: DecoratedSerial): boolean => platform.featureOptions.test(option, device, id)),
    id,
    log: { ...silentLog(), ...options.log },
    login: options.login ?? (async (): Promise<AccessLoginOutcome> => "reporting"),
    mqtt: mqtt as unknown as Nullable<MqttClient>,
    mqttPublish: options.mqttPublish ?? ((topic, payload, init): void => mqtt?.publishGuarded(topic, payload, init)),
    name: options.name ?? "Test Controller",
    ownershipKey: config.address,
    platform,
    reclaimClaims: options.reclaimClaims ?? ((): MembershipClaims | undefined => undefined),
    reclaimKeys: options.reclaimKeys ?? { currentKey: config.address, priorKey: undefined },
    resolveDeviceModel,
    signal: options.signal ?? new AbortController().signal,
    spawnLoop: options.spawnLoop ?? ((): void => undefined)
  };

  return surface as unknown as AccessController;
}
