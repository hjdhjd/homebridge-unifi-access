/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-config.test.ts: The webUI's per-controller legacy-settings migration and its configuration interpreters, exercised against the REAL feature-option engine
 * and the REAL served catalog, so the assertions bind to the same grammar the plugin's runtime resolves against rather than to a stand-in that could drift from either.
 *
 * A controllers[] item key deletes by OMISSION from the successor the migration rebuilds, never by being carried as an explicitly undefined value, so what gets
 * asserted throughout is a key's ABSENCE from the rebuilt item rather than a comparison against undefined.
 *
 * Post-migration state resolves through the engine's own instruments rather than by matching entry strings, so an assertion binds to the option grammar instead of to one
 * spelling of it. The closing round trip goes further and drives the plugin's actual MQTT resolution before and after the patch applies, which is what proves a
 * migrated configuration runs on the same effective values the legacy one did.
 */
import { ALL_CHOICES, FeatureOptions, buildCatalogIndex, enumerateConfiguredEntries, enumerateScopeEntries, formatValueList, mqttConnectionSettings,
  normalizeConfiguredOptions, scopeSafeId } from "homebridge-plugin-utils";
import type { AccessConfig, AccessConfigPatch, AccessControllerConfig } from "../homebridge-ui/public/access-config.mjs";
import { CONNECTION_FAILURE_HEADLINE, CONTROLLER_KEYS, SERVER_FAILURE_GUIDANCE, SERVER_FAILURE_HEADLINE, classifyProbeResponse, deviceListResult,
  hasValidIdentity, makeAccessConfig, staleSelectionVerdict, withPrimaryIdentity } from "../homebridge-ui/public/access-config.mjs";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { ACCESS_MQTT_TOPIC } from "./settings.ts";
import type { AccessControllerOptions } from "./options.ts";
import assert from "node:assert/strict";
import { composeConnectIdentity } from "./policy.ts";
import test from "node:test";

// The controller these assertions migrate, a sibling that proves one controller's entries never answer for another, and a device beneath the first for the scope corner.
const CONTROLLER_MAC = "AABBCCDDEEFF";
const OTHER_MAC = "112233445566";
const DEVICE_MAC = "0123456789AB";

// The identity a configured controller converges to, and the address the configuration records - which is all a configuration has, since only a controller that
// answers a probe can supply the MAC address its settings are keyed by.
const ADDRESS = "10.0.0.1";
const TOKEN = "an-access-console-api-token";
const TOKENS = { access: TOKEN };
const CREDENTIALS = { address: ADDRESS, password: "correct horse battery", username: "access@example.com" };

// The legacy values these assertions carry, each deliberately different from its option's registered default.
const LEGACY_BROKER = "mqtt://127.0.0.1:1883";
const LEGACY_TOPIC = "home/access";

// The MAC address the wiring resolves for our controller when it answers, and the empty map standing for a pass where nothing did.
const RESOLVED = new Map([[ ADDRESS, CONTROLLER_MAC ]]);
const UNRESOLVED = new Map<string, string>();

/* The two addresses an address-keyed assertion works in, and the scope identity each answers by. The identity is the address with its periods repaired into
 * hyphens, which is the spelling the runtime keys a token-only controller's entries by, and it is spelled as a literal here rather than derived so an assertion
 * proves the spelling instead of agreeing with whatever the repair returns.
 */
const TOKEN_ADDRESS = "1.2.3.4";
const TOKEN_IDENTITY = "1-2-3-4";
const SECOND_ADDRESS = "5.6.7.8";
const SECOND_IDENTITY = "5-6-7-8";

// The value an address-keyed topic entry carries, distinct from every legacy value above so an assertion can tell which substrate answered.
const ADDRESS_TOPIC = "unifi/gate";

// The catalog index the webUI hands the interpreters, built from the real served catalog exactly as the browser builds it.
const catalog = buildCatalogIndex(featureOptionCategories, featureOptions);

// The interpreters under test, built exactly the way the webUI builds them: the real engine class, the real catalog index and the builder that makes one, the
// framework's own two entry enumerators, its list formatter, and its scope-identifier repair.
const accessConfig = makeAccessConfig({ FeatureOptions, buildCatalogIndex, catalog, enumerateConfiguredEntries, enumerateScopeEntries, formatValueList,
  scopeSafeId });

// The interpreters the suite reads off that holder, named here once so every arm below reads them as plain functions.
const { controllersAwaitingMigration, withControllerSaved } = accessConfig;

// The configuration shapes these tests build. The module's own declaration types every property as unknown, which is the honest shape of a hand-editable config
// file...narrowing the fields these tests read back keeps the assertions free of casts without weakening anything the interpreters are handed.
type TestConfig = AccessConfig & { controllers?: AccessControllerConfig[]; options?: string[] };

// A feature-option engine over the real catalog and the supplied entries, which is how every post-migration assertion here resolves an option.
function engineWith(options: string[] = []): FeatureOptions {

  return new FeatureOptions(featureOptionCategories, featureOptions, options);
}

// One configured entry, composed through the engine's own setOption rather than hand-typed, so an assertion that starts from an existing entry starts from the canonical
// form the engine itself would have written.
function composedEntry(args: { enabled: boolean; id?: string; option: string; value?: string }): string {

  const engine = engineWith();

  engine.setOption(args);

  const [entry] = engine.configuredOptions;

  assert.ok(entry, "setting an option on a fresh engine should compose exactly one entry");

  return entry;
}

// The session's shallow-merge commit, in the one line these assertions need of it: the controllers array and the options array each replace wholesale.
function applyPatch(config: TestConfig, patch: AccessConfigPatch): TestConfig {

  return { ...config, ...patch };
}

// The patch a configuration migrates to, asserted to exist so each check below reads a patch rather than a nullable one.
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

  /* The compile-time half of this check, read in both directions, is the pair of annotated assignments below - the runtime assertions after them only name what the
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
  // nothing for its settings to land against. Handing the migration a map it could never have been given would assert a scenario that cannot occur.
  const probed = new Map(controllersAwaitingMigration(config).map((entry) => [ entry.address as string, CONTROLLER_MAC ]));

  assert.equal(accessConfig.migrate(config, probed), null,
    "with no MAC address resolved there is nothing to compose and nothing to rewrite, so the pass stages no patch at all and converges on the spot");
  assert.deepEqual(config.controllers?.[0], { address: ADDRESS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, tokens: TOKENS },
    "the legacy properties stay live, which is what keeps the runtime's own fallback answering for this controller");
});

test("an item carrying only address-keyed entries is awaiting migration, and its entries move onto the MAC address the probe resolves", () => {

  const telemetry = "Enable.Controller.Publish.Telemetry." + TOKEN_IDENTITY;
  const topic = "Enable.Mqtt.Topic." + TOKEN_IDENTITY + "=" + ADDRESS_TOPIC;
  const credentialed = { ...CREDENTIALS, address: TOKEN_ADDRESS };

  // (i) An entry keyed by the address identity is a setting with somewhere to go, exactly as a legacy property is, so it is what makes an item worth probing.
  assert.deepEqual(controllersAwaitingMigration({ controllers: [credentialed], options: [telemetry] }).map((entry) => entry.address), [TOKEN_ADDRESS],
    "an item whose only migratable settings are address-keyed entries is still named, because a resolved MAC is what those entries are waiting on");
  assert.deepEqual(controllersAwaitingMigration({ controllers: [credentialed] }), [],
    "the same item with neither a legacy property nor an address-keyed entry has nothing to move, so it is never probed");
  assert.deepEqual(controllersAwaitingMigration({ controllers: [{ address: TOKEN_ADDRESS, tokens: TOKENS }], options: [telemetry] }), [],
    "a token-only item is out however many entries it carries, because a token never reaches the document a MAC address comes from");

  const resolved = new Map([[ TOKEN_ADDRESS, CONTROLLER_MAC ]]);

  // (ii) The move itself: every entry reading at the address identity lands at the MAC, and nothing is left under the identity the controller has outgrown.
  const moved = migrated({ controllers: [credentialed], options: [ telemetry, topic ] }, resolved);
  const movedEngine = engineWith(moved.options);

  assert.equal(movedEngine.test("Controller.Publish.Telemetry", undefined, CONTROLLER_MAC), true, "the bare enable moved onto the controller's serial");
  assert.equal(movedEngine.value("Mqtt.Topic", undefined, CONTROLLER_MAC), ADDRESS_TOPIC, "and so did the entry carrying a value");
  assert.deepEqual(moved.options?.filter((entry) => entry.toLowerCase().includes(TOKEN_IDENTITY)), [],
    "nothing is left under the address identity, which is what makes the move a move rather than a copy");

  // (iii) The destination outranks the source: a setting the user already made under the serial is the one they are looking at, so the address entry is forgotten.
  const collided = migrated({ controllers: [credentialed],
    options: [ "Enable.Mqtt.Topic." + CONTROLLER_MAC + "=" + LEGACY_TOPIC, topic ] }, resolved);

  assert.equal(engineWith(collided.options).value("Mqtt.Topic", undefined, CONTROLLER_MAC), LEGACY_TOPIC,
    "an entry the user already keyed by the MAC keeps its place, and the address entry is dropped rather than written over it");

  // (iv) The moved entries resolve through the engine at the MAC scope, which is the read the plugin's runtime actually makes.
  assert.equal(engineWith(moved.options).scope("Mqtt.Topic", undefined, CONTROLLER_MAC), "controller",
    "the moved entry answers at controller scope, which is the scope a controller-scoped read resolves through");

  /* (v) A legacy property and an address-keyed entry for the same option in one item. The move runs first, so the entry is already in place when the property asks
   * whether it has anywhere to land - which is the rule that an option the user configured outranks the property, stated for a choice made under the controller's
   * earlier identity.
   */
  const both = migrated({ controllers: [{ ...credentialed, mqttTopic: LEGACY_TOPIC }], options: [topic] }, resolved);

  assert.equal(engineWith(both.options).value("Mqtt.Topic", undefined, CONTROLLER_MAC), ADDRESS_TOPIC,
    "the entry the user configured under the address identity is their own choice, and it outranks the property exactly as a MAC-keyed entry would");
  assert.ok(!Object.hasOwn(both.controllers?.[0] ?? {}, "mqttTopic"), "and the property leaves the item either way, composed or not");

  /* (vi) Two items, each with its own address, its own entry value, and its own MAC. Both must move in one pass, which is what fails an implementation that folds
   * the move into the composed flag with a logical assignment and skips every move after the first.
   */
  const pair = migrated({

    controllers: [ credentialed, { ...CREDENTIALS, address: SECOND_ADDRESS } ],
    options: [ topic, "Enable.Mqtt.Topic." + SECOND_IDENTITY + "=" + LEGACY_TOPIC ]
  }, new Map([ [ TOKEN_ADDRESS, CONTROLLER_MAC ], [ SECOND_ADDRESS, OTHER_MAC ] ]));
  const pairEngine = engineWith(pair.options);

  assert.equal(pairEngine.value("Mqtt.Topic", undefined, CONTROLLER_MAC), ADDRESS_TOPIC, "the first item's value lands at the first item's MAC");
  assert.equal(pairEngine.value("Mqtt.Topic", undefined, OTHER_MAC), LEGACY_TOPIC, "and the second item's own value lands at its own, rather than being skipped");
  assert.deepEqual(pair.options?.filter((entry) => [ TOKEN_IDENTITY, SECOND_IDENTITY ].some((id) => entry.toLowerCase().includes(id))), [],
    "and neither address identity is left holding anything");
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
    "a credentialed connect answers its device list, and carries no display copy, so every surface keeps the wording it wrote for a success");
  assert.deepEqual(classifyProbeResponse({ devices, kind: "token-only" }), { devices, kind: "token-only", message: "" },
    "a token-only connect answers the official inventory, so its devices reach the page exactly as a credentialed connect's do");
  assert.equal(classifyProbeResponse({ devices: [], kind: "token-only" }).kind, "token-only",
    "and a token-only controller with nothing adopted is still a success rather than a failure");

  const reported = classifyProbeResponse({ kind: "error", message: "Invalid credentials." });

  assert.equal(reported.kind, "error", "a controller that refused the sign-in is a failure");
  assert.deepEqual(reported, { devices: [], headline: CONNECTION_FAILURE_HEADLINE, kind: "error", message: "Invalid credentials." },
    "a failure carries the controller's own reason under the headline that names which failure this was, and no guidance, so each surface keeps its standing line");

  for(const malformed of [ undefined, {}, { kind: "connected" }, { kind: "token-only" }, { kind: "nonsense" }, "a string" ]) {

    const verdict = classifyProbeResponse(malformed);

    assert.equal(verdict.kind, "error", "a response in a shape the server never writes reads as a failure rather than an empty page");
    assert.equal(verdict.headline, SERVER_FAILURE_HEADLINE, "and it names the UI server rather than the controller, because the controller is not what failed");
    assert.equal(verdict.guidance, SERVER_FAILURE_GUIDANCE, "and it says what to do about a server that answered in a shape it never writes");
  }
});

test("the device-list result carries each outcome's own copy and nothing else", () => {

  const devices = [{ name: "Front Door" }];

  assert.deepEqual(deviceListResult(classifyProbeResponse({ devices, kind: "connected" })), { devices, error: "" },
    "a credentialed connect hands the framework its devices and no copy at all");
  assert.deepEqual(deviceListResult(classifyProbeResponse({ devices, kind: "token-only" })), { devices, error: "" },
    "a token-only controller with devices to list reads exactly as a credentialed one");

  const nothingAdopted = deviceListResult(classifyProbeResponse({ devices: [], kind: "token-only" }));

  assert.deepEqual(nothingAdopted, { devices: [], error: "" },
    "a reachable controller whose console lists nothing carries no notice: every list opens with the controller's own row, so there is no empty list to declare");
  assert.deepEqual(Object.keys(nothingAdopted).sort(), [ "devices", "error" ], "and it carries no copy at all, because nothing failed and nothing is missing");

  const reported = classifyProbeResponse({ kind: "error", message: "Invalid credentials." });
  const reportedResult = deviceListResult(reported);

  assert.equal(reported.kind, "error", "the controller's own refusal is a failure verdict");
  assert.deepEqual(Object.keys(reportedResult).sort(), [ "devices", "error", "headline" ],
    "a connection failure carries its headline and no guidance, so the page's configured line is what the error view sends the user after");
  assert.equal(reportedResult.error, reported.message, "the failure text is the controller's own reason");
  assert.equal(reportedResult.headline, reported.headline, "and the headline is the one the verdict named");

  const malformed = classifyProbeResponse({ kind: "nonsense" });
  const malformedResult = deviceListResult(malformed);

  assert.equal(malformed.kind, "error", "a shape the server never writes is a failure verdict");
  assert.deepEqual(Object.keys(malformedResult).sort(), [ "devices", "error", "guidance", "headline" ],
    "a UI server failure carries both of its own lines, because the configured guidance would send the user to a connection editor for something the connection " +
    "did not cause");
  assert.equal(malformedResult.guidance, malformed.guidance, "the guidance is the one the verdict named");
  assert.equal(malformedResult.headline, malformed.headline, "as is the headline");

  const stale = deviceListResult(staleSelectionVerdict());

  assert.deepEqual(Object.keys(stale).sort(), [ "devices", "error", "guidance", "headline" ],
    "a sidebar entry whose controller left the configuration carries all three lines of its own copy");
  assert.ok(stale.error.length, "including the reason, which is what the error view renders beneath the headline");
  assert.notEqual(staleSelectionVerdict().devices, staleSelectionVerdict().devices,
    "and every call composes a fresh verdict, so no two results share a device array a consumer could mutate");
});

test("a credential edit carries every other key the item holds", () => {

  const item = { ...CREDENTIALS, mqttUrl: LEGACY_BROKER, name: "Front Gate", tokens: TOKENS, verifyTls: true };
  const patch = withControllerSaved({ controllers: [item] },
    { address: ADDRESS, originalAddress: ADDRESS, password: "new secret", tokens: TOKENS, username: CREDENTIALS.username, verifyTls: true });

  assert.deepEqual(patch.controllers?.[0], { ...item, password: "new secret" },
    "an un-migrated controller still owns settings the plugin runs on, and only the migration retires those");
});

test("an edit clearing an identity field deletes it rather than storing it empty", () => {

  const patch = withControllerSaved({ controllers: [{ ...CREDENTIALS, tokens: TOKENS, verifyTls: true }] },
    { address: ADDRESS, originalAddress: ADDRESS, password: CREDENTIALS.password, tokens: { access: "" }, username: CREDENTIALS.username, verifyTls: false });

  assert.deepEqual(patch.controllers?.[0], CREDENTIALS, "a cleared field reads exactly as an absent one everywhere the configuration is consulted");
});

test("a save that carries no token writes no tokens member at all, in every shape an editor can hand it one", () => {

  /* The card composes a tokens object from whatever its field holds, and a hand-edited item can arrive carrying an empty object or none. Each shape below describes
   * the same thing - no token - and each has to leave the same way, because an item carrying an empty object would read as a token to anything that tested the
   * member's presence rather than its contents.
   */
  for(const tokens of [ undefined, {}, { access: "" } ]) {

    const item = withControllerSaved({ controllers: [{ ...CREDENTIALS, tokens: TOKENS }] },
      { address: ADDRESS, originalAddress: ADDRESS, password: CREDENTIALS.password, tokens, username: CREDENTIALS.username }).controllers?.[0] ?? {};

    assert.ok(!Object.hasOwn(item, "tokens"), "the tokens member deletes by omission for " + JSON.stringify(tokens ?? null) + " rather than being written empty");
    assert.deepEqual(item, CREDENTIALS, "and what is left is the item exactly as it reads with no token configured");
  }
});

// The members each list carries, in the order a composed list reads, and the domain every assertion below resolves a composed list against.
const SENSOR_MEMBERS = [ "DPS", "REL", "REN", "REX", "SideDoorDPS" ];
const EVENT_MEMBERS = [ "Doorbell", "DPS", "Lock", "REL", "REN", "REX" ];

/* What a list resolves to at a scope, read through the served engine exactly as the plugin's own device read takes it: the same domain, and the same
 * default-when-unset reading, so what these assertions prove is what a hub would carry.
 *
 * @param options - The configured entries the patch produced.
 * @param option  - The list to resolve.
 * @param id      - The device or controller scope to resolve at, or undefined for the global reading.
 *
 * @returns The members the list selects there.
 */
function selects(options: string[] | undefined, option: string, id?: string): readonly string[] {

  return engineWith(options).valueList({ defaultWhenUnset: true, device: id, domain: (option === "Hub.Sensors") ? SENSOR_MEMBERS : EVENT_MEMBERS, option });
}

test("a globally disabled sensor composes the list of everything else, and the retired entry leaves", () => {

  const patch = migrated({ options: ["Disable.Hub.DPS"] });

  assert.deepEqual(patch.options, ["Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS"],
    "one member's switch turned off composes the family's list carrying every other member");
  assert.deepEqual(selects(patch.options, "Hub.Sensors"), [ "REL", "REN", "REX", "SideDoorDPS" ], "and the composed list resolves to exactly those members");
  assert.deepEqual(selects(patch.options, "Log.Events"), EVENT_MEMBERS, "while the family nothing was configured for composes nothing and still reads whole");
});

test("a scoped logging category turned off composes that scope's list alone", () => {

  const patch = migrated({ options: ["Disable.Log.Lock." + CONTROLLER_MAC] });

  assert.deepEqual(selects(patch.options, "Log.Events", CONTROLLER_MAC), [ "Doorbell", "DPS", "REL", "REN", "REX" ],
    "the scope the entry named composes a list less the category it turned off");
  assert.deepEqual(selects(patch.options, "Log.Events"), EVENT_MEMBERS, "and the global reading is untouched, because nothing was configured there");
  assert.deepEqual(selects(patch.options, "Log.Events", OTHER_MAC), EVENT_MEMBERS, "as is every other scope's");
});

test("a member re-enabled at one scope over a global disable keeps that scope every member", () => {

  const patch = migrated({ options: [ "Disable.Hub.DPS", "Enable.Hub.DPS." + DEVICE_MAC ] });

  assert.ok(patch.options?.includes("Enable.Hub.Sensors." + DEVICE_MAC.toLowerCase() + "=" + ALL_CHOICES),
    "a scope whose composition is every member stores the all-members form the catalog registers, rather than restating the whole list");
  assert.deepEqual(selects(patch.options, "Hub.Sensors", DEVICE_MAC), SENSOR_MEMBERS, "so the device keeps the sensor the global entry took away");
  assert.deepEqual(selects(patch.options, "Hub.Sensors"), [ "REL", "REN", "REX", "SideDoorDPS" ], "while every other hub reads the global composition");
});

test("a retired entry is read and dropped in any spelling the grammar accepts", () => {

  // The lower-cased dotted spelling is one a hand-authored 1.x file carries, and the drop reads through the framework's own enumerator rather than by matching
  // text, so it is caught by the same reading that composed from it.
  const patch = migrated({ options: [("Disable.Hub.REX." + CONTROLLER_MAC).toLowerCase()] });

  assert.deepEqual(selects(patch.options, "Hub.Sensors", CONTROLLER_MAC), [ "DPS", "REL", "REN", "SideDoorDPS" ], "the entry is read at the scope it names");

  for(const entry of patch.options ?? []) {

    assert.ok(!entry.toLowerCase().includes("hub.rex"), "and no retired entry survives the pass: " + entry);
  }
});

test("a configuration carrying no retired entry composes nothing at all", () => {

  assert.equal(accessConfig.migrate({ options: ["Enable.Hub.Sensors=REL,REN"] }, UNRESOLVED), null,
    "a configuration already carrying its lists has nothing left to find, so a later open stages no patch");
  assert.equal(accessConfig.migrate({ options: [] }, UNRESOLVED), null, "and neither does one carrying no entries at all");
});

test("a scope restating what it would inherit composes no entry of its own", () => {

  const patch = migrated({ options: [ "Disable.Hub.DPS", "Disable.Hub.DPS." + DEVICE_MAC ] });

  assert.deepEqual(patch.options, ["Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS"],
    "the scoped entry composes the same members the global one does, so emitting a scoped list would churn the file for nothing");
  assert.deepEqual(selects(patch.options, "Hub.Sensors", DEVICE_MAC), [ "REL", "REN", "REX", "SideDoorDPS" ], "and the device still reads what it read before");
});

test("the side door's sensor and the doorbell category compose onto their own families", () => {

  const sensors = migrated({ options: ["Disable.Hub.SideDoor.DPS"] });

  assert.deepEqual(selects(sensors.options, "Hub.Sensors"), [ "DPS", "REL", "REN", "REX" ],
    "a name whose own prefix is another catalog option is still read as the option it is");

  const events = migrated({ options: ["Disable.Log.Doorbell"] });

  assert.deepEqual(selects(events.options, "Log.Events"), [ "DPS", "Lock", "REL", "REN", "REX" ], "and the doorbell category composes onto the logging list");
});

test("an address change edits that item rather than adding a second one beside it, and an add appends", () => {

  const moved = withControllerSaved({ controllers: [{ ...CREDENTIALS }] },
    { address: "10.0.0.9", originalAddress: ADDRESS, password: CREDENTIALS.password, username: CREDENTIALS.username });

  assert.equal(moved.controllers?.length, 1, "the address the write started from is what finds the item, so a changed address replaces rather than duplicates");
  assert.deepEqual(moved.controllers?.[0], { ...CREDENTIALS, address: "10.0.0.9" }, "and the item now carries the new address");

  const added = { address: "10.0.0.9", tokens: TOKENS };

  assert.deepEqual(withControllerSaved({ controllers: [{ ...CREDENTIALS }] }, added).controllers, [ CREDENTIALS, added ],
    "an absent original address is what makes a write an add");
  assert.deepEqual(withControllerSaved({ controllers: [{ ...CREDENTIALS }] }, { ...added, originalAddress: "10.0.0.250" }).controllers, [ CREDENTIALS, added ],
    "and an original address matching no item falls back to the same append rather than writing nothing");
});

test("an address edit carries the controller's own entries onto the new address identity, and every other save moves nothing", () => {

  const telemetry = "Enable.Controller.Publish.Telemetry." + TOKEN_IDENTITY;
  const topic = "Enable.Mqtt.Topic." + TOKEN_IDENTITY + "=" + ADDRESS_TOPIC;
  const item = { address: TOKEN_ADDRESS, tokens: TOKENS };
  const options = [ telemetry, topic ];
  const before = [...options];
  const edited = withControllerSaved({ controllers: [item], options },
    { address: SECOND_ADDRESS, originalAddress: TOKEN_ADDRESS, tokens: TOKENS });
  const engine = engineWith(edited.options);

  assert.equal(engine.test("Controller.Publish.Telemetry", undefined, SECOND_IDENTITY), true, "the bare enable follows the address it was keyed to");
  assert.equal(engine.value("Mqtt.Topic", undefined, SECOND_IDENTITY), ADDRESS_TOPIC, "and so does the entry carrying a value");
  assert.deepEqual(edited.options?.filter((entry) => entry.toLowerCase().includes(TOKEN_IDENTITY)), [],
    "nothing is left under the address the user replaced, which is the whole point of moving rather than copying");

  /* The composer's own terms, which the page's coordinated write states and this interpreter is run as: the configuration handed in is read and never edited,
   * because the page's store holds that options array by reference as the user's live edits and as the target a revert returns to.
   */
  assert.deepEqual(options, before, "the array handed in is untouched");
  assert.notEqual(edited.options, options, "and the patch answers with an array of its own rather than the one it was given");

  // A save that changed no address must not re-key, which an entry sitting under the unchanged identity is what makes observable.
  assert.ok(!Object.hasOwn(withControllerSaved({ controllers: [item], options }, { address: TOKEN_ADDRESS, originalAddress: TOKEN_ADDRESS, tokens: TOKENS }),
    "options"), "an unchanged address composes no options member at all, so a re-key that ran unconditionally would be visible here");
  assert.ok(!Object.hasOwn(withControllerSaved({ controllers: [item], options }, { address: SECOND_ADDRESS, tokens: TOKENS }), "options"),
    "an add has no address to move entries from, so it composes none either");
  assert.ok(!Object.hasOwn(withControllerSaved({ controllers: [item], options }, { address: SECOND_ADDRESS, originalAddress: 42, tokens: TOKENS }), "options"),
    "and an original address that is not a string names no identity, so it composes none and never reaches the repair that would throw on it");

  // A MAC-keyed entry belongs to the controller's hardware rather than to the address it is reached at, so an address edit is none of its business.
  const keyedByMac = ["Enable.Mqtt.Topic." + CONTROLLER_MAC + "=" + LEGACY_TOPIC];
  const macSave = withControllerSaved({ controllers: [item], options: keyedByMac },
    { address: SECOND_ADDRESS, originalAddress: TOKEN_ADDRESS, tokens: TOKENS });

  assert.ok(!Object.hasOwn(macSave, "options"), "a controller keyed by its serial carries nothing under its address, so the move finds nothing and writes nothing");
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
  const patch = accessConfig.withControllerRemoved({ controllers: [ { ...CREDENTIALS }, other ], options: ["Enable.Hub.Doorbell." + CONTROLLER_MAC] },
    { address: ADDRESS });

  assert.deepEqual(patch.controllers, [other], "the item the address names is gone and every other item stands");
  assert.ok(!Object.hasOwn(patch, "options"),
    "with no MAC set there is no sweep, and carrying no options array at all is what leaves every configured entry exactly where it was");
});

test("the sweep strips every spelling the framework's own enumerator resolves to a swept MAC", () => {

  /* Each form below is first proven to address a MAC scope through the engine itself, so these assertions bind to the parser's grammar rather than to a reading of it:
   * the bare enable and the bare disable, the canonical entry whose value sits behind the payload delimiter, and the legacy dot spelling the parser still accepts
   * from configurations hand-authored before that delimiter existed.
   */
  const bareDisable = "Disable.Hub.Doorbell." + DEVICE_MAC;
  const bareEnable = "Enable.Hub.Doorbell." + CONTROLLER_MAC;
  const legacyPayload = "Enable.Mqtt.Topic." + CONTROLLER_MAC + "." + LEGACY_TOPIC;
  const lowerCased = "enable.mqtt.url." + CONTROLLER_MAC.toLowerCase() + "=" + LEGACY_BROKER;

  assert.equal(engineWith([bareEnable]).test("Hub.Doorbell", undefined, CONTROLLER_MAC), true, "the bare enable addresses the controller's own scope");
  assert.equal(engineWith([bareDisable]).test("Hub.Doorbell", DEVICE_MAC, CONTROLLER_MAC), false, "the bare disable addresses the device's own scope");
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

    "Enable.Hub.Doorbell",
    "Enable.Hub.Doorbell." + OTHER_MAC,
    "Enable.Hub.Doorbell." + CONTROLLER_MAC + "00",
    "Enable.Mqtt.Url=mqtt://" + CONTROLLER_MAC + ":1883",
    "Enable.Mqtt.Topic." + OTHER_MAC + "=access/" + DEVICE_MAC
  ];

  const patch = accessConfig.withControllerRemoved({ controllers: [{ ...CREDENTIALS }], options: [...survivors] },
    { address: ADDRESS, macs: [ CONTROLLER_MAC, DEVICE_MAC ] });

  assert.deepEqual(patch.options, survivors, "a global entry, a sibling's entry, and a MAC that names no scope all come through the sweep untouched");
});

test("a sweep leaves its survivors in the engine's canonical spelling, exactly as a save through the engine does", () => {

  /* The sweep runs on the engine's own scope clear, which normalizes what survives on the way through. A survivor already canonical comes back byte-identical -
   * that is the arm above - and a hand-authored legacy dotted entry is rewritten into the canonical form the engine writes, which is the same upgrade-on-save a
   * set through the engine already performs on the whole array.
   */
  const survivor = "Enable.Mqtt.Topic." + OTHER_MAC + "." + LEGACY_TOPIC;
  const canonical = normalizeConfiguredOptions(catalog, [survivor]);
  const options = [ "Enable.Hub.Doorbell." + CONTROLLER_MAC, survivor ];
  const before = [...options];
  const patch = accessConfig.withControllerRemoved({ controllers: [{ ...CREDENTIALS }], options }, { address: ADDRESS, macs: [CONTROLLER_MAC] });

  assert.deepEqual(canonical, ["Enable.Mqtt.Topic." + OTHER_MAC + "=" + LEGACY_TOPIC], "the engine's canonical spelling puts the value behind the payload delimiter");
  assert.deepEqual(patch.options, canonical, "the survivor comes back in that spelling rather than in the one the configuration file happened to carry");
  assert.equal(engineWith(patch.options).value("Mqtt.Topic", undefined, OTHER_MAC), LEGACY_TOPIC, "and it goes on resolving to exactly what it always resolved to");

  // The composer's own terms, which this interpreter is run as by the page's coordinated write: the array handed in is read and never edited.
  assert.deepEqual(options, before, "the array handed in is untouched");
  assert.notEqual(patch.options, options, "and the patch answers with an array of its own rather than the one it was given");
});

test("every migrated setting resolves to the same effective broker and topic the legacy configuration ran on", () => {

  const config: TestConfig = { controllers: [{ ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }], options: [] };

  // The plugin's own MQTT resolution, driven here exactly as its call site drives it: option-first with the legacy controller properties behind it, which is what
  // makes the before and the after comparable at all.
  const resolve = (state: TestConfig): ReturnType<typeof mqttConnectionSettings> => {

    const properties = (state.controllers?.[0] ?? {}) as { mqttTopic?: string; mqttUrl?: string };

    return mqttConnectionSettings({ config: properties, controller: CONTROLLER_MAC, featureOptions: engineWith(state.options) });
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
