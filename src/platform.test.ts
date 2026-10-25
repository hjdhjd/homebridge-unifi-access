/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.test.ts: Tests for the platform's own debug gate, its controller identity gate, and its reclaim of accessories nothing answers for.
 */
import type { API, Logging } from "homebridge";
import type { AccessAccessory, AccessAccessoryContext, AccessPlatformConfig } from "./types.ts";
import type { AccessLoginOutcome, MembershipClaims } from "./policy.ts";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import { accessoryUuid, makeControllerDouble, makeTestAccessory, makeTestApi } from "./testing.helpers.ts";
import { freePort, settle } from "homebridge-plugin-utils/testing";
import { mock, test } from "node:test";
import { APIEvent } from "homebridge-plugin-utils";
import type { AccessController } from "./controller/controller.ts";
import { AccessPlatform } from "./platform.ts";
import type { TestHomebridgeApi } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { format } from "node:util";
import { serialForm } from "./policy.ts";

interface Harness {

  /* The Homebridge API double the platform is handed. The arms that need a shutdown emit it here, the path Homebridge itself takes, rather than reaching for the
   * platform's own abort controller, which is hard-private.
   */
  api: TestHomebridgeApi;
  lines: string[];
  make: (config: AccessPlatformConfig) => AccessPlatform;
  // The accessories each registration Homebridge accepted named, in the order it accepted them.
  readonly registered: string[];
  // Hand cached accessories to a platform through Homebridge's own restore loop, which calls the platform's configureAccessory for each and bridges it.
  restore: (platform: AccessPlatform, ...accessories: AccessAccessory[]) => void;
  // The accessories each unregister Homebridge accepted named, in the order it accepted them.
  readonly unregistered: string[];
  /* How many accessories each cache refresh was handed, in the order the refreshes happened. The count rather than the list, because what an arm reads here is
   * whether the refresh saw the list as it stood after the mutation beside it - a position the list itself, read later, could never answer.
   */
  readonly updated: number[];
}

function makeHarness(): Harness {

  const api = makeTestApi();
  const lines: string[] = [];

  // Every line rendered exactly as the user reads it, which is what lets an arm assert a removal's own sentence rather than the format string behind it.
  const log = {

    debug: (message: string, ...parameters: unknown[]): void => { lines.push("debug: " + format(message, ...parameters)); },
    error: (message: string, ...parameters: unknown[]): void => { lines.push("error: " + format(message, ...parameters)); },
    info: (message: string, ...parameters: unknown[]): void => { lines.push("info: " + format(message, ...parameters)); },
    warn: (message: string, ...parameters: unknown[]): void => { lines.push("warn: " + format(message, ...parameters)); }
  };

  // The UUIDs the accepted calls of one kind named, in the order Homebridge accepted them.
  const targets = (kind: "register" | "unregister"): string[] => api.calls.flatMap((call) => (call.kind === kind) ? call.accessories.map((target) => target.UUID) : []);

  return {

    api,
    lines,
    make: (config: AccessPlatformConfig): AccessPlatform => new AccessPlatform(log as unknown as Logging, config, api as unknown as API),
    get registered(): string[] {

      return targets("register");
    },
    restore: (platform: AccessPlatform, ...accessories: AccessAccessory[]): void => {

      api.restorePlatformAccessories({ accessories, platform, platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });
    },
    get unregistered(): string[] {

      return targets("unregister");
    },
    get updated(): number[] {

      return api.calls.flatMap((call) => (call.kind === "update") ? [call.accessories.length] : []);
    }
  };
}

/* The platform's own plumbing as the arms below drive it: the controllers it constructed, the launch that starts them, and the reclaim that consumes their
 * reports. All three are private, which is right - nothing in the plugin reads them from outside - so this states the cast once for every arm that reaches in.
 */
interface PlatformInternals {

  controllers: AccessController[];
  launchControllers: () => void;
  reclaimStranded: (reports: Promise<{ controller: AccessController; outcome: AccessLoginOutcome }>[]) => Promise<void>;
}

function platformInternals(platform: AccessPlatform): PlatformInternals {

  return platform as unknown as PlatformInternals;
}

/* The controllers a platform actually constructed.
 *
 * The count is the direct observable for what the arms below are about. The plugin registers its shutdown handler once for itself, before it has looked at any
 * controller configuration at all, so the presence of that handler says nothing about how many controllers exist.
 */
function configuredControllers(platform: AccessPlatform): AccessController[] {

  return platformInternals(platform).controllers;
}

// A cached accessory as Homebridge restores it: a real accessory under the identity HomeKit knows it by, the name the user sees, and the context the version that
// created it wrote. It reaches a platform through the harness's restore, as a cached accessory reaches one through Homebridge's.
function cachedAccessory(seed: string, displayName: string, context: AccessAccessoryContext): AccessAccessory {

  const accessory = makeTestAccessory(displayName, seed);

  accessory.context = context;

  return accessory;
}

test("a line that speaks for the plugin as a whole answers the global debug entry alone", () => {

  const enabled = makeHarness();
  const platform = enabled.make({ options: ["Enable.Log.Debug"], platform: "UniFi Access" });

  // Construction narrates itself, and this test is about the gate rather than the constructor.
  enabled.lines.length = 0;

  platform.debug("Plugin wide.");

  /* The line goes out on the warn channel, which Homebridge prints whether or not its own debug switch is set, and it carries no owner name...a line speaking for the
   * plugin as a whole has neither a device nor a controller to attribute it to.
   */
  assert.deepEqual(enabled.lines, ["warn: Plugin wide."]);

  // A device-suffixed entry turns on that one device, so a line with no owner to name is not what the user asked for and stays silent.
  const scoped = makeHarness();
  const scopedPlatform = scoped.make({ options: ["Enable.Log.Debug.DEVICE1"], platform: "UniFi Access" });

  scoped.lines.length = 0;
  scopedPlatform.debug("Plugin wide.");

  assert.deepEqual(scoped.lines, []);

  // With nothing configured anywhere, the gate is closed: debug output happens because a user asked for it and for no other reason.
  const quiet = makeHarness();
  const quietPlatform = quiet.make({ options: [], platform: "UniFi Access" });

  quiet.lines.length = 0;
  quietPlatform.debug("Plugin wide.");

  assert.deepEqual(quiet.lines, []);
});

test("a controller with a whole identity is configured and a half identity is refused", () => {

  const tokenOnly = makeHarness();
  const configured = configuredControllers(tokenOnly.make({ controllers: [{ address: "1.2.3.4", mqttTopic: "unifi/access", tokens: { access: "sometoken" } }],
    options: [], platform: "UniFi Access" }));

  // A token is a whole identity, so a controller is constructed - and it is the one this entry described, which a count on its own would not establish.
  assert.equal(configured.length, 1, "a token-only controller must be configured");
  assert.equal(configured[0]?.config.address, "1.2.3.4", "and it must be the controller built for that entry");

  const halfPair = makeHarness();
  const refused = configuredControllers(halfPair.make({ controllers: [{ address: "1.2.3.4", mqttTopic: "unifi/access", username: "someuser" }], options: [],
    platform: "UniFi Access" }));

  // Half a credential pair describes no way of authenticating, so no controller is constructed and the user is told which half is missing.
  assert.equal(refused.length, 0, "a half credential pair must not be configured");
  assert.ok(halfPair.lines.includes("info: A username has been configured without a password."), "the missing half must be named");
});

test("a controller with no identity at all is refused", () => {

  const harness = makeHarness();
  const refused = configuredControllers(harness.make({ controllers: [{ address: "1.2.3.4", mqttTopic: "unifi/access" }], options: [],
    platform: "UniFi Access" }));

  assert.equal(refused.length, 0);
  assert.ok(harness.lines.includes("info: No UniFi Access login credentials or API token have been configured."));
});

test("an accessory the platform is not carrying leaves its one exit untouched, which is what makes a repeat harmless", () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [{ address: "1.2.3.4", tokens: { access: "token" } }], options: [], platform: "UniFi Access" });

  const carried = cachedAccessory("carried", "Carried", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:01" });
  const stranger = cachedAccessory("stranger", "Stranger", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:02" });

  harness.restore(platform, carried);

  /* An accessory this platform never carried, handed to the exit anyway. The list is deliberately not empty, because an implementation that reached for a position
   * it never found would take the accessory at the end of the list, and an empty list would hide that.
   */
  platform.unregisterAccessory(stranger);

  assert.deepEqual(harness.unregistered, [], "an accessory we are not carrying reaches no HomeKit call");
  assert.deepEqual(platform.accessories, [carried], "and the list is left exactly as it stood");

  // The same accessory offered twice. The first call is the removal itself; the second meets a list that no longer carries it, which is the whole of what makes a
  // second call for an accessory already gone harmless to its callers.
  platform.unregisterAccessory(carried);
  platform.unregisterAccessory(carried);

  assert.deepEqual(harness.unregistered, [accessoryUuid("carried")], "a repeated removal is announced to HomeKit once");
  assert.deepEqual(platform.accessories, [], "and takes nothing else with it");
});

test("an accessory entering HomeKit is registered, appended, and saved with the list it was appended to, in that order", () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [{ address: "1.2.3.4", tokens: { access: "token" } }], options: [], platform: "UniFi Access" });

  const first = cachedAccessory("first", "First", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:01" });
  const second = cachedAccessory("second", "Second", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:02" });

  platform.registerAccessory(first);

  assert.deepEqual(harness.registered, [accessoryUuid("first")], "the accessory is announced to HomeKit");
  assert.deepEqual(platform.accessories, [first], "and joins the list we track it by");

  /* The refresh was handed a list of one, which is what says it ran after the push rather than before it. A cache saved ahead of the append would have been handed
   * an empty list here and would leave the new accessory out of what Homebridge writes down.
   */
  assert.deepEqual(harness.updated, [1], "the cache refresh sees the list the push has already grown");

  platform.registerAccessory(second);

  assert.deepEqual(harness.registered, [ accessoryUuid("first"), accessoryUuid("second") ]);
  assert.deepEqual(platform.accessories, [ first, second ]);
  assert.deepEqual(harness.updated, [ 1, 2 ], "and each registration refreshes once, against the list as it stands");

  // The negative control: an accessory registered once appears once, so nothing here announces or appends twice.
  assert.equal(harness.registered.filter(uuid => uuid === accessoryUuid("first")).length, 1);
  assert.equal(platform.accessories.filter(accessory => accessory === first).length, 1);
});

test("a skipped controller entry fences the reclaim off", async () => {

  const harness = makeHarness();

  // Two entries are configured and only one of them describes an identity a client can connect with, so one controller is constructed for two entries.
  const platform = harness.make({ controllers: [ { address: "1.2.3.4", tokens: { access: "token" } }, { address: "5.6.7.8" } ],
    options: ["Disable.Controller.DelayDeviceRemoval"], platform: "UniFi Access" });

  const reporting = makeControllerDouble({ config: { address: "1.2.3.4" } });

  // The accessory the mechanism arm below removes under an open fence, so what this arm asserts about is the fence rather than an unremovable fixture.
  harness.restore(platform, cachedAccessory("stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  assert.equal(inner.controllers.length, 1, "the entry describing no identity must be skipped, which is the count the fence reads");

  inner.controllers.splice(0, inner.controllers.length, reporting);
  await inner.reclaimStranded([Promise.resolve({ controller: reporting, outcome: "reporting" })]);

  assert.deepEqual(harness.unregistered, [], "an entry nothing was constructed for is an identity no accessory can be attributed to");
  assert.deepEqual(platform.accessories.map(accessory => accessory.UUID), [accessoryUuid("stranded")], "and the accessory stays in the list untouched");
});

/* The warning the platform logs for an address listed more than once, transcribed rather than referenced so a sentence that drifts by a character in its one home
 * reddens an arm.
 *
 * @param address - The address as the first entry at it stores it.
 *
 * @returns The line as the harness renders it.
 */
function listedAgain(address: string): string {

  return "warn: The controller " + address + " is listed more than once in the plugin configuration. Only its first entry is used. Saving that controller in the " +
    "plugin settings removes the extra entries.";
}

// Every warning line a harness recorded, which is what the arms about a repeated address read.
function warnings(harness: Harness): string[] {

  return harness.lines.filter((line) => line.startsWith("warn: "));
}

/* One address in spellings the settings page reads as one controller, by the listed-address rule the page and the platform share. The first repeat is a spelling the
 * first entry does not store, so a warning that named the repeated spelling rather than the first entry's would redden the arm, and the one controller constructed is
 * the platform reading the first entry alone.
 */
test("entries at one address in its exact, case-varied, space-padded, dotted, and default-port spellings warn once and construct the first entry alone", () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [ { address: "UniFi.local", tokens: { access: "first" } }, { address: "UNIFI.LOCAL", tokens: { access: "case" } },
    { address: "  unifi.local\t", tokens: { access: "space" } }, { address: "unifi.local.", tokens: { access: "dot" } },
    { address: "UniFi.local:443", tokens: { access: "port" } }, { address: "UniFi.local", tokens: { access: "exact" } } ], options: [], platform: "UniFi Access" });

  assert.deepEqual(warnings(harness), [listedAgain("UniFi.local")], "the first repeat warns once with the address as the first entry stores it");
  assert.deepEqual(configuredControllers(platform).map((controller) => controller.config.tokens?.access), ["first"], "and only the first entry is constructed");
  assert.deepEqual(platform.config.controllers.map((entry) => entry.address), ["UniFi.local"], "which is the one entry the platform's list holds");
});

// An IPv6 literal names one console with or without its brackets, and a port other than the default names another console, so only the bracketed repeat warns.
test("an IPv6 address repeated in its bracketed spelling warns once, and the same host on another port is read as its own controller", () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [ { address: "fe80::1", tokens: { access: "token" } }, { address: "[FE80::1]", tokens: { access: "token" } },
    { address: "unifi.local", tokens: { access: "token" } }, { address: "unifi.local:8443", tokens: { access: "token" } } ], options: [], platform: "UniFi Access" });

  assert.deepEqual(warnings(harness), [listedAgain("fe80::1")], "the bracketed repeat is skipped with one warning naming the first entry's address");
  assert.deepEqual(configuredControllers(platform).map((controller) => controller.config.address), [ "fe80::1", "unifi.local", "unifi.local:8443" ],
    "and the entry on another port is constructed beside the bare host");
});

// However many entries repeat an address, the warning is about the address, so it is logged once for it, naming the address as the first entry stores it.
test("an address repeated more than once beside another address warns once, and entries with no address are never one controller", () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [ { address: "10.0.0.1", tokens: { access: "token" } }, { address: "10.0.0.2", tokens: { access: "token" } },
    { address: " 10.0.0.1 ", tokens: { access: "token" } }, { address: "10.0.0.1", tokens: { access: "token" } }, { tokens: { access: "token" } },
    { address: "", tokens: { access: "token" } }, { address: 10001, tokens: { access: "token" } } ] as unknown as AccessPlatformConfig["controllers"],
  options: [], platform: "UniFi Access" });

  assert.deepEqual(warnings(harness), [listedAgain("10.0.0.1")], "the repeated address warns once however many entries repeat it");
  assert.deepEqual(configuredControllers(platform).map((controller) => controller.config.address), [ "10.0.0.1", "10.0.0.2" ], "each address's first entry is built");
  assert.equal(harness.lines.filter((line) => line === "info: No host or IP address has been configured.").length, 3,
    "and an entry with no address, or one a hand edit left a number, has no form to repeat, so each such entry still reaches the address check");
});

/* An address padded with spaces is the controller its trimmed form names, because the listed-address rule reads the padded and trimmed forms as one address while
 * unifi-access refuses the padded one. The padded entry listed first is the case that matters: kept with its spaces, it would be the one entry the platform reads,
 * and the clean entry behind it the one skipped.
 */
test("a padded entry before its clean form is one controller at the trimmed address, warned about once", () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [ { address: " 10.0.0.1 ", tokens: { access: "padded" } }, { address: "10.0.0.1", tokens: { access: "clean" } } ],
    options: [], platform: "UniFi Access" });

  assert.deepEqual(warnings(harness), [listedAgain("10.0.0.1")], "the repeat warns once, naming the address as the plugin reads it");
  assert.deepEqual(configuredControllers(platform).map((controller) => [ controller.config.address, controller.config.tokens?.access ]), [[ "10.0.0.1", "padded" ]],
    "and the first entry is the one constructed, at its trimmed address");
  assert.deepEqual(platform.config.controllers.map((entry) => entry.address), ["10.0.0.1"], "and that entry is the whole of the list every reader acts on");
});

test("a padded entry alone reaches its controller trimmed, and the entry Homebridge handed over is left as it stands", () => {

  const harness = makeHarness();
  const entry = { address: "\tunifi.local  ", tokens: { access: "token" } };
  const platform = harness.make({ controllers: [entry], options: [], platform: "UniFi Access" });
  const [controller] = configuredControllers(platform);

  assert.ok(controller, "the entry describes a whole identity, so a controller is constructed for it");
  assert.equal(controller.config.address, "unifi.local", "the controller connects to the trimmed address, the form unifi-access can carry");
  assert.equal(controller.name, "unifi.local", "and its lines are prefixed with that form until it connects");
  assert.deepEqual(warnings(harness), [], "a single entry repeats nothing");
  assert.equal(entry.address, "\tunifi.local  ", "the trim lists a copy, so Homebridge's own configuration object keeps what it was handed");
});

// A string is the shape a walk with no list check reads character by character; an object and a number are controls, which read as no controllers either way.
test("a controllers value that is not a list reads as no controllers, and an entry that is not an object is passed over", () => {

  for(const [ value, label ] of [ [ { address: "10.0.0.1" }, "an object" ], [ "unifi.local", "a non-empty string" ], [ 42, "a number" ] ] as [ unknown, string ][]) {

    const harness = makeHarness();

    harness.make({ controllers: value as AccessPlatformConfig["controllers"], options: [], platform: "UniFi Access" });

    assert.deepEqual(harness.lines, ["info: No UniFi Access controllers have been configured."], label + " says there are no controllers and nothing else");
  }

  const harness = makeHarness();
  const platform = harness.make({ controllers: [ null, "unifi.local", { address: "10.0.0.1", tokens: { access: "token" } } ] as unknown as
    AccessPlatformConfig["controllers"], options: [], platform: "UniFi Access" });

  assert.deepEqual(configuredControllers(platform).map((controller) => controller.config.address), ["10.0.0.1"], "construction completes over the one object entry");
  assert.deepEqual(platform.config.controllers.map((entry) => entry.address), ["10.0.0.1"], "which is the whole of the list the platform acts on");
});

test("a controller listed under more than one spelling leaves the reclaim fence open, because the fence counts the list the platform acts on", async () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [ { address: "unifi.local", tokens: { access: "token" } }, { address: "UNIFI.local.", tokens: { access: "token" } } ],
    options: ["Disable.Controller.DelayDeviceRemoval"], platform: "UniFi Access" });

  const reporting = makeControllerDouble({ config: { address: "unifi.local" } });

  harness.restore(platform, cachedAccessory("stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  assert.equal(inner.controllers.length, 1, "the repeated spelling constructs nothing");

  inner.controllers.splice(0, inner.controllers.length, reporting);
  await inner.reclaimStranded([Promise.resolve({ controller: reporting, outcome: "reporting" })]);

  assert.deepEqual(harness.unregistered, [accessoryUuid("stranded")], "the one listed controller reported, so the stranded accessory is reclaimed");
});

test("an unavailable identity fences the reclaim off, and a rejecting login maps to one", async () => {

  const direct = makeHarness();

  // Both entries describe a whole identity, so the counts match and the outcomes are the only thing this half turns on.
  const platform = direct.make({ controllers: [ { address: "1.2.3.4", tokens: { access: "token" } }, { address: "5.6.7.8", tokens: { access: "token" } } ],
    options: ["Disable.Controller.DelayDeviceRemoval"], platform: "UniFi Access" });

  const reporting = makeControllerDouble({ config: { address: "1.2.3.4" } });
  const silent = makeControllerDouble({ config: { address: "5.6.7.8" } });

  direct.restore(platform, cachedAccessory("stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  inner.controllers.splice(0, inner.controllers.length, reporting, silent);
  await inner.reclaimStranded([ Promise.resolve({ controller: reporting, outcome: "reporting" }),
    Promise.resolve({ controller: silent, outcome: "unavailable" }) ]);

  assert.deepEqual(direct.unregistered, [], "a controller that never learned its identity cannot say which accessories are its own");

  /* The wired half, driven through the real launch: a login that rejects outright is absorbed at its own pair, said once against the controller it happened to,
   * and read as an identity nobody can attribute - so the pass stands down for the session instead of the rejection escaping unhandled.
   */
  const failures: string[] = [];
  const wired = makeHarness();
  const wiredPlatform = wired.make({ controllers: [{ address: "1.2.3.4", tokens: { access: "token" } }],
    options: ["Disable.Controller.DelayDeviceRemoval"], platform: "UniFi Access" });

  const failing = makeControllerDouble({ config: { address: "1.2.3.4" },
    log: { error: (message: string, ...parameters: unknown[]): void => void failures.push(format(message, ...parameters)) },
    login: async (): Promise<never> => { throw new Error("Connection refused."); } });

  wired.restore(wiredPlatform, cachedAccessory("stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const wiredInner = platformInternals(wiredPlatform);

  wiredInner.controllers.splice(0, wiredInner.controllers.length, failing);
  wiredInner.launchControllers();

  // The pass runs behind the logins it awaits, so yielding once is what lets it reach its own decision.
  await settle();

  // The whole sentence, spelled out, so the arm cannot pass on a prefix that a wording dropping the consequence would satisfy just as well.
  const refused = "Unable to log in to this controller: Connection refused. " +
    "Accessories left behind by a controller that was removed or replaced will not be cleaned up until the next restart.";

  assert.ok(failures.includes(refused), "the failure must be said against the controller it belongs to, naming the refusal and what it costs the session");
  assert.deepEqual(wired.unregistered, [], "and the pass must stand down for the session");
});

test("a stranded accessory is reclaimed once every configured controller has reported", async () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [{ address: "1.2.3.4", tokens: { access: "token" } }],
    options: ["Disable.Controller.DelayDeviceRemoval"], platform: "UniFi Access" });

  const claims = { serials: new Set([serialForm("aa:bb:cc:dd:ee:01")]), uuids: new Set<string>() };
  const reporting = makeControllerDouble({ config: { address: "1.2.3.4" }, reclaimClaims: (): MembershipClaims => claims });

  harness.restore(platform, cachedAccessory("kept-key", "Kept By Key", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:07" }));
  harness.restore(platform, cachedAccessory("kept-claim", "Kept By Claim", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:01" }));
  harness.restore(platform, cachedAccessory("stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  inner.controllers.splice(0, inner.controllers.length, reporting);
  await inner.reclaimStranded([Promise.resolve({ controller: reporting, outcome: "reporting" })]);

  assert.deepEqual(harness.unregistered, [accessoryUuid("stranded")], "exactly the stranded accessory must be removed");
  assert.ok(harness.lines.includes("info: Stranded: Removing this accessory from HomeKit. It belongs to no configured controller, " +
    "and no controller reports its device."), "the reason must be said in the removal's own sentence");
});

test("a stranded reclaim honors the global removal delay and re-checks before firing", async () => {

  mock.timers.enable({ apis: ["setTimeout"] });

  const harness = makeHarness();
  const platform = harness.make({ controllers: [{ address: "1.2.3.4", tokens: { access: "token" } }], options: [], platform: "UniFi Access" });

  /* The claims are built fresh from this backing list on every call, so the appearance below changes what a LATER call reads rather than mutating a set the pass
   * already holds...an implementation that captured the claims once when it armed the timer fails here rather than passing by aliasing.
   */
  const projected: string[] = [];
  const reporting = makeControllerDouble({ config: { address: "1.2.3.4" },
    reclaimClaims: (): MembershipClaims => ({ serials: new Set(projected.map(serialForm)), uuids: new Set<string>() }) });

  harness.restore(platform, cachedAccessory("returning", "Returning", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:01" }));
  harness.restore(platform, cachedAccessory("gone", "Gone", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  inner.controllers.splice(0, inner.controllers.length, reporting);
  await inner.reclaimStranded([Promise.resolve({ controller: reporting, outcome: "reporting" })]);

  // Nothing was configured for the delay, so it resolves to the option's own default of 60 seconds and the sentence the user reads names it.
  assert.ok(harness.lines.includes("info: Returning: Delaying device removal for at least 60 seconds."));
  assert.ok(harness.lines.includes("info: Gone: Delaying device removal for at least 60 seconds."));
  assert.deepEqual(harness.unregistered, [], "nothing leaves before its delay has been served");

  // The hardware behind one of them turns up while the timers run, which is the whole reason the delay exists.
  projected.push("aa:bb:cc:dd:ee:01");

  mock.timers.tick(60000);

  assert.deepEqual(harness.unregistered, [accessoryUuid("gone")], "only the accessory still unclaimed when its timer fired is removed");

  /* The teardown wire, on a fixture of its own: queue a fresh stranded accessory, fire the platform's shutdown, and let the delay pass with nothing further
   * removed - which is what proves the queue was cleared. A coda re-asserting on timers that have already fired would prove nothing.
   */
  harness.restore(platform, cachedAccessory("late", "Late", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:43" }));

  await inner.reclaimStranded([Promise.resolve({ controller: reporting, outcome: "reporting" })]);

  assert.ok(harness.lines.includes("info: Late: Delaying device removal for at least 60 seconds."), "the fresh accessory must genuinely be armed");

  harness.api.emit(APIEvent.SHUTDOWN);
  mock.timers.tick(60000);

  assert.deepEqual(harness.unregistered, [accessoryUuid("gone")], "a queue cleared at shutdown fires nothing after it");

  mock.timers.reset();
});

test("a shutdown that lands before the fence closes removes nothing", async () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [{ address: "1.2.3.4", tokens: { access: "token" } }],
    options: [ "Disable.Controller.DelayDeviceRemoval", "Enable.Log.Debug" ], platform: "UniFi Access" });

  let releaseLogin = (): void => undefined;

  const pending = new Promise<AccessLoginOutcome>(resolve => { releaseLogin = (): void => resolve("reporting"); });

  // A controller whose login is still outstanding is what leaves the pass waiting, which is the window this arm is about.
  const waiting = makeControllerDouble({ config: { address: "1.2.3.4" }, login: async (): Promise<AccessLoginOutcome> => pending });

  harness.restore(platform, cachedAccessory("stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  inner.controllers.splice(0, inner.controllers.length, waiting);
  inner.launchControllers();

  // Homebridge's own shutdown, fired through the handler the platform registered for it, and only then does the login it was waiting on resolve.
  harness.api.emit(APIEvent.SHUTDOWN);
  releaseLogin();

  await settle();

  assert.deepEqual(harness.unregistered, [], "a shutdown that resolved the logins is not an occasion to act on them");
  assert.ok(harness.lines.some(line => line.includes("the plugin is shutting down")), "and the pass must say that is why it stood down");
});

test("a disabled controller contributes its keys and is never asked for claims", async () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [ { address: "1.2.3.4", tokens: { access: "token" } }, { address: "5.6.7.8", tokens: { access: "token" } } ],
    options: ["Disable.Controller.DelayDeviceRemoval"], platform: "UniFi Access" });

  const claims = { serials: new Set([serialForm("aa:bb:cc:dd:ee:01")]), uuids: new Set<string>() };
  const reporting = makeControllerDouble({ config: { address: "1.2.3.4" }, reclaimClaims: (): MembershipClaims => claims });

  /* A disabled controller's claims would come from a client it has already disposed, so nothing may ask it what it projects. A double that throws is what turns a
   * mis-called read into a failure here rather than a stale answer nobody notices.
   */
  const disabled = makeControllerDouble({ config: { address: "5.6.7.8" },
    reclaimClaims: (): MembershipClaims => { throw new Error("A disabled controller must never be asked what it projects."); } });

  /* This asserts the decision's letter at this layer rather than a production scenario: by the time the pass runs, a controller the user disabled has already taken
   * every accessory its keys would spare out of HomeKit, so the first fixture is constructible only with a double.
   */
  harness.restore(platform, cachedAccessory("kept-disabled", "Kept By A Disabled Key", { controller: "5.6.7.8", mac: "aa:bb:cc:dd:ee:08" }));
  harness.restore(platform, cachedAccessory("kept-claim", "Kept By Claim", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:01" }));
  harness.restore(platform, cachedAccessory("stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  inner.controllers.splice(0, inner.controllers.length, reporting, disabled);
  await inner.reclaimStranded([ Promise.resolve({ controller: reporting, outcome: "reporting" }),
    Promise.resolve({ controller: disabled, outcome: "disabled" }) ]);

  assert.deepEqual(harness.unregistered, [accessoryUuid("stranded")], "every configured controller's keys spare an accessory, and only the unclaimed one leaves");
});

test("a webhook port setting that is not a port is said once and the default is used, and one that is a port is used as written", () => {

  const refused = makeHarness();
  const refusedPlatform = refused.make({ options: ["Enable.Controller.Webhooks.Port=70000"], platform: "UniFi Access" });

  assert.equal(refusedPlatform.webhookPort, 10120, "a setting outside the range of a port leaves the default standing");
  assert.deepEqual(refused.lines.filter(line => line.startsWith("warn: The webhook port setting")),
    ["warn: The webhook port setting 70000 is not a whole number from 1 to 65535. The default port 10120 will be used."],
    "and it is reported once as a configuration problem, naming the setting and the port that will be used instead");

  const stated = makeHarness();
  const statedPlatform = stated.make({ options: ["Enable.Controller.Webhooks.Port=10130"], platform: "UniFi Access" });

  assert.equal(statedPlatform.webhookPort, 10130, "a port the user stated is the port");
  assert.deepEqual(stated.lines.filter(line => line.startsWith("warn: The webhook port setting")), [], "and nothing is said about a setting that is one");

  // Nobody configured a port at all, so the engine answers the option's own registered default and the rule reads it as the port it is.
  const plain = makeHarness();
  const plainPlatform = plain.make({ platform: "UniFi Access" });

  assert.equal(plainPlatform.webhookPort, 10120, "a configuration naming no port binds the default");
  assert.deepEqual(plain.lines.filter(line => line.startsWith("warn: The webhook port setting")), [], "and says nothing about a setting nobody wrote");
});

test("the platform builds one real listener, on its own clock and lifetime, and the shutdown ends it", async (t) => {

  const harness = makeHarness();
  const port = await freePort();
  /* The property this arm is here for: the listener binds the port the setting named, which is the port the registration names, so the two can never disagree.
   * Everything else about the listener - the clock its bind retry waits on, the label its own lines carry, the signal that ends it - is what the platform composes,
   * and this is the only arm that runs that composition rather than substituting for it.
   */
  const platform = harness.make({ options: ["Enable.Controller.Webhooks.Port=" + port.toString()], platform: "UniFi Access" });
  const listener = platform.webhookListener();

  // Registered here rather than at the end, so an arm failing partway still releases the port instead of leaving the run hanging on a bound server.
  t.after(() => void harness.api.emit(APIEvent.SHUTDOWN));

  // One listener serves every controller, so the second ask is answered with the first one rather than binding a second port beside it.
  assert.equal(platform.webhookListener(), listener, "the listener is constructed once and answered again");

  await listener.ready;

  assert.equal(listener.boundPort, port, "the listener binds the port the setting named, which is the port the registered URL names");

  // Homebridge's own shutdown ends it, through the handler the platform registered for itself before it looked at any controller configuration.
  harness.api.emit(APIEvent.SHUTDOWN);

  assert.equal(listener.aborted, true, "the plugin's lifetime is the listener's");
});
