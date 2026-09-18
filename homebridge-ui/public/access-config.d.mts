/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-config.d.mts: Type declarations for the pure Access platform-configuration interpreters.
 */
import type { CatalogIndex, FeatureOptions, buildCatalogIndex, enumerateConfiguredEntries, enumerateScopeEntries, formatValueList,
  scopeSafeId } from "homebridge-plugin-utils";

/**
 * One configured controller, as it actually arrives from the Homebridge UI. Every property is declared as an unknown-valued optional because that is the honest shape
 * of an object read back from a user's `config.json`: a property may be absent, may carry a hand-edited value of any type, and may be a retired name no part of the
 * plugin reads any more. Interpreting exactly that is what the module is for.
 */
export interface AccessControllerConfig {

  [key: string]: unknown;
  address?: unknown;
  mqttTopic?: unknown;
  mqttUrl?: unknown;
  name?: unknown;
  password?: unknown;
  tokens?: unknown;
  username?: unknown;
  verifyTls?: unknown;
}

/**
 * The primary platform-configuration entry, on the same terms the controller shape above states: a user's `config.json` is free to carry anything at all under these
 * names, and telling an active choice apart from a hand-edit we decline to interpret is the migration's job rather than the type system's.
 */
export interface AccessConfig {

  controllers?: unknown;
  options?: unknown;
}

/**
 * The identity fields an editor writes onto a controller item, and the shape the identity predicate reads. The values stay unknown because they are carried straight
 * through from the configuration or from a form field without being validated: the UI server's own connect is what finds out whether they work.
 */
export interface AccessIdentity {

  address?: unknown;
  password?: unknown;
  tokens?: unknown;
  username?: unknown;
  verifyTls?: unknown;
}

/**
 * The UI server's device probe, read into the one verdict every consumer branches on. A success carries the list it answered with - the topology's devices led by
 * the controller itself, or the official API's adopted inventory - and an empty message; a failure carries no devices, the user-facing reason, the headline the
 * surfaces render it under, and a guidance line where the surfaces' own standing guidance would send the user after the wrong thing.
 */
export interface AccessProbeFailure {

  devices: Record<string, unknown>[];
  guidance?: string;
  headline: string;
  kind: "error";
  message: string;
}

export interface AccessProbeSuccess {

  devices: Record<string, unknown>[];
  kind: "connected" | "token-only";
  message: string;
}

export type AccessProbeVerdict = AccessProbeFailure | AccessProbeSuccess;

/**
 * A device-list outcome as the framework's hook contract carries it: the devices, the failure text (empty on a success), and only the copy members the outcome
 * carries - a failure's headline and its guidance.
 */
export interface AccessDeviceListResult {

  devices: Record<string, unknown>[];
  error: string;
  guidance?: string;
  headline?: string;
}

/**
 * The commit-shaped patch the migration produces. A consumed per-controller legacy property deletes by OMISSION from the freshly rebuilt successor, which is why no
 * per-item key appears here at all: the whole array is carried instead, and only when at least one item's successor differs from the item it replaces.
 */
export interface AccessConfigPatch {

  controllers?: AccessControllerConfig[];
  options?: string[];
}

/**
 * The interpreters that need the served catalog. Each is declared as a property carrying a function rather than as a method, which is what the module actually
 * builds - an object of arrow functions closed over the injected catalog - so a consumer is free to read one off the holder and call it on its own.
 */
export interface AccessConfigInterpreter {

  controllersAwaitingMigration: (config?: AccessConfig) => AccessIdentity[];
  migrate: (config?: AccessConfig, macByAddress?: ReadonlyMap<string, string>) => AccessConfigPatch | null;
  withControllerRemoved: (config: AccessConfig | undefined, removal: { address: unknown; macs?: readonly string[] }) => AccessConfigPatch;
  withControllerSaved: (config: AccessConfig | undefined, controller: AccessIdentity & { originalAddress?: unknown }) => AccessConfigPatch;
}

/** The headline a controller the plugin could not reach is rendered under. */
export declare const CONNECTION_FAILURE_HEADLINE: string;

/** The keys a controllers[] item converges to - every controller property except the ones that migrate into feature options. */
export declare const CONTROLLER_KEYS: readonly [ "address", "name", "password", "tokens", "username", "verifyTls" ];

/** What to do about a UI server answering in a shape it never writes. */
export declare const SERVER_FAILURE_GUIDANCE: string;

/** The headline a UI server answering in a shape it never writes is rendered under. */
export declare const SERVER_FAILURE_HEADLINE: string;

/** Read the UI server's kind-tagged device probe into the verdict every consumer branches on. */
export declare const classifyProbeResponse: (response?: unknown) => AccessProbeVerdict;

/** The configured controllers, normalized so callers never branch on undefined. */
export declare const controllers: (config?: AccessConfig) => AccessControllerConfig[];

/** Map a probe verdict onto the device list and connection outcome the framework's hook contract carries, with each outcome's own copy beside it. */
export declare const deviceListResult: (verdict: AccessProbeVerdict) => AccessDeviceListResult;

/** Whether a controller item describes an identity the plugin can connect with, mirroring composeConnectIdentity's verdict exactly. */
export declare const hasValidIdentity: (controller?: AccessIdentity) => boolean;

/**
 * Build the interpreters that need the served catalog over an injected feature-option engine class, the catalog index, the framework's catalog builder, its two
 * entry enumerators, its list formatter, and its scope-identifier repair.
 *
 * @param injected.FeatureOptions             - The feature-option engine class.
 * @param injected.buildCatalogIndex          - The framework's catalog builder, which the retired-family composition builds its legacy catalog with.
 * @param injected.catalog                    - The catalog index, which carries the served categories and options alongside its derived indices.
 * @param injected.enumerateConfiguredEntries - The framework's own enumerator over the configured entries addressing one option.
 * @param injected.enumerateScopeEntries      - The framework's own enumerator over the configured entries reading at one scope identifier.
 * @param injected.formatValueList            - The framework's composition of a list option's stored form from its selected members.
 * @param injected.scopeSafeId                - The framework's repair of an arbitrary string into a scope identifier.
 *
 * @returns The migration, the awaiting-migration predicate, the controller save, and the controller removal.
 */
export declare const makeAccessConfig: (injected: { FeatureOptions: typeof FeatureOptions; buildCatalogIndex: typeof buildCatalogIndex; catalog: CatalogIndex;
  enumerateConfiguredEntries: typeof enumerateConfiguredEntries; enumerateScopeEntries: typeof enumerateScopeEntries;
  formatValueList: typeof formatValueList; scopeSafeId: typeof scopeSafeId }) => AccessConfigInterpreter;

/** The primary controller entry (the first), or undefined on a fresh configuration. */
export declare const primaryController: (config?: AccessConfig) => AccessControllerConfig | undefined;

/** The verdict of a sidebar entry whose controller left the configuration after the sidebar was built, fresh per call. */
export declare const staleSelectionVerdict: () => AccessProbeFailure;

/** The controllers patch that writes an identity onto the primary controller, or null when the identity is not one the plugin can connect with. */
export declare const withPrimaryIdentity: (config: AccessConfig | undefined, identity: AccessIdentity) => { controllers: AccessControllerConfig[] } | null;
