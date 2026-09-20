/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.test.ts: Tests for the platform's own debug gate, its controller identity gate, and its reclaim of accessories nothing answers for.
 */
import type { API, Logging } from "homebridge";
import type { AccessAccessory, AccessAccessoryContext, AccessPlatformConfig } from "./types.ts";
import type { AccessLoginOutcome, MembershipClaims } from "./policy.ts";
import { mock, test } from "node:test";
import { APIEvent } from "homebridge-plugin-utils";
import type { AccessController } from "./controller/controller.ts";
import { AccessPlatform } from "./platform.ts";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { format } from "node:util";
import { makeControllerDouble } from "./testing.helpers.ts";
import { once } from "node:events";
import { serialForm } from "./policy.ts";
import { settle } from "homebridge-plugin-utils/testing";

interface Harness {

  events: string[];
  handlers: Map<string, () => void>;
  lines: string[];
  make: (config: AccessPlatformConfig) => AccessPlatform;
  registered: string[];
  unregistered: string[];
  /* How many accessories each cache refresh was handed, in the order the refreshes happened. The count rather than the list, because what an arm reads here is
   * whether the refresh saw the list as it stood after the mutation beside it - a position the list itself, read later, could never answer.
   */
  updated: number[];
}

function makeHarness(): Harness {

  const events: string[] = [];
  /* Every handler the platform registered, by the event that fires it. The arms that need a shutdown invoke the real one rather than reaching for the platform's
   * own abort controller, which is hard-private...this is the same path Homebridge itself takes.
   */
  const handlers = new Map<string, () => void>();
  const lines: string[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const updated: number[] = [];

  // Every line rendered exactly as the user reads it, which is what lets an arm assert a removal's own sentence rather than the format string behind it.
  const log = {

    debug: (message: string, ...parameters: unknown[]): void => { lines.push("debug: " + format(message, ...parameters)); },
    error: (message: string, ...parameters: unknown[]): void => { lines.push("error: " + format(message, ...parameters)); },
    info: (message: string, ...parameters: unknown[]): void => { lines.push("info: " + format(message, ...parameters)); },
    warn: (message: string, ...parameters: unknown[]): void => { lines.push("warn: " + format(message, ...parameters)); }
  };

  const api = {

    hap: { uuid: { generate: (input: string): string => "uuid-" + input } },
    on: (event: string, handler: () => void): void => {

      events.push(event);
      handlers.set(event, handler);
    },
    registerPlatformAccessories: (_name: string, _platformName: string, targets: AccessAccessory[]): void => {

      for(const target of targets) {

        registered.push(target.UUID);
      }
    },
    unregisterPlatformAccessories: (_name: string, _platformName: string, targets: AccessAccessory[]): void => {

      for(const target of targets) {

        unregistered.push(target.UUID);
      }
    },
    updatePlatformAccessories: (targets: AccessAccessory[]): void => void updated.push(targets.length)
  };

  return { events, handlers, lines, make: (config: AccessPlatformConfig): AccessPlatform => new AccessPlatform(log as unknown as Logging, config,
    api as unknown as API), registered, unregistered, updated };
}

/* A port nothing on this machine is holding: asked of the kernel exactly the way an ephemeral bind asks for one, then released, so the arm below binds a real socket
 * on a port it can state rather than contending for a fixed one anything else might already hold.
 *
 * @returns The port the kernel chose and then let go of.
 */
async function freePort(): Promise<number> {

  const server = createServer();

  server.listen(0);

  await once(server, "listening");

  const address = server.address();

  assert.ok(address && (typeof address === "object"), "a listening socket reports its address as an object, which is what carries the port the kernel chose");

  const port = address.port;

  server.close();

  await once(server, "close");

  return port;
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

// A cached accessory as Homebridge restores it, reduced to what the platform reads: the identity HomeKit knows it by, the name the user sees, and the context the
// version that created it wrote.
function cachedAccessory(uuid: string, displayName: string, context: AccessAccessoryContext): AccessAccessory {

  return { UUID: uuid, context, displayName } as unknown as AccessAccessory;
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

  const carried = cachedAccessory("uuid-carried", "Carried", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:01" });
  const stranger = cachedAccessory("uuid-stranger", "Stranger", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:02" });

  platform.configureAccessory(carried);

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

  assert.deepEqual(harness.unregistered, ["uuid-carried"], "a repeated removal is announced to HomeKit once");
  assert.deepEqual(platform.accessories, [], "and takes nothing else with it");
});

test("an accessory entering HomeKit is registered, appended, and saved with the list it was appended to, in that order", () => {

  const harness = makeHarness();
  const platform = harness.make({ controllers: [{ address: "1.2.3.4", tokens: { access: "token" } }], options: [], platform: "UniFi Access" });

  const first = cachedAccessory("uuid-first", "First", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:01" });
  const second = cachedAccessory("uuid-second", "Second", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:02" });

  platform.registerAccessory(first);

  assert.deepEqual(harness.registered, ["uuid-first"], "the accessory is announced to HomeKit");
  assert.deepEqual(platform.accessories, [first], "and joins the list we track it by");

  /* The refresh was handed a list of one, which is what says it ran after the push rather than before it. A cache saved ahead of the append would have been handed
   * an empty list here and would leave the new accessory out of what Homebridge writes down.
   */
  assert.deepEqual(harness.updated, [1], "the cache refresh sees the list the push has already grown");

  platform.registerAccessory(second);

  assert.deepEqual(harness.registered, [ "uuid-first", "uuid-second" ]);
  assert.deepEqual(platform.accessories, [ first, second ]);
  assert.deepEqual(harness.updated, [ 1, 2 ], "and each registration refreshes once, against the list as it stands");

  // The negative control: an accessory registered once appears once, so nothing here announces or appends twice.
  assert.equal(harness.registered.filter(uuid => uuid === "uuid-first").length, 1);
  assert.equal(platform.accessories.filter(accessory => accessory === first).length, 1);
});

test("a skipped controller entry fences the reclaim off", async () => {

  const harness = makeHarness();

  // Two entries are configured and only one of them describes an identity a client can connect with, so one controller is constructed for two entries.
  const platform = harness.make({ controllers: [ { address: "1.2.3.4", tokens: { access: "token" } }, { address: "5.6.7.8" } ],
    options: ["Disable.Controller.DelayDeviceRemoval"], platform: "UniFi Access" });

  const reporting = makeControllerDouble({ config: { address: "1.2.3.4" } });

  // The accessory the mechanism arm below removes under an open fence, so what this arm asserts about is the fence rather than an unremovable fixture.
  platform.configureAccessory(cachedAccessory("uuid-stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  assert.equal(inner.controllers.length, 1, "the entry describing no identity must be skipped, which is the count the fence reads");

  inner.controllers.splice(0, inner.controllers.length, reporting);
  await inner.reclaimStranded([Promise.resolve({ controller: reporting, outcome: "reporting" })]);

  assert.deepEqual(harness.unregistered, [], "an entry nothing was constructed for is an identity no accessory can be attributed to");
  assert.deepEqual(platform.accessories.map(accessory => accessory.UUID), ["uuid-stranded"], "and the accessory stays in the list untouched");
});

test("an unavailable identity fences the reclaim off, and a rejecting login maps to one", async () => {

  const direct = makeHarness();

  // Both entries describe a whole identity, so the counts match and the outcomes are the only thing this half turns on.
  const platform = direct.make({ controllers: [ { address: "1.2.3.4", tokens: { access: "token" } }, { address: "5.6.7.8", tokens: { access: "token" } } ],
    options: ["Disable.Controller.DelayDeviceRemoval"], platform: "UniFi Access" });

  const reporting = makeControllerDouble({ config: { address: "1.2.3.4" } });
  const silent = makeControllerDouble({ config: { address: "5.6.7.8" } });

  platform.configureAccessory(cachedAccessory("uuid-stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

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

  wiredPlatform.configureAccessory(cachedAccessory("uuid-stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

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

  platform.configureAccessory(cachedAccessory("uuid-kept-key", "Kept By Key", { controller: "1.2.3.4", mac: "aa:bb:cc:dd:ee:07" }));
  platform.configureAccessory(cachedAccessory("uuid-kept-claim", "Kept By Claim", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:01" }));
  platform.configureAccessory(cachedAccessory("uuid-stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  inner.controllers.splice(0, inner.controllers.length, reporting);
  await inner.reclaimStranded([Promise.resolve({ controller: reporting, outcome: "reporting" })]);

  assert.deepEqual(harness.unregistered, ["uuid-stranded"], "exactly the stranded accessory must be removed");
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

  platform.configureAccessory(cachedAccessory("uuid-returning", "Returning", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:01" }));
  platform.configureAccessory(cachedAccessory("uuid-gone", "Gone", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

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

  assert.deepEqual(harness.unregistered, ["uuid-gone"], "only the accessory still unclaimed when its timer fired is removed");

  /* The teardown wire, on a fixture of its own: queue a fresh stranded accessory, fire the platform's shutdown, and let the delay pass with nothing further
   * removed - which is what proves the queue was cleared. A coda re-asserting on timers that have already fired would prove nothing.
   */
  platform.configureAccessory(cachedAccessory("uuid-late", "Late", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:43" }));

  await inner.reclaimStranded([Promise.resolve({ controller: reporting, outcome: "reporting" })]);

  assert.ok(harness.lines.includes("info: Late: Delaying device removal for at least 60 seconds."), "the fresh accessory must genuinely be armed");

  harness.handlers.get(APIEvent.SHUTDOWN)?.();
  mock.timers.tick(60000);

  assert.deepEqual(harness.unregistered, ["uuid-gone"], "a queue cleared at shutdown fires nothing after it");

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

  platform.configureAccessory(cachedAccessory("uuid-stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  inner.controllers.splice(0, inner.controllers.length, waiting);
  inner.launchControllers();

  // Homebridge's own shutdown, fired through the handler the platform registered for it, and only then does the login it was waiting on resolve.
  harness.handlers.get(APIEvent.SHUTDOWN)?.();
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
  platform.configureAccessory(cachedAccessory("uuid-kept-disabled", "Kept By A Disabled Key", { controller: "5.6.7.8", mac: "aa:bb:cc:dd:ee:08" }));
  platform.configureAccessory(cachedAccessory("uuid-kept-claim", "Kept By Claim", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:01" }));
  platform.configureAccessory(cachedAccessory("uuid-stranded", "Stranded", { controller: "AA:BB:CC:DD:EE:99", mac: "aa:bb:cc:dd:ee:42" }));

  const inner = platformInternals(platform);

  inner.controllers.splice(0, inner.controllers.length, reporting, disabled);
  await inner.reclaimStranded([ Promise.resolve({ controller: reporting, outcome: "reporting" }),
    Promise.resolve({ controller: disabled, outcome: "disabled" }) ]);

  assert.deepEqual(harness.unregistered, ["uuid-stranded"], "every configured controller's keys spare an accessory, and only the unclaimed one leaves");
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
  t.after(() => harness.handlers.get(APIEvent.SHUTDOWN)?.());

  // One listener serves every controller, so the second ask is answered with the first one rather than binding a second port beside it.
  assert.equal(platform.webhookListener(), listener, "the listener is constructed once and answered again");

  await listener.ready;

  assert.equal(listener.boundPort, port, "the listener binds the port the setting named, which is the port the registered URL names");

  // Homebridge's own shutdown ends it, through the handler the platform registered for itself before it looked at any controller configuration.
  harness.handlers.get(APIEvent.SHUTDOWN)?.();

  assert.equal(listener.aborted, true, "the plugin's lifetime is the listener's");
});
