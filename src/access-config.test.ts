/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-config.test.ts: The webUI's per-controller legacy-settings migration and its configuration interpreters, exercised against the REAL feature-option engine
 * and the REAL served catalog, so the pins bind to the same grammar the plugin's runtime resolves against rather than to a stand-in that could drift from either.
 *
 * A controllers[] item key deletes by OMISSION from the successor the migration rebuilds, never by being carried as an explicitly undefined value, so what gets
 * asserted throughout is a key's ABSENCE from the rebuilt item rather than a comparison against undefined.
 *
 * Post-migration state resolves through the engine's own instruments rather than by matching entry strings, so a pin binds to the option grammar instead of to one
 * spelling of it. The closing round trip goes further and drives the plugin's actual MQTT resolution before and after the patch applies, which is what proves a
 * migrated configuration runs on the same effective values the legacy one did.
 */
import type { AccessConfig, AccessConfigPatch, AccessControllerConfig } from "../homebridge-ui/public/access-config.mjs";
import { CONTROLLER_KEYS, classifyProbeResponse, controllersAwaitingMigration, hasValidIdentity, makeAccessConfig, withControllerSaved, withPrimaryIdentity }
  from "../homebridge-ui/public/access-config.mjs";
import { FeatureOptions, buildCatalogIndex, enumerateConfiguredEntries } from "homebridge-plugin-utils";
import { featureOptionCategories, featureOptions } from "./access-options.ts";
import { ACCESS_MQTT_TOPIC } from "./settings.ts";
import type { AccessControllerOptions } from "./access-options.ts";
import assert from "node:assert/strict";
import { composeConnectIdentity } from "./access-policy.ts";
import { mqttConnectionSettings } from "./access-mqtt.ts";
import test from "node:test";

// The controller these pins migrate, a sibling that proves one controller's entries never answer for another, and a device beneath the first for the scope corner.
const CONTROLLER_MAC = "AABBCCDDEEFF";
const OTHER_MAC = "112233445566";
const DEVICE_MAC = "0123456789AB";

// The identity a configured controller converges to, and the address the configuration records - which is all a configuration has, since only a controller that
// answers a probe can supply the MAC address its settings are keyed by.
const ADDRESS = "10.0.0.1";
const TOKEN = "an-access-console-api-token";
const TOKENS = { access: TOKEN };
const CREDENTIALS = { address: ADDRESS, password: "correct horse battery", username: "access@example.com" };

// The legacy values these pins carry, each deliberately different from its option's registered default.
const LEGACY_BROKER = "mqtt://127.0.0.1:1883";
const LEGACY_TOPIC = "home/access";

// The MAC address the wiring resolves for our controller when it answers, and the empty map standing for a pass where nothing did.
const RESOLVED = new Map([[ ADDRESS, CONTROLLER_MAC ]]);
const UNRESOLVED = new Map<string, string>();

// The catalog index the webUI hands the interpreters, built from the real served catalog exactly as the browser builds it.
const catalog = buildCatalogIndex(featureOptionCategories, featureOptions);

// The interpreters under test, built exactly the way the webUI builds them: the real engine class, the real catalog index, and the framework's own entry enumerator.
const accessConfig = makeAccessConfig({ FeatureOptions, catalog, enumerateConfiguredEntries });

// The configuration shapes these pins build. The module's own declaration types every property as unknown, which is the honest shape of a hand-editable config
// file...narrowing the fields the pins read back keeps the assertions free of casts without weakening anything the interpreters are handed.
type TestConfig = AccessConfig & { controllers?: AccessControllerConfig[]; options?: string[] };

// A feature-option engine over the real catalog and the supplied entries, which is how every post-migration assertion here resolves an option.
function engineWith(options: string[] = []): FeatureOptions {

  return new FeatureOptions(featureOptionCategories, featureOptions, options);
}

// One configured entry, composed through the engine's own setOption rather than hand-typed, so a pin that starts from an existing entry starts from the canonical
// form the engine itself would have written.
function composedEntry(args: { enabled: boolean; id?: string; option: string; value?: string }): string {

  const engine = engineWith();

  engine.setOption(args);

  const [entry] = engine.configuredOptions;

  assert.ok(entry, "setting an option on a fresh engine should compose exactly one entry");

  return entry;
}

// The session's shallow-merge commit, in the one line these pins need of it: the controllers array and the options array each replace wholesale.
function applyPatch(config: TestConfig, patch: AccessConfigPatch): TestConfig {

  return { ...config, ...patch };
}

// The patch a configuration migrates to, asserted to exist so each pin below reads a patch rather than a nullable one.
function migrated(config: TestConfig, macByAddress: ReadonlyMap<string, string> = UNRESOLVED): AccessConfigPatch {

  const patch = accessConfig.migrate(config, macByAddress);

  assert.ok(patch, "the configuration should have produced a migration patch");

  return patch;
}

test("a reachable controller's settings land at controller scope while its item slims to the allowlist", () => {

  const controller = { ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, region: "us-east" };
  const patch = migrated({ controllers: [controller] }, RESOLVED);
  const engine = engineWith(patch.options);
  const item = patch.controllers?.[0] ?? {};

  assert.deepEqual(item, CREDENTIALS, "the successor carries exactly the allowlisted keys the item held");

  for(const key of [ "mqttTopic", "mqttUrl" ]) {

    assert.ok(!Object.hasOwn(item, key), key + " leaves by omission, because the runtime's own fallback would still read a copy that forgot to remove it");
  }

  assert.ok(!Object.hasOwn(item, "region"), "an unknown key a hand-edit left behind leaves the same way a consumed one does");
  assert.equal(engine.value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER, "the broker resolves at the controller's own scope");
  assert.equal(engine.value("Mqtt.Topic", undefined, CONTROLLER_MAC), LEGACY_TOPIC, "the topic resolves at the controller's own scope");
});

test("an API token survives the rebuild", () => {

  const patch = migrated({ controllers: [{ ...CREDENTIALS, mqttUrl: LEGACY_BROKER, tokens: TOKENS }] }, RESOLVED);

  assert.deepEqual(patch.controllers?.[0]?.tokens, TOKENS, "a rebuild that carried only the credentials would silently sign the user out of the official API");
});

test("a TLS verification preference survives the rebuild", () => {

  const patch = migrated({ controllers: [{ ...CREDENTIALS, mqttUrl: LEGACY_BROKER, verifyTls: true }] }, RESOLVED);

  assert.equal(patch.controllers?.[0]?.verifyTls, true, "TLS verification is a connection-establishment fact, so losing it changes how the plugin connects");
});

test("a per-controller display name survives the rebuild", () => {

  const patch = migrated({ controllers: [{ ...CREDENTIALS, mqttUrl: LEGACY_BROKER, name: "Front Gate" }] }, RESOLVED);

  assert.equal(patch.controllers?.[0]?.name, "Front Gate", "the log-prefix name is the user's own choice and nothing about this migration retires it");
});

test("the controller allowlist accounts for every property the controller options type declares", () => {

  /* The compile-time half of this pin, read in both directions, is the pair of annotated assignments below - the runtime assertions after them only name what the
   * annotations already enforce. The first proves every allowlisted key is a property AccessControllerOptions declares. The second proves the only properties the
   * allowlist omits are the two that migrate, so a controller property added to the type without joining the allowlist fails this file's typecheck rather than
   * being silently dropped from every rebuilt item at runtime.
   */
  const anyControllerKey = (): keyof AccessControllerOptions => "address";
  const allowlisted: readonly Exclude<keyof AccessControllerOptions, "mqttTopic" | "mqttUrl">[] = CONTROLLER_KEYS;
  const accountedFor: (typeof CONTROLLER_KEYS)[number] | "mqttTopic" | "mqttUrl" = anyControllerKey();

  assert.deepEqual([...allowlisted].sort(), [ "address", "name", "password", "tokens", "username", "verifyTls" ],
    "the allowlist is exactly the controller properties that stay in the configuration file");
  assert.equal(typeof accountedFor, "string", "every property the controller options type declares is either allowlisted or one of the migrating pair");
});

test("an unreachable controller keeps its legacy settings while a sibling converges, and is still named as awaiting migration", () => {

  const sibling = { address: "10.0.0.2", mqttUrl: LEGACY_BROKER, password: "sibling secret", username: "sibling@example.com" };
  const config: TestConfig = { controllers: [ { ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, sibling ] };
  const patch = migrated(config, RESOLVED);
  const item = patch.controllers?.[1] ?? {};

  assert.deepEqual(item, sibling, "the per-controller keys carry forward unchanged, because there is no MAC address for them to land against");
  assert.equal(engineWith(patch.options).value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER, "while the controller that did answer converged");
  assert.deepEqual(controllersAwaitingMigration(applyPatch(config, patch)).map((entry) => entry.address), ["10.0.0.2"],
    "the unresolved item is still named as awaiting migration, so a later open retries rather than silently abandoning it");
});

test("a token-only controller is never probed for migration, and nothing composes for it", () => {

  const config: TestConfig = { controllers: [{ address: ADDRESS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, tokens: TOKENS }] };

  assert.deepEqual(controllersAwaitingMigration(config), [],
    "a token never reaches the document a MAC address comes from, so probing this item would never resolve and would repeat on every open");

  // The pass runs the way the wiring runs it: only the controllers the probe list named can contribute a resolved MAC address, so an item nobody asked about has
  // nothing for its settings to land against. Handing the migration a map it could never have been given would pin a scenario that cannot occur.
  const probed = new Map(controllersAwaitingMigration(config).map((entry) => [ entry.address as string, CONTROLLER_MAC ]));

  assert.equal(accessConfig.migrate(config, probed), null,
    "with no MAC address resolved there is nothing to compose and nothing to rewrite, so the pass stages no patch at all and converges on the spot");
  assert.deepEqual(config.controllers?.[0], { address: ADDRESS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, tokens: TOKENS },
    "the legacy properties stay live, which is what keeps the runtime's own fallback answering for this controller");
});

test("a partial credential pair is never probed either, with or without a token beside it", () => {

  for(const identity of [ { username: CREDENTIALS.username }, { password: CREDENTIALS.password }, { tokens: TOKENS, username: CREDENTIALS.username } ]) {

    assert.deepEqual(controllersAwaitingMigration({ controllers: [{ address: ADDRESS, mqttUrl: LEGACY_BROKER, ...identity }] }), [],
      "an identity the plugin's own gate rejects would be rejected on every probe, so it never converges and is never asked");
  }

  assert.deepEqual(controllersAwaitingMigration({ controllers: [{ ...CREDENTIALS, mqttUrl: LEGACY_BROKER, tokens: TOKENS }] }).map((entry) => entry.address),
    [ADDRESS], "a token BESIDE a complete pair resolves a MAC exactly like any other item, so excluding it would strand a resolvable controller forever");
});

test("a topic equal to the registered default composes nothing, while the broker beside it composes", () => {

  const patch = migrated({ controllers: [{ ...CREDENTIALS, mqttTopic: ACCESS_MQTT_TOPIC, mqttUrl: LEGACY_BROKER }] }, RESOLVED);
  const engine = engineWith(patch.options);

  assert.equal(engine.scope("Mqtt.Topic", undefined, CONTROLLER_MAC), "none",
    "Mqtt.Topic is on by default and already answers this exact value unconfigured, so restating it would manufacture configuration out of nothing");
  assert.equal(engine.value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER, "the broker is off by default, so its value is an active choice and composes");
  assert.ok(!Object.hasOwn(patch.controllers?.[0] ?? {}, "mqttTopic"), "the property leaves the item either way, composed or not");
});

test("an entry already answering a controller's read outranks the property, and a sibling's entry never answers for it", () => {

  const own = composedEntry({ enabled: true, id: CONTROLLER_MAC, option: "Mqtt.Url", value: "mqtt://configured:1883" });
  const sibling = composedEntry({ enabled: true, id: OTHER_MAC, option: "Mqtt.Topic", value: "sibling/access" });
  const patch = migrated({ controllers: [{ ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }], options: [ own, sibling ] }, RESOLVED);
  const engine = engineWith(patch.options);

  assert.equal(engine.value("Mqtt.Url", undefined, CONTROLLER_MAC), "mqtt://configured:1883", "the entry that already answers this controller's read stands");
  assert.equal(engine.value("Mqtt.Topic", undefined, CONTROLLER_MAC), LEGACY_TOPIC, "a sibling's entry answers only for that sibling, so this topic still composes");
  assert.equal(engine.value("Mqtt.Topic", undefined, OTHER_MAC), "sibling/access", "and the sibling's own entry comes through untouched");
  assert.deepEqual(patch.controllers?.[0], CREDENTIALS, "the item slims either way: a property whose option was already configured still leaves");
});

test("a migrated configuration converges, and one that never carried a legacy setting has nothing to do", () => {

  const config: TestConfig = { controllers: [{ ...CREDENTIALS, mqttUrl: LEGACY_BROKER, name: "Front Gate", tokens: TOKENS }] };
  const converged = applyPatch(config, migrated(config, RESOLVED));

  assert.equal(accessConfig.migrate(converged, RESOLVED), null, "a second pass over the migrated configuration finds nothing left to do");
  assert.deepEqual(controllersAwaitingMigration(converged), [], "and nothing is left for the wiring to probe");
  assert.equal(accessConfig.migrate({ controllers: [CREDENTIALS] }), null,
    "a configuration that never carried a legacy setting answers null, and needs no resolved MAC address to say so");
});

test("a substrate we cannot parse declines the whole pass, while an absent one does not", () => {

  assert.equal(accessConfig.migrate(undefined), null, "an absent configuration has nothing to migrate");
  assert.equal(accessConfig.migrate({ controllers: [{ ...CREDENTIALS, mqttUrl: LEGACY_BROKER }], options: "nonsense" }, RESOLVED), null,
    "an options field that is present but is not an array declines the pass");
  assert.equal(accessConfig.migrate({ controllers: "nonsense" }, RESOLVED), null, "a controllers field that is present but is not an array declines it too");
  assert.deepEqual(controllersAwaitingMigration({ controllers: "nonsense" }), [], "and the probe list answers empty rather than throwing on the same substrate");
  assert.equal(accessConfig.migrate({}, RESOLVED), null, "a configuration with no controllers key at all is a valid absence with nothing to rewrite");
});

test("the identity predicate answers every identity form the plugin admits", () => {

  assert.equal(hasValidIdentity({ tokens: TOKENS }), true, "a token on its own is an identity");
  assert.equal(hasValidIdentity({ password: CREDENTIALS.password, username: CREDENTIALS.username }), true, "so is a complete credential pair");
  assert.equal(hasValidIdentity({ password: CREDENTIALS.password, tokens: TOKENS, username: CREDENTIALS.username }), true, "and so is both together");
  assert.equal(hasValidIdentity({ username: CREDENTIALS.username }), false, "half a pair describes no way of authenticating");
  assert.equal(hasValidIdentity({ password: CREDENTIALS.password }), false, "in either direction");
  assert.equal(hasValidIdentity({ tokens: TOKENS, username: CREDENTIALS.username }), false,
    "and a half pair is rejected before the token is ever considered, so a token beside it does not rescue it");
  assert.equal(hasValidIdentity({}), false, "an item carrying nothing at all is not an identity");
  assert.equal(hasValidIdentity(undefined), false, "nor is an absent item");
  assert.equal(hasValidIdentity({ tokens: {} }), false, "a tokens object carrying nothing reads exactly as an absent one, which a hand-edit can produce either way");
});

test("the browser identity predicate agrees with the plugin's own composition on every form", () => {

  const forms = [

    {},
    { tokens: {} },
    { tokens: TOKENS },
    { password: CREDENTIALS.password },
    { username: CREDENTIALS.username },
    { password: CREDENTIALS.password, tokens: TOKENS },
    { tokens: TOKENS, username: CREDENTIALS.username },
    { password: CREDENTIALS.password, username: CREDENTIALS.username },
    { password: CREDENTIALS.password, tokens: TOKENS, username: CREDENTIALS.username }
  ];

  for(const form of forms) {

    assert.equal(hasValidIdentity(form), composeConnectIdentity(form).error === undefined,
      "the browser statement and the policy statement must answer the same question the same way for " + JSON.stringify(form));
  }
});

test("the probe verdict reads all three response kinds and refuses a shape the server never writes", () => {

  const devices = [{ name: "Front Door" }];

  assert.deepEqual(classifyProbeResponse({ devices, kind: "connected" }), { devices, kind: "connected", message: "" },
    "a credentialed connect answers its device list");
  assert.deepEqual(classifyProbeResponse({ devices, kind: "token-only" }), { devices, kind: "token-only", message: "" },
    "a token-only connect answers the official inventory, so its devices reach the page exactly as a credentialed connect's do");
  assert.equal(classifyProbeResponse({ devices: [], kind: "token-only" }).kind, "token-only",
    "and a token-only controller with nothing adopted is still a success rather than a failure");
  assert.deepEqual(classifyProbeResponse({ kind: "error", message: "Invalid credentials." }), { devices: [], kind: "error", message: "Invalid credentials." },
    "a failure carries the controller's own reason back with it");

  for(const malformed of [ undefined, {}, { kind: "connected" }, { kind: "token-only" }, { kind: "nonsense" }, "a string" ]) {

    assert.equal(classifyProbeResponse(malformed).kind, "error", "a response in a shape the server never writes reads as a failure rather than an empty page");
  }
});

test("a credential edit carries every other key the item holds", () => {

  const item = { ...CREDENTIALS, mqttUrl: LEGACY_BROKER, name: "Front Gate", tokens: TOKENS, verifyTls: true };
  const patch = withControllerSaved({ controllers: [item] },
    { address: ADDRESS, originalAddress: ADDRESS, password: "new secret", tokens: TOKENS, username: CREDENTIALS.username, verifyTls: true });

  assert.deepEqual(patch.controllers[0], { ...item, password: "new secret" },
    "an un-migrated controller still owns settings the plugin runs on, and only the migration retires those");
});

test("an edit clearing an identity field deletes it rather than storing it empty", () => {

  const patch = withControllerSaved({ controllers: [{ ...CREDENTIALS, tokens: TOKENS, verifyTls: true }] },
    { address: ADDRESS, originalAddress: ADDRESS, password: CREDENTIALS.password, tokens: { access: "" }, username: CREDENTIALS.username, verifyTls: false });

  assert.deepEqual(patch.controllers[0], CREDENTIALS, "a cleared field reads exactly as an absent one everywhere the configuration is consulted");
});

test("a save that carries no token writes no tokens member at all, in every shape an editor can hand it one", () => {

  /* The card composes a tokens object from whatever its field holds, and a hand-edited item can arrive carrying an empty object or none. Each shape below describes
   * the same thing - no token - and each has to leave the same way, because an item carrying an empty object would read as a token to anything that tested the
   * member's presence rather than its contents.
   */
  for(const tokens of [ undefined, {}, { access: "" } ]) {

    const item = withControllerSaved({ controllers: [{ ...CREDENTIALS, tokens: TOKENS }] },
      { address: ADDRESS, originalAddress: ADDRESS, password: CREDENTIALS.password, tokens, username: CREDENTIALS.username }).controllers[0] ?? {};

    assert.ok(!Object.hasOwn(item, "tokens"), "the tokens member deletes by omission for " + JSON.stringify(tokens ?? null) + " rather than being written empty");
    assert.deepEqual(item, CREDENTIALS, "and what is left is the item exactly as it reads with no token configured");
  }
});

test("an address change edits that item rather than adding a second one beside it, and an add appends", () => {

  const moved = withControllerSaved({ controllers: [{ ...CREDENTIALS }] },
    { address: "10.0.0.9", originalAddress: ADDRESS, password: CREDENTIALS.password, username: CREDENTIALS.username });

  assert.equal(moved.controllers.length, 1, "the address the write started from is what finds the item, so a changed address replaces rather than duplicates");
  assert.deepEqual(moved.controllers[0], { ...CREDENTIALS, address: "10.0.0.9" }, "and the item now carries the new address");

  const added = { address: "10.0.0.9", tokens: TOKENS };

  assert.deepEqual(withControllerSaved({ controllers: [{ ...CREDENTIALS }] }, added).controllers, [ CREDENTIALS, added ],
    "an absent original address is what makes a write an add");
  assert.deepEqual(withControllerSaved({ controllers: [{ ...CREDENTIALS }] }, { ...added, originalAddress: "10.0.0.250" }).controllers, [ CREDENTIALS, added ],
    "and an original address matching no item falls back to the same append rather than writing nothing");
});

test("the first-run save composes a complete identity as one patch and composes nothing for an incomplete one", () => {

  assert.deepEqual(withPrimaryIdentity({}, { address: ADDRESS, tokens: TOKENS })?.controllers, [{ address: ADDRESS, tokens: TOKENS }],
    "a token-only identity is a complete one, and lands on the primary controller of a fresh configuration");
  assert.deepEqual(withPrimaryIdentity({ controllers: [ { ...CREDENTIALS }, { address: "10.0.0.2", tokens: TOKENS } ] },
    { ...CREDENTIALS, password: "new secret" })?.controllers?.[1], { address: "10.0.0.2", tokens: TOKENS }, "every additional controller is preserved");
  assert.equal(withPrimaryIdentity({}, { address: ADDRESS, username: CREDENTIALS.username }), null, "half a credential pair composes nothing at all");
  assert.equal(withPrimaryIdentity({}, { tokens: TOKENS }), null, "and neither does an identity with nowhere to connect to");
  assert.equal(withPrimaryIdentity({}, { address: ADDRESS, tokens: {} }), null, "and an empty tokens object is no identity either, on the predicate's own reading");
});

test("removal drops the item its address names, and an empty MAC set leaves the configured options untouched", () => {

  const other = { address: "10.0.0.2", tokens: TOKENS };
  const patch = accessConfig.withControllerRemoved({ controllers: [ { ...CREDENTIALS }, other ], options: ["Enable.Log.Lock." + CONTROLLER_MAC] },
    { address: ADDRESS });

  assert.deepEqual(patch.controllers, [other], "the item the address names is gone and every other item stands");
  assert.ok(!Object.hasOwn(patch, "options"),
    "with no MAC set there is no sweep, and carrying no options array at all is what leaves every configured entry exactly where it was");
});

test("the sweep strips every spelling the framework's own enumerator resolves to a swept MAC", () => {

  /* Each form below is first proven to address a MAC scope through the engine itself, so these pins bind to the parser's grammar rather than to a reading of it:
   * the bare enable and the bare disable, the canonical entry whose value rides behind the payload delimiter, and the legacy dot spelling the parser still accepts
   * from configurations hand-authored before that delimiter existed.
   */
  const bareDisable = "Disable.Log.Lock." + DEVICE_MAC;
  const bareEnable = "Enable.Log.Lock." + CONTROLLER_MAC;
  const legacyPayload = "Enable.Mqtt.Topic." + CONTROLLER_MAC + "." + LEGACY_TOPIC;
  const lowerCased = "enable.mqtt.url." + CONTROLLER_MAC.toLowerCase() + "=" + LEGACY_BROKER;

  assert.equal(engineWith([bareEnable]).test("Log.Lock", undefined, CONTROLLER_MAC), true, "the bare enable addresses the controller's own scope");
  assert.equal(engineWith([bareDisable]).test("Log.Lock", DEVICE_MAC, CONTROLLER_MAC), false, "the bare disable addresses the device's own scope");
  assert.equal(engineWith([lowerCased]).value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER, "an entry's casing says nothing about the scope it names");
  assert.equal(engineWith([legacyPayload]).value("Mqtt.Topic", undefined, CONTROLLER_MAC), LEGACY_TOPIC, "and the legacy dot spelling addresses it too");

  const options = [ bareDisable, bareEnable, legacyPayload, lowerCased ];
  const patch = accessConfig.withControllerRemoved({ controllers: [{ ...CREDENTIALS }], options }, { address: ADDRESS, macs: [ CONTROLLER_MAC, DEVICE_MAC ] });

  assert.deepEqual(patch.options, [], "every spelling that resolves to a swept MAC leaves with the controller it belonged to");
  assert.deepEqual(accessConfig.withControllerRemoved({ controllers: [{ ...CREDENTIALS }], options },
    { address: ADDRESS, macs: [ CONTROLLER_MAC.toLowerCase(), DEVICE_MAC.toLowerCase() ] }).options, [], "and the match is case-insensitive from either side");
});

test("an entry that does not address a swept scope survives the sweep", () => {

  // A scope is named by a whole segment of an entry's address. A MAC that is merely part of a longer segment, or that sits in the value behind the payload
  // delimiter, is text the entry carries rather than a scope it addresses, and a sibling controller's own entries are none of this removal's business.
  const survivors = [

    "Enable.Log.Lock",
    "Enable.Log.Lock." + OTHER_MAC,
    "Enable.Log.Lock." + CONTROLLER_MAC + "00",
    "Enable.Mqtt.Url=mqtt://" + CONTROLLER_MAC + ":1883",
    "Enable.Mqtt.Topic." + OTHER_MAC + "=access/" + DEVICE_MAC
  ];

  const patch = accessConfig.withControllerRemoved({ controllers: [{ ...CREDENTIALS }], options: [...survivors] },
    { address: ADDRESS, macs: [ CONTROLLER_MAC, DEVICE_MAC ] });

  assert.deepEqual(patch.options, survivors, "a global entry, a sibling's entry, and a MAC that names no scope all come through the sweep untouched");
});

test("every migrated setting resolves to the same effective broker and topic the legacy configuration ran on", () => {

  const config: TestConfig = { controllers: [{ ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }], options: [] };

  // The plugin's own MQTT resolution, driven here exactly as its call site drives it: option-first with the legacy controller properties behind it, which is what
  // makes the before and the after comparable at all.
  const resolve = (state: TestConfig): ReturnType<typeof mqttConnectionSettings> => {

    const controller = (state.controllers?.[0] ?? {}) as { mqttTopic?: string; mqttUrl?: string };

    return mqttConnectionSettings(engineWith(state.options), controller, CONTROLLER_MAC);
  };

  const before = resolve(config);

  assert.deepEqual(before, { brokerUrl: LEGACY_BROKER, topicPrefix: LEGACY_TOPIC },
    "the values being compared are the legacy configuration's own literals, not two matching blanks");

  const after = applyPatch(config, migrated(config, RESOLVED));

  assert.deepEqual(resolve(after), before, "the migrated configuration resolves the same broker and topic the plugin was already running on");

  /* And the mechanism the option surface buys: a controller-scoped disable turns the broker off outright, which the legacy property alone could never express.
   *
   * The disable is composed through the engine rather than appended to the array, because appending is not what turning an option off does: the lookup index takes
   * the FIRST entry that addresses a scope, so a disable sitting behind the enable the migration just wrote would be shadowed by it and change nothing. Driving
   * setOption is what the webUI's own editor does, and it replaces the entry rather than stacking a second one behind it.
   */
  const engine = engineWith([...(after.options ?? [])]);

  engine.setOption({ enabled: false, id: CONTROLLER_MAC, option: "Mqtt.Url" });

  assert.equal(resolve({ ...after, options: [...engine.configuredOptions] }), null, "a scoped disable on the migrated configuration leaves no broker at all");
});
