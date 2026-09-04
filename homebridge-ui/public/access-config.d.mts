/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-config.d.mts: Type declarations for the pure Access platform-configuration interpreters.
 */
import type { CatalogIndex, FeatureOptions, enumerateConfiguredEntries } from "homebridge-plugin-utils";

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
 * The UI server's device probe, read into the one verdict every consumer branches on. `kind` is the outcome, `devices` is the list either success answered with -
 * the topology's devices led by the controller itself, or the official API's adopted inventory - and `message` is the user-facing failure text, empty on a success.
 */
export interface AccessProbeVerdict {

  devices: Record<string, unknown>[];
  kind: "connected" | "error" | "token-only";
  message: string;
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
 * The interpreters that need the served catalog.
 */
export interface AccessConfigInterpreter {

  migrate(config?: AccessConfig, macByAddress?: ReadonlyMap<string, string>): AccessConfigPatch | null;
  withControllerRemoved(config: AccessConfig | undefined, removal: { address: unknown; macs?: readonly string[] }): AccessConfigPatch;
}

/** The keys a controllers[] item converges to - every controller property except the two that migrate into feature options. */
export declare const CONTROLLER_KEYS: readonly [ "address", "name", "password", "tokens", "username", "verifyTls" ];

/** Read the UI server's kind-tagged device probe into the verdict every consumer branches on. */
export declare const classifyProbeResponse: (response?: unknown) => AccessProbeVerdict;

/** The configured controllers, normalized so callers never branch on undefined. */
export declare const controllers: (config?: AccessConfig) => AccessControllerConfig[];

/** The configured controllers still carrying a per-controller legacy property that a probe could resolve a MAC address for. */
export declare const controllersAwaitingMigration: (config?: AccessConfig) => AccessIdentity[];

/** Whether a controller item describes an identity the plugin can connect with, mirroring composeConnectIdentity's verdict exactly. */
export declare const hasValidIdentity: (controller?: AccessIdentity) => boolean;

/**
 * Build the interpreters that need the served catalog over an injected feature-option engine class, the catalog index, and the framework's entry enumerator.
 *
 * @param injected.FeatureOptions             - The feature-option engine class.
 * @param injected.catalog                    - The catalog index, which carries the served categories and options alongside its derived indices.
 * @param injected.enumerateConfiguredEntries - The framework's own enumerator over the configured entries addressing one option.
 *
 * @returns The migration and the controller removal.
 */
export declare const makeAccessConfig: ({ FeatureOptions, catalog, enumerateConfiguredEntries }:
  { FeatureOptions: typeof FeatureOptions; catalog: CatalogIndex; enumerateConfiguredEntries: typeof enumerateConfiguredEntries }) => AccessConfigInterpreter;

/** The primary controller entry (the first), or undefined on a fresh configuration. */
export declare const primaryController: (config?: AccessConfig) => AccessControllerConfig | undefined;

/**
 * The controllers patch that writes one controller's identity. An `originalAddress` naming a configured item rewrites that item while carrying every other key it
 * holds; an absent or unmatched one appends a new item instead.
 */
export declare const withControllerSaved: (config: AccessConfig | undefined, controller: AccessIdentity & { originalAddress?: unknown }) =>
  { controllers: AccessControllerConfig[] };

/** The controllers patch that writes an identity onto the primary controller, or null when the identity is not one the plugin can connect with. */
export declare const withPrimaryIdentity: (config: AccessConfig | undefined, identity: AccessIdentity) => { controllers: AccessControllerConfig[] } | null;
