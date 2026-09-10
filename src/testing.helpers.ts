/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The fixture builders more than one suite reads - the topology documents, the configuration rows, the managed device records, and the
 * platform and controller doubles every suite stands its devices up over.
 *
 * Each export states one Access document or record shape, so every suite seeding that shape seeds the same one and a change to the shape is a change in one place.
 * A harness only one file reads stays in that file: the hub suite's real-HAP accessory, the device suite's write recorder, and the status feed's client stub are
 * instruments for one suite's questions rather than shared vocabulary, and moving them here would buy nothing.
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
import type { API, Logging } from "homebridge";
import type { AccessBootstrapConfig, AccessClient, AccessDeviceEntryConfig, AccessDoorStateEntry, AccessEventPacket, AccessStateDevice } from "unifi-access";
import type { AccessControllerOptions, AccessOptions } from "./options.ts";
import type { AccessEvents, AccessListener } from "./controller/events.ts";
import type { AccessLoginOutcome, ControllerOwnershipKeys, DecoratedSerial, MembershipClaims } from "./policy.ts";
import type { Clock, HomebridgePluginLogging, HttpListener, MqttClient, Nullable } from "homebridge-plugin-utils";
import { TestClock, silentLog } from "homebridge-plugin-utils/testing";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { AccessAccessory } from "./types.ts";
import type { AccessController } from "./controller/controller.ts";
import type { AccessPlatform } from "./platform.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import type { TestMqttClient } from "homebridge-plugin-utils/testing";
import { deviceModel } from "./policy.ts";

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
type PlatformSurface = Pick<AccessPlatform, "accessories" | "api" | "clock" | "config" | "featureOptions" | "localAddressFor" | "log" | "registerAccessory" |
  "signal" | "unregisterAccessory" | "webhookListener" | "webhookPort">;

/* The Homebridge api members the plugin reads, each optional because an arm supplies only the ones its path reaches: the HAP namespace and the accessory class are
 * whatever the arm hands over (a real class, a string stub), and the accessory calls are recorders or no-ops.
 */
export interface PlatformApiDouble {

  hap?: unknown;
  on?: (event: string, handler: () => void) => void;
  platformAccessory?: unknown;
  registerPlatformAccessories?: (pluginName: string, platformName: string, accessories: AccessAccessory[]) => void;
  unregisterPlatformAccessories?: (pluginName: string, platformName: string, accessories: AccessAccessory[]) => void;
  updatePlatformAccessories?: (accessories?: AccessAccessory[]) => void;
}

// What an arm varies about the platform it stands up. Every member has a default, so an arm names only what it reads or records.
export interface PlatformDoubleOptions {

  accessories?: AccessAccessory[];
  api?: PlatformApiDouble;
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
 * and the same list the real ones do. The one cast lives here, stated once: the platform class carries private fields nothing structural can satisfy, so a double
 * typed against the members the plugin reads is widened to the class at this boundary and nowhere else.
 *
 * @param options - What the arm varies; see {@link PlatformDoubleOptions}.
 *
 * @returns The platform double, typed as the platform.
 */
export function makePlatformDouble(options: PlatformDoubleOptions = {}): AccessPlatform {

  const accessories = options.accessories ?? [];
  const api = options.api ?? {};
  const surface: PlatformSurface = {

    accessories,
    api: api as unknown as API,
    clock: options.clock ?? new TestClock(),
    config: options.config ?? { controllers: [], options: [] },
    featureOptions: options.featureOptions ?? new FeatureOptions(featureOptionCategories, featureOptions, options.entries ?? []),
    localAddressFor: options.localAddressFor ?? (async (): Promise<string> => "10.0.0.7"),
    log: (options.log ?? { error: (): void => undefined, info: (): void => undefined, warn: (): void => undefined }) as Logging,
    registerAccessory: (accessory: AccessAccessory): void => {

      api.registerPlatformAccessories?.(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      accessories.push(accessory);
      api.updatePlatformAccessories?.(accessories);
    },
    signal: options.signal ?? new AbortController().signal,
    unregisterAccessory: (accessory: AccessAccessory): void => {

      const index = accessories.indexOf(accessory);

      if(index < 0) {

        return;
      }

      api.unregisterPlatformAccessories?.(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      accessories.splice(index, 1);
      api.updatePlatformAccessories?.(accessories);
    },
    webhookListener: options.webhookListener ?? ((): HttpListener => {

      throw new Error("This platform double carries no webhook listener.");
    }),
    webhookPort: options.webhookPort ?? ACCESS_WEBHOOK_PORT
  };

  return surface as unknown as AccessPlatform;
}

// The controller double.

/* The controller members the plugin reads, which is what a double has to carry and all a double has to carry. The list is the receipt of a grep over the plugin's
 * reads of its controller, so a member the plugin starts reading enters here by the same grep, and a double missing a listed member is a compile error in this one
 * place rather than a silent fallback at every site that stands one up.
 */
type ControllerSurface = Pick<AccessController, "client" | "config" | "events" | "getDeviceName" | "hasFeature" | "id" | "log" | "login" | "mqtt" | "mqttIdentity" |
  "mqttPublish" | "name" | "ownershipKey" | "platform" | "reclaimClaims" | "reclaimKeys" | "resolveDeviceModel" | "signal" | "spawnLoop">;

/* The client members the plugin reads, each optional because an arm supplies only the ones its path reaches: the official surface and the transport are whatever the
 * arm hands over, the connection and the state answer what a device composes its own availability and membership from, and the subscription is a disposable.
 */
export interface ControllerClientDouble {

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
  id?: DecoratedSerial;
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
 * one the real controller derives it from - the identity and the configured address answer the MQTT identity and the ownership key, and the ownership key answers
 * the reclaim keys. An arm's override always wins, so an arm names the one fact its question is about and inherits the rest.
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
  const id = options.id;
  const mqtt = options.mqtt ?? null;
  const platform = options.platform ?? makePlatformDouble();
  const resolveDeviceModel = options.resolveDeviceModel ?? deviceModel;
  const surface: ControllerSurface = {

    client: { connection: { isHealthy: true }, doorStates: new Map<string, AccessDoorStateEntry>(), official: null,
      on: (): Disposable => ({ [Symbol.dispose]: (): void => undefined }),
      state: { snapshot: (): unknown => ({ devices: new Map(), doors: new Map() }) }, transport: null,
      ...options.client } as unknown as AccessClient,
    config,
    events: { emitPacket: (): void => undefined, off: (): void => undefined, on: (): void => undefined, ...options.events } as unknown as AccessEvents,
    getDeviceName: options.getDeviceName ?? ((): string => "Test Hub [UA Hub]"),
    hasFeature: options.hasFeature ?? ((option: string, device?: DecoratedSerial): boolean => platform.featureOptions.test(option, device ?? id, id)),
    id,
    log: { ...silentLog(), ...options.log },
    login: options.login ?? (async (): Promise<AccessLoginOutcome> => "reporting"),
    mqtt: mqtt as unknown as Nullable<MqttClient>,
    mqttIdentity: id ?? config.address,
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
