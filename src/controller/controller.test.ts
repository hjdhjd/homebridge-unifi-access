/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.test.ts: Tests for the controller's delayed removals and its membership resolution.
 */
/* eslint-disable camelcase */
import { ACCESS_CONTROLLER_AUTH_FAILURE_LIMIT, ACCESS_WEBHOOK_EVENTS, ACCESS_WEBHOOK_EVENT_LIST, ACCESS_WEBHOOK_FRESHNESS_WINDOW_MS } from "../settings.ts";
import type { AccessAccessory, AccessAccessoryContext } from "../types.ts";
import { AccessAuthError, AccessAuthorizationError, AccessClient, AccessOfficialApiError, createStateStore, selectAccessPoints } from "unifi-access";
import type { AccessEventPacket, AccessOfficialWebhookEndpoint, AccessOfficialWebhookEndpointWrite, OfficialApi } from "unifi-access";
import { Characteristic, Service } from "@homebridge/hap-nodejs";
import { EventEmitter, on } from "node:events";
import { HbpuAbortError, defaultRetryBackoff, membershipDelta, retry } from "homebridge-plugin-utils";
import type { HttpListener, MqttClient } from "homebridge-plugin-utils";
import { ROOT_ID, buildingTopology, hubRecord, makePlatformDouble } from "../testing.helpers.ts";
import { TestClock, TestHttpListener, TestMqttClient, drainClock, settle } from "homebridge-plugin-utils/testing";
import { createMembershipIdsSelector, serialForm } from "../policy.ts";
import { ACCESS_WEBHOOK_EVENT_PREFIX } from "./events.ts";
import { AccessController } from "./controller.ts";
import type { AccessControllerConnect } from "./controller.ts";
import type { AccessControllerOptions } from "../options.ts";
import type { AccessDevice } from "../devices/device.ts";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { format } from "node:util";
import test from "node:test";

// The controller's own MAC, in the raw form an accessory context carries and the normalized form feature options resolve against.
const CONTROLLER_MAC = "11:22:33:44:55:66";

// The removal delay every departure below serves, in milliseconds: the Controller.DelayDeviceRemoval default of sixty seconds, which the user-facing sentence names.
const DEVICE_REMOVAL_DELAY_MS = 60000;

// What a connect spends in backoff before the authentication budget stops it: the default retry ladder's first two waits, asserted against that ladder below.
const AUTH_BUDGET_BACKOFF_MS = 3000;

/* How many macrotask boundaries an arm crosses before reading what a dispatched chain did. The chains drained through it are the connection observer's walk
 * over one transition, the webhook configuration a login sets in motion, and the MQTT publish chokepoint. Each is fire-and-forget by design, so an arm waits on
 * the event loop rather than on a promise it has no way to reach, and the count is the smallest every chain comes to rest within plus one turn of headroom
 * against a chain gaining a hop.
 */
const DISPATCH_SETTLE_TURNS = 2;

/* The Enterprise topology the arms below read: a plain hub, a building-hosted Enterprise hub whose single port extension is what the expansion synthesizes a
 * device from, and a managed record carrying a device type this plugin cannot project. One fixture serves them because each arm is about a different consumer of
 * the same three records.
 */
// The plain hub of that topology, named on its own because the adoption arm stands one device up and nothing else, and both callers must read one record rather than
// two that happen to agree.
function plainHubRecord(): Record<string, unknown> {

  return hubRecord({ alias: "", name: "Plain Hub", unique_id: "plain" });
}

// The hub that turns up mid-delay: absent from the Enterprise topology above, so an accessory naming it is a departure until this record joins the store.
function returnedHubRecord(): Record<string, unknown> {

  return { alias: "", capabilities: ["is_hub"], device_type: "UAH", is_managed: true, mac: "aabbccddee99", name: "Returned Hub", unique_id: "returned" };
}

function enterpriseDevices(): Record<string, unknown>[] {

  return [

    plainHubRecord(),
    {

      alias: "",
      capabilities: ["is_hub"],
      device_type: "UAH-Ent",
      display_model: "UA Hub Enterprise",
      extensions: [{ device_id: "ent", extension_name: "port_setting", source_id: "port1", target_config: [], target_name: "Front Door", target_type: "door",
        target_value: "door1", unique_id: "entPort1" }],
      is_managed: true,
      location_id: ROOT_ID,
      mac: "aabbccddee02",
      name: "Enterprise Hub",
      unique_id: "ent"
    },
    { alias: "", capabilities: [], device_type: "SOMETHING-NEW", is_managed: true, mac: "aabbccddee03", name: "Unsupported", unique_id: "unsupported" }
  ];
}

// A cached accessory as Homebridge restores it, carrying whatever context the version that created it wrote: the controller key alone by default, the MAC address
// where an arm needs the hardware it names, and the device identity where the arm is about an accessory this version created.
function accessory(uuid: string, context: AccessAccessoryContext = { controller: CONTROLLER_MAC }): AccessAccessory {

  return { UUID: uuid, context, displayName: "Accessory " + uuid } as unknown as AccessAccessory;
}

/* The accessory constructor Homebridge supplies: the members the controller writes and reads on a freshly created one, and the service surface a device configures
 * itself through. The services are the genuine HAP classes and the lookups are backed by a plain list, so an accessory the adoption path hands to a device is dressed
 * here exactly as it is in the field - which is what lets an arm follow an adoption all the way to a constructed device rather than stopping at the registration.
 */
class TestAccessory {

  public UUID: string;
  public context: Record<string, unknown>;
  public displayName: string;
  public services: Service[];

  constructor(displayName: string, uuid: string) {

    this.UUID = uuid;
    this.context = {};
    this.displayName = displayName;
    this.services = [];
  }

  public addService(service: Service): Service {

    this.services.push(service);

    return service;
  }

  public getService(target: { UUID: string }): Service | undefined {

    return this.services.find(service => (service.UUID === target.UUID) && !service.subtype);
  }

  public getServiceById(target: { UUID: string }, subtype: string): Service | undefined {

    return this.services.find(service => (service.UUID === target.UUID) && (service.subtype === subtype));
  }

  public removeService(service: Service): void {

    this.services.splice(this.services.indexOf(service), 1);
  }
}

/* One device handle the client answers for a record's identity, in the shape the adoption path consumes: the projection every device reads its own record through,
 * and the door members lock-capable hardware is given. Nothing here commands anything, because what an arm reaching for a handle is about is the adoption running to
 * a constructed device rather than what that device does afterwards - the hub suite owns the command surface.
 */
function deviceHandle(record: Record<string, unknown>): unknown {

  return {

    config: record,
    doorId: "",
    doorState: undefined,
    observe: async function *(): AsyncGenerator { /* nothing observes in these arms */ },
    peek: (): undefined => undefined
  };
}

/* The client double a controller is stood up over: the members the controller reads on a connected client, and the ones its login path touches - the event
 * bridge's subscription, the controller's name, the published API where an arm supplies one, and the disposal a disabled controller performs. What varies
 * between harnesses is injected; everything else is the same inert stub, so an arm that drives a real login() reaches the membership seed and the orphan sweep
 * over the caller's own store.
 */
function clientDouble(options: { connection?: unknown; controllerInfo: Record<string, unknown> | null; handles?: Map<string, unknown>; official?: OfficialApi | null;
  onDispose?: () => void; store: ReturnType<typeof createStateStore>; }): AccessClient {

  return {

    accessPoint: (): undefined => undefined,
    // A connection that reads healthy and yields nothing unless an arm supplies one it drives, which is what keeps every other arm's observer inert.
    connection: options.connection ?? { isHealthy: true, observe: async function *(): AsyncGenerator { /* nothing transitions in these arms */ } },
    controllerInfo: options.controllerInfo,
    controllerName: "Test Controller",
    device: (): undefined => undefined,
    /* The handles an arm named, by the record identity each one answers for. An arm naming none answers no handle at all, which is what keeps every other arm's
     * adoption stopping short of a constructed device - the state they are about is the accessory list rather than what hangs off it.
     */
    hub: (id: string): unknown => options.handles?.get(id),
    official: options.official ?? null,
    on: (): Disposable => ({ [Symbol.dispose]: (): void => undefined }),
    state: options.store,
    [Symbol.asyncDispose]: async (): Promise<void> => options.onDispose?.()
  } as unknown as AccessClient;
}

// What a stood-up controller looks like from a test's side: the HomeKit accessory list it acts on, the registration traffic it produced, the lines it said, and the
// plugin lifetime its own terminal signal composes from.
interface ControllerHarness {

  accessories: AccessAccessory[];
  // The time source this controller's removals and its connect backoff are armed on, so an arm advances time here rather than waiting any of it out.
  clock: TestClock;
  controller: AccessController;
  logged: string[];
  registered: string[];
  shutdown: AbortController;
  unregistered: string[];
}

/* Stand up a real AccessController over a platform double and a stubbed client, so an arm reads what the controller actually did to HomeKit rather than what a
 * mock decided it would do. The accessory list, the registration counters, and the state store all belong to the caller.
 *
 * @param options - The controller's configuration, the controller document its client answers with, and the state store behind that client.
 */
function makeController(options: { config?: Partial<AccessControllerOptions>; connection?: unknown;
  controllerInfo?: { host: { device_type?: string; mac: string; shortname?: string } } | null; handles?: Map<string, unknown>; options?: string[];
  store?: ReturnType<typeof createStateStore>; } = {}): ControllerHarness {

  const accessories: AccessAccessory[] = [];
  const clock = new TestClock();
  // Every line the controller said at info level, rendered exactly as the user reads it, which is what lets an arm assert on a removal's own sentence.
  const logged: string[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  // The plugin's own lifetime, which the platform owns and every controller composes its terminal signal from.
  const shutdown = new AbortController();

  const api = {

    hap: { Characteristic, Service, uuid: { generate: (input: string): string => "uuid-" + input } },
    on: (): void => undefined,
    platformAccessory: TestAccessory,
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
    updatePlatformAccessories: (): void => undefined
  };

  /* The clock every deadline this controller owns is armed on is the one this arm holds, rather than the fresh one the double would otherwise default to, because a
   * controller reading a clock no arm holds is a controller whose timers an advance would never reach. The accessory entry and exit the double defaults to reach
   * this arm's own api recorders and this arm's own list, which is what lets an adoption and a retirement be read here.
   */
  const platform = makePlatformDouble({ accessories, api, clock, entries: options.options ?? [],
    log: { error: (): void => undefined, info: (message: string, ...parameters: unknown[]): void => void logged.push(format(message, ...parameters)),
      warn: (): void => undefined }, signal: shutdown.signal });

  // The connect port answers with the same double the controller is handed directly, so the arms that never log in and the ones that do read one client.
  const client = clientDouble({ connection: options.connection, controllerInfo: options.controllerInfo ?? null, handles: options.handles,
    store: options.store ?? createStateStore({}) });
  /* The token in the default identity is what makes every arm's teardown real rather than decorative: a controller the identity gate turns back never registers
   * its bridge from the plugin's lifetime to its own, so aborting the plugin would leave that controller's terminal signal standing and prove nothing about what
   * the abort reaches. An arm that is about some other identity states one, and its own configuration wins.
   */
  const controller = new AccessController(platform, { address: "1.2.3.4", tokens: { access: "t" }, ...options.config },
    async (): Promise<AccessClient> => client);

  controller.client = client;

  return { accessories, clock, controller, logged, registered, shutdown, unregistered };
}

/* The connection monitor a controller observes, with the transitions an arm hands it. The generator ends on the caller's own abort, which is the lifetime the real
 * monitor's iterator has, so a controller torn down mid-arm stops walking exactly as it does in the field.
 */
function connectionDouble(): { connection: unknown; drive: (from: string, to: string) => Promise<void> } {

  const bus = new EventEmitter();

  return {

    connection: {

      isHealthy: true,
      observe: async function *(opts: { signal: AbortSignal }): AsyncGenerator<{ from: string; to: string }> {

        try {

          for await (const [transition] of on(bus, "transition", { signal: opts.signal })) {

            yield transition as { from: string; to: string };
          }
        } catch {

          // The caller's own abort is what ends this iteration, exactly as it ends the real monitor's, so it is the expected exit rather than news.
        }
      }
    },

    // Hand the loop one transition and let it finish walking, which is the point an arm reads what the walk did.
    drive: async (from: string, to: string): Promise<void> => {

      bus.emit("transition", { from, to });

      await settle(DISPATCH_SETTLE_TURNS);
    }
  };
}

/* A configured device as the connection observer sees it: the two calls its walks make, recorded in the order they arrive, and the log a fault is reported through. A
 * device an arm names as faulting throws from both, which is what lets each walk's isolation be read separately rather than as one combined verdict.
 */
function stubDevice(options: { faults?: boolean } = {}): { calls: string[]; device: AccessDevice; errors: string[] } {

  const calls: string[] = [];
  const errors: string[] = [];

  const device = {

    log: { error: (message: string, ...parameters: unknown[]): void => void errors.push(format(message, ...parameters)) },
    onConnectionRestored: (): void => {

      calls.push("restore");

      if(options.faults) {

        throw new Error("this device is not answering");
      }
    },
    refreshReachability: (): void => {

      calls.push("refresh");

      if(options.faults) {

        throw new Error("this device is not answering");
      }
    }
  };

  return { calls, device: device as unknown as AccessDevice, errors };
}

test("the connection observer pushes reachability on every transition and restores only where a recovery completed", async (t) => {

  const monitor = connectionDouble();
  const harness = makeController({ connection: monitor.connection, controllerInfo: { host: { mac: CONTROLLER_MAC } } });

  t.after(() => harness.shutdown.abort());

  await harness.controller.login();

  const stub = stubDevice();

  harness.controller.configuredDevices.set("stub", stub.device);

  // A recovery concluding at healthy: availability is pushed, and the hook fires because the edge left the reconnecting state for something other than lost.
  await monitor.drive("reconnecting", "healthy");

  assert.deepEqual(stub.calls, [ "refresh", "restore" ]);

  // A recovery concluding while the transport's breaker happens to be open exits to throttled instead, and is every bit as completed as the one above.
  await monitor.drive("reconnecting", "throttled");

  assert.deepEqual(stub.calls.slice(2), [ "refresh", "restore" ]);

  // An ordinary fault edge: availability moves, but nothing recovered, so there is nothing to refresh behind it.
  await monitor.drive("healthy", "degraded");

  assert.deepEqual(stub.calls.slice(4), ["refresh"]);

  // A plain throttle cycle arrives at healthy having done no stream work and missed no packets, which is what rules the arrival state out as the trigger on its own.
  await monitor.drive("throttled", "healthy");

  assert.deepEqual(stub.calls.slice(5), ["refresh"]);
});

test("one device's fault on either of the observer's walks costs its siblings nothing", async (t) => {

  const monitor = connectionDouble();
  const harness = makeController({ connection: monitor.connection, controllerInfo: { host: { mac: CONTROLLER_MAC } } });

  t.after(() => harness.shutdown.abort());

  await harness.controller.login();

  const faulting = stubDevice({ faults: true });
  const sibling = stubDevice();

  harness.controller.configuredDevices.set("faulting", faulting.device);
  harness.controller.configuredDevices.set("sibling", sibling.device);

  // One edge drives both walks, and the faulting device is first in the map on each of them.
  await monitor.drive("reconnecting", "healthy");

  assert.deepEqual(faulting.calls, [ "refresh", "restore" ], "the faulting device is asked on both walks");
  assert.deepEqual(sibling.calls, [ "refresh", "restore" ], "and the device behind it receives both, so each walk's isolation holds on its own");
  assert.equal(faulting.errors.length, 2, "each fault is reported through the device's own log rather than unwinding the loop");
});

test("the connection observer's lifetime is the controller's own terminal signal", async () => {

  const monitor = connectionDouble();
  const harness = makeController({ connection: monitor.connection, controllerInfo: { host: { mac: CONTROLLER_MAC } } });

  await harness.controller.login();

  const stub = stubDevice();

  harness.controller.configuredDevices.set("stub", stub.device);

  await monitor.drive("reconnecting", "healthy");

  assert.deepEqual(stub.calls, [ "refresh", "restore" ]);

  harness.shutdown.abort();

  await monitor.drive("reconnecting", "healthy");

  assert.deepEqual(stub.calls, [ "refresh", "restore" ], "a transition driven after the plugin's lifetime ended walks nothing");
});

test("a departure with the delay on removes the accessory only once its whole delay has been served", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  // An accessory naming hardware the topology does not carry, so membership can never account for it and the delay is the only thing standing between it and removal.
  const departed = accessory("uuid-AABBCCDDEE99", { controller: CONTROLLER_MAC, id: "AABBCCDDEE99", mac: "AABBCCDDEE99" });

  harness.accessories.push(departed);
  harness.controller.removeHomeKitDevice(departed);

  assert.equal(harness.logged.filter(line => line.includes("Delaying device removal")).length, 1, "a departure states the delay it is serving, once");
  assert.equal(harness.clock.nextDeadline, DEVICE_REMOVAL_DELAY_MS, "and the removal comes due a whole delay out");

  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS - 1);

  assert.deepEqual(harness.unregistered, [], "the removal must serve its whole delay, not almost all of it");

  harness.clock.advance(1);

  assert.deepEqual(harness.unregistered, ["uuid-AABBCCDDEE99"]);
  assert.equal(harness.clock.nextDeadline, null, "a fired removal leaves nothing behind on the timeline");
});

test("a device that returns during its delay keeps its accessory and leaves nothing armed", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  const returning = accessory("uuid-AABBCCDDEE99", { controller: CONTROLLER_MAC, id: "AABBCCDDEE99", mac: "AABBCCDDEE99" });

  harness.accessories.push(returning);
  harness.controller.removeHomeKitDevice(returning);

  /* The hardware turns up while the timer runs, which is the whole reason the delay exists. The fire path re-asks membership rather than trusting what it read when
   * it armed, so an implementation that captured the answer at arming time removes this accessory and fails here.
   */
  store.applyRefreshDocuments({ controller: null, topology: buildingTopology([ ...enterpriseDevices(), returnedHubRecord() ]) });

  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS);

  assert.deepEqual(harness.unregistered, [], "a device that came back keeps its accessory");
  assert.ok(harness.accessories.includes(returning));
  assert.equal(harness.clock.nextDeadline, null, "and the entry is gone rather than re-armed for another delay");
});

test("a second departure raised during the delay neither restarts the wait nor restates the sentence", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  const departed = accessory("uuid-AABBCCDDEE99", { controller: CONTROLLER_MAC, id: "AABBCCDDEE99", mac: "AABBCCDDEE99" });

  harness.accessories.push(departed);
  harness.controller.removeHomeKitDevice(departed);
  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS / 2);

  /* The same departure raised again halfway through, as a second reconcile pass raises it. The armed timer keeps the removal: a registration under a key that
   * already holds one replaces it, so a departure path that armed without asking first would move this removal out to a delay and a half.
   */
  harness.controller.removeHomeKitDevice(departed);

  assert.equal(harness.logged.filter(line => line.includes("Delaying device removal")).length, 1, "the delay is stated once, by the departure that armed it");

  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS / 2);

  assert.deepEqual(harness.unregistered, ["uuid-AABBCCDDEE99"], "the removal fires one whole delay after the first departure, not after the second");
  assert.equal(harness.clock.nextDeadline, null);
});

test("an adoption during the delay clears the removal armed against its accessory", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  const adopted = accessory("uuid-AABBCCDDEE01", { controller: CONTROLLER_MAC, id: "AABBCCDDEE01", mac: "AABBCCDDEE01" });

  harness.accessories.push(adopted);
  harness.controller.removeHomeKitDevice(adopted);

  assert.equal(harness.clock.nextDeadline, DEVICE_REMOVAL_DELAY_MS, "the departure must genuinely have armed something for the adoption to clear");

  const record = store.snapshot().devices.get("plain");

  assert.ok(record, "the store should hold the plain hub the adoption below readopts");

  // The device comes back through the adoption path, which is where a readopted device's pending removal is dropped.
  assert.equal(harness.controller.addHomeKitDevice(record), true);
  assert.equal(harness.clock.nextDeadline, null, "adoption drops the pending removal rather than leaving it to be re-checked");

  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS);

  assert.deepEqual(harness.unregistered, [], "a cleared removal must never fire");
  assert.ok(harness.accessories.includes(adopted));
});

test("the plugin's shutdown drains every pending removal without acting on any of them", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  /* Two accessories, because the drain has to reach every entry rather than one: a teardown that dropped a single timer would pass with one pending and leave the
   * other to fire against a controller that is already gone.
   */
  const first = accessory("uuid-AABBCCDDEE98", { controller: CONTROLLER_MAC, id: "AABBCCDDEE98", mac: "AABBCCDDEE98" });
  const second = accessory("uuid-AABBCCDDEE99", { controller: CONTROLLER_MAC, id: "AABBCCDDEE99", mac: "AABBCCDDEE99" });

  harness.accessories.push(first, second);
  harness.controller.removeHomeKitDevice(first);
  harness.controller.removeHomeKitDevice(second);

  assert.equal(harness.logged.filter(line => line.includes("Delaying device removal")).length, 2, "both departures must genuinely be armed");

  // The plugin's lifetime ends, which the controller composes its own terminal signal from and the removal registry drains on.
  harness.shutdown.abort();

  assert.equal(harness.clock.nextDeadline, null, "the drain empties the timeline rather than leaving the deadlines to be stepped over");

  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS);

  assert.deepEqual(harness.unregistered, [], "no deferred removal may survive the controller it belonged to");
});

test("a device leaving controller state lands in the removal half of the membership delta", () => {

  const store = createStateStore({});
  const selector = createMembershipIdsSelector();
  const present = { capabilities: ["is_hub"], device_type: "UAH", is_managed: true, mac: "aabbccddee01", name: "Hub", unique_id: "device1" };
  const other = { capabilities: ["is_hub"], device_type: "UAH", is_managed: true, mac: "aabbccddee02", name: "Other", unique_id: "device2" };

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology([ present, other ]) });

  const configured = [...selector(store.snapshot())];

  assert.deepEqual(configured, [ "device1", "device2" ]);

  // The device is unadopted, so the next refresh no longer carries it.
  store.applyRefreshDocuments({ controller: null, topology: buildingTopology([other]) });

  const { toAdd, toRemove } = membershipDelta(selector(store.snapshot()), configured);

  assert.deepEqual(toAdd, []);
  assert.deepEqual(toRemove, ["device1"], "a departed device must be the one queued for removal");
});

test("membership resolution keeps what it can project and reclaims what it cannot", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ config: { mqttTopic: "unifi/access", password: "p", username: "u" }, controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });

  /* Three cached accessories. The plain hub and the Enterprise port are both projectable, so current membership accounts for them; the record carrying no supported
   * capability is not, so nothing accounts for its accessory and it is reclaimed. An unfiltered membership set would answer the first two identically and keep the
   * third, which is the regression this arm exists to fail.
   */
  const plain = accessory("uuid-AABBCCDDEE01");
  const port = accessory("uuid-AABBCCDDEE02-PORT1");
  const unsupported = accessory("uuid-AABBCCDDEE03");

  harness.accessories.push(plain, port, unsupported);

  for(const target of [ plain, port, unsupported ]) {

    harness.controller.removeHomeKitDevice(target);
  }

  // The default removal delay is sixty seconds, so nothing has been decided yet.
  assert.equal(harness.unregistered.length, 0);

  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS);

  assert.deepEqual(harness.unregistered, ["uuid-AABBCCDDEE03"], "only the record membership cannot account for may be reclaimed");
  assert.ok(harness.accessories.includes(plain));
  assert.ok(harness.accessories.includes(port));
  assert.ok(!harness.accessories.includes(unsupported));
});

test("the adoption gate addresses one port of an Enterprise hub by that port's own identity", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const port = selectAccessPoints(store.snapshot()).find(candidate => candidate.unique_id === "entPort1");
  const plain = store.snapshot().devices.get("plain");

  assert.ok(port, "the expansion should synthesize the Enterprise hub's port");
  assert.ok(plain, "the store should hold the plain hub");

  /* The entry names the port by the qualified identity, which is the only spelling that reaches one port of a multi-door hub. The plain hub is the control: a
   * gate reaching the engine with the bare hub serial would refuse both of them, and one asking about no device at all would refuse neither.
   */
  const refused = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, options: ["Disable.Device.AABBCCDDEE02-PORT1"], store });

  assert.equal(refused.controller.addHomeKitDevice(port), false, "the entry names this port, so adoption must refuse it");
  assert.deepEqual(refused.registered, [], "and nothing may reach HomeKit on its behalf");
  assert.equal(refused.controller.addHomeKitDevice(plain), true, "the plain hub is named by nothing, so it is adopted");
  assert.deepEqual(refused.registered, ["uuid-AABBCCDDEE01"]);

  // The supersession stated as an assertion: an entry carrying no port qualifier does not address a port, so the port is adopted in spite of it.
  const bare = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, options: ["Disable.Device.AABBCCDDEE02"], store });

  assert.equal(bare.controller.addHomeKitDevice(port), true, "an entry carrying no port qualifier does not address a port of an Enterprise hub");
  assert.deepEqual(bare.registered, ["uuid-AABBCCDDEE02-PORT1"]);
});

test("the discovered line names each device by the identity an option entry and an MQTT topic address it with", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  const port = selectAccessPoints(store.snapshot()).find(candidate => candidate.unique_id === "entPort1");
  const plain = store.snapshot().devices.get("plain");

  assert.ok(port);
  assert.ok(plain);

  // A port's line carries its qualifier, which is the point of the clause: the bare MAC address addresses neither port of a multi-door hub.
  assert.ok(harness.controller.getDeviceName(port, "Front Door", true).includes("id: AABBCCDDEE02-PORT1"), "a port's line must name the port");
  assert.ok(harness.controller.getDeviceName(plain, "Plain Hub", true).includes("id: AABBCCDDEE01"), "a plain hub's line must name the hub");

  const unaddressed = createStateStore({});

  // The official API names some devices by an identifier that is not address-shaped, so the record carries no hardware identity to render.
  unaddressed.applyRefreshDocuments({ controller: null, topology: buildingTopology([
    { alias: "", capabilities: ["is_hub"], device_type: "UAH", is_managed: true, name: "Unaddressed Hub", unique_id: "device1" }
  ]) });

  const bare = unaddressed.snapshot().devices.get("device1");

  assert.ok(bare);

  const line = harness.controller.getDeviceName(bare, "Unaddressed Hub", true);

  // No fact, no clause: the line renders no label over an absent value, and composing one cannot throw on the startup path this runs on.
  assert.ok(!line.includes("id:"), "a record with no hardware identity must render no identity clause");
  assert.ok(line.includes("Unaddressed Hub"));
});

test("an abort during the connect retry rejects with the signal's own reason", async () => {

  const aborter = new AbortController();
  const reason = new Error("Shutting down.");

  aborter.abort(reason);

  // This is the boundary the controller's own catch reads to tell an orderly teardown apart from a genuine connect failure.
  await assert.rejects(async () => retry(async () => "connected", { attempts: Infinity, signal: aborter.signal }), (error: unknown) => error === reason);
});

test("a connected controller qualifies its name with the host hardware's type, and every line it prefixes carries it", async (t) => {

  const store = createStateStore({});
  const record = plainHubRecord();

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology([record]) });

  /* The controller document here answers with a hardware type and a short name at once, which is what states the resolution order out loud: the hardware type is
   * what a user sees, and the short name is the fallback for a host that reports no type at all. A composition consulting them in the other order would render the
   * short name here.
   */
  const harness = makeController({ controllerInfo: { host: { device_type: "UNVRAI8", mac: CONTROLLER_MAC, shortname: "UNVR G2 Pro" } },
    handles: new Map([[ "plain", deviceHandle(record) ]]), store });

  t.after(() => harness.shutdown.abort());

  // Before a connect there is no controller document to read a type from, so the name is the configured form alone. This is what a controller says while it is still
  // trying to reach its hardware.
  assert.equal(harness.controller.name, "1.2.3.4", "a controller that has not connected names itself by its configured address");

  await harness.controller.login();

  assert.equal(harness.controller.name, "Test Controller [UNVRAI8]");

  // The connect's own line reads through the name it just settled, so the qualification reaches the log rather than living only on the getter.
  assert.ok(harness.logged.some(line => line.startsWith("Test Controller [UNVRAI8]: Connected to 1.2.3.4 ")), "the connected line must carry the qualified name");

  const adoption = harness.logged.filter(line => line.includes("Adding"));

  /* The adoption line is where the two scopes meet: the prefix names the controller, the message names the device, and neither repeats the other. A message composing
   * the controller half itself would name this controller twice in one line, which is what the second assertion reads.
   */
  assert.deepEqual(adoption, ["Test Controller [UNVRAI8]: Plain Hub [UA Hub]: Adding UA Hub to HomeKit."]);
  assert.equal((adoption[0] ?? "").split("Test Controller").length - 1, 1, "the controller is named once in the line, by its prefix");
});

test("the bracket comes from the controller document alone: a host reporting only a short name falls through to it, and a client that reads no document renders none",
  async (t) => {

    const shortname = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC, shortname: "UNVR G2 Pro" } } });
    // A client reached with an API token alone reads no controller document for the life of the process, so this is the field shape rather than a contrived one.
    const tokenOnly = makeController({ controllerInfo: null });

    t.after(() => {

      shortname.shutdown.abort();
      tokenOnly.shutdown.abort();
    });

    await shortname.controller.login();
    await tokenOnly.controller.login();

    assert.equal(shortname.controller.name, "Test Controller [UNVR G2 Pro]");

    /* The guard the second half is here for: an unguarded append would compose a bracket over an absent type and put the literal "undefined" in front of every line
     * this controller writes, for the whole class of controllers a token reaches.
     */
    assert.equal(tokenOnly.controller.name, "Test Controller");
    assert.ok(!tokenOnly.controller.name.includes("undefined"), "a controller with no type to render must never say so out loud");
    assert.ok(tokenOnly.logged.some(line => line.startsWith("Test Controller: Connected to 1.2.3.4 ")), "and its lines carry the undecorated name");
  });

test("a token-only controller keys ownership by its configured address and reclaims nothing that names another owner", () => {

  const harness = makeController({ controllerInfo: null });

  // The controller document a MAC address comes from is credential surface, so a client holding only a token reads none and answers by its address instead.
  assert.equal(harness.controller.ownershipKey, "1.2.3.4");

  /* An accessory carrying no owner at all, and one carrying another controller's. The first is the input a direct comparison silently claimed - this controller's
   * own key read undefined and so did the context, so the two matched - which is why an implementation that compares them directly reclaims a stranger's
   * accessory here rather than leaving it alone.
   */
  const anonymous = accessory("uuid-anonymous", {});
  const stranger = accessory("uuid-stranger", { controller: "5.6.7.8" });

  harness.accessories.push(anonymous, stranger);

  harness.controller.removeHomeKitDevice(anonymous, true);
  harness.controller.removeHomeKitDevice(stranger, true);

  assert.deepEqual(harness.unregistered, [], "an accessory this controller does not own must never be unregistered");
  assert.deepEqual(harness.accessories, [ anonymous, stranger ], "and it must be left in the accessory list untouched");
});

test("a controller that has learned its MAC address still owns the accessories it adopted under its address", () => {

  const harness = makeController({ config: { password: "p", username: "u" }, controllerInfo: { host: { mac: CONTROLLER_MAC } } });

  assert.equal(harness.controller.ownershipKey, CONTROLLER_MAC);

  // The accessory carries the key this controller answered by before it read a controller document, so it is this controller's own to act on rather than an orphan.
  const carried = accessory("uuid-carried", { controller: "1.2.3.4" });

  harness.accessories.push(carried);
  harness.controller.removeHomeKitDevice(carried, true);

  assert.deepEqual(harness.unregistered, ["uuid-carried"], "an accessory keyed by this controller's prior identity is still its own");
});

test("a token-only controller publishes its telemetry under its configured address", () => {

  const harness = makeController({ controllerInfo: null });

  // No controller document means no serial, and the address is the one stable name such a controller has, exactly as its ownership key reasons.
  assert.equal(harness.controller.mqttIdentity, "1.2.3.4");
});

test("a controller that has read its document publishes its telemetry under its serial, in the same form as a device identity", () => {

  const harness = makeController({ config: { password: "p", username: "u" }, controllerInfo: { host: { mac: CONTROLLER_MAC } } });

  // The literal is deliberate: it proves the spelling the topic carries rather than agreeing with whatever the normalizer returns.
  assert.equal(harness.controller.mqttIdentity, "112233445566");
  assert.notEqual(harness.controller.mqttIdentity, harness.controller.ownershipKey, "the MQTT identity is the serial form, where the ownership key keeps the raw MAC");
});

test("an accessory created under an earlier form of the device's identity is never adopted, while one under its identity is", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  const plain = store.snapshot().devices.get("plain");

  assert.ok(plain, "the store should hold the plain hub");

  /* The accessory an earlier pairing minted, keyed by the colon-bearing spelling the controller wrote that day, beside the one this version created under the
   * device identity. Adoption reads the identity alone: the current accessory is what the device keeps, nothing is registered, and the earlier accessory is left
   * for the sweep - an adoption that looked the earlier spelling up would retire one of them here, and one that found nothing at all would register a third.
   */
  const earlier = accessory("uuid-aa:bb:cc:dd:ee:01", { controller: CONTROLLER_MAC, mac: "aa:bb:cc:dd:ee:01" });
  const current = accessory("uuid-AABBCCDDEE01", { controller: CONTROLLER_MAC, id: "AABBCCDDEE01", mac: "AABBCCDDEE01" });

  harness.accessories.push(earlier, current);

  assert.equal(harness.controller.addHomeKitDevice(plain), true);
  assert.deepEqual(harness.registered, [], "the accessory under the device identity is adopted, so nothing is registered");
  assert.deepEqual(harness.unregistered, [], "adoption retires nothing; the sweep owns the earlier accessory");
  assert.deepEqual(harness.accessories, [ earlier, current ]);
});

test("membership names a device by its identity alone, so a queued removal of an accessory keyed by an earlier form fires", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  const earlier = accessory("uuid-aa:bb:cc:dd:ee:01", { controller: CONTROLLER_MAC, mac: "aa:bb:cc:dd:ee:01" });

  harness.accessories.push(earlier);

  /* The default removal delay is sixty seconds and the fire path re-asks membership before acting. Membership names a device by its identity alone, so nothing
   * accounts for an accessory keyed by an earlier form of it - a membership set widened to earlier spellings would keep this accessory instead.
   */
  harness.controller.removeHomeKitDevice(earlier);

  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS);

  assert.deepEqual(harness.unregistered, ["uuid-aa:bb:cc:dd:ee:01"], "membership accounts for a device under its identity alone");
  assert.ok(!harness.accessories.includes(earlier));
});

test("a device the user disabled gives up the accessory under its identity, and an earlier one is the sweep's", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, options: ["Disable.Device.AABBCCDDEE01"], store });
  const plain = store.snapshot().devices.get("plain");

  assert.ok(plain);

  // The accessory under the device identity and one created under an earlier form. The gate retires the one adoption would have kept; the earlier one is not this
  // path's to judge, since the sweep accounts for it exactly as it does for every other accessory of this controller's.
  const current = accessory("uuid-AABBCCDDEE01", { controller: CONTROLLER_MAC, id: "AABBCCDDEE01", mac: "AABBCCDDEE01" });
  const earlier = accessory("uuid-aa:bb:cc:dd:ee:01", { controller: CONTROLLER_MAC, mac: "aa:bb:cc:dd:ee:01" });

  harness.accessories.push(current, earlier);

  assert.equal(harness.controller.addHomeKitDevice(plain), false);
  assert.deepEqual(harness.registered, [], "a disabled device must never reach HomeKit");
  assert.deepEqual(harness.unregistered, ["uuid-AABBCCDDEE01"]);
  assert.deepEqual(harness.accessories, [earlier]);

  const removals = harness.logged.filter(line => line.includes("Removing"));

  assert.equal(removals.length, 1);
  assert.ok(removals.every(line => line.endsWith("from HomeKit.")), "a disabled device's removal says nothing beyond the departure itself");
});

test("the accessory seed reads the spelling the library stores, and an update in another spelling moves nothing", () => {

  const store = createStateStore({});

  // The spelling a live controller writes for this hub, which the library stores in its own.
  store.applyRefreshDocuments({ controller: null, topology: buildingTopology([

    { alias: "", capabilities: ["is_hub"], device_type: "UAH", is_managed: true, mac: "aa:bb:cc:dd:ee:04", name: "Probe", unique_id: "probe" }
  ]) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  const record = store.snapshot().devices.get("probe");

  assert.ok(record);
  assert.equal(record.mac, "AABBCCDDEE04", "the library stores every MAC address it holds in one spelling");
  assert.equal(harness.controller.addHomeKitDevice(record), true);
  assert.deepEqual(harness.registered, ["uuid-AABBCCDDEE04"], "so a new accessory is minted from the stored spelling rather than from the wire's");

  /* The older notification dialect reaches the merge untranslated, which is where a re-spelling would otherwise land on the stored record. A same-identity update
   * in another spelling leaves the record's own reference in place, and that is what keeps the seed stable for the life of the process.
   */
  const before = store.snapshot().devices.get("probe");
  const packet = { data: { mac: "AA:BB:CC:DD:EE:04", name: "Probe" }, event: "access.data.device.update", event_object_id: "probe", receiver_id: "",
    save_to_history: false } as unknown as AccessEventPacket;
  const event = AccessClient.classifyPacket(packet);

  assert.ok(event, "the captured shape must classify as something the library models");
  store.dispatch(event);

  assert.equal(store.snapshot().devices.get("probe")?.mac, "AABBCCDDEE04");
  assert.equal(store.snapshot().devices.get("probe"), before, "a same-identity update in another spelling leaves the record untouched");
});

test("an accessory naming hardware this controller projects is its own to remove, and one naming nothing here is not", () => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });

  /* Both contexts name another controller, so a gate reading the key alone would leave both in place forever. The first names the plain hub's hardware in the
   * spelling that other controller wrote, which is a claim on this controller's own device that no context key can contradict, under a UUID no seed of that
   * device produces, so only a claim that reads the address can recognize it; the second names hardware nothing here projects, and is a stranger's to keep.
   */
  const claimed = accessory("uuid-stale-01", { controller: "5.6.7.8", mac: "AA:BB:CC:DD:EE:01" });
  const stranger = accessory("uuid-stranger", { controller: "5.6.7.8", mac: "aa:bb:cc:dd:ee:99" });

  harness.accessories.push(claimed, stranger);
  harness.controller.removeHomeKitDevice(claimed, true);
  harness.controller.removeHomeKitDevice(stranger, true);

  assert.deepEqual(harness.unregistered, ["uuid-stale-01"]);
  assert.deepEqual(harness.accessories, [stranger], "an accessory naming hardware this controller does not project is never its business");

  const removals = harness.logged.filter(line => line.includes("Removing"));

  assert.equal(removals.length, 1);
  assert.ok(removals.every(line => line.endsWith("from HomeKit.")), "a departure says nothing beyond itself");
});

test("a device adopted to a constructed accessory is spared by the sweep and stamped with the identity it was adopted under", async (t) => {

  const store = createStateStore({});
  const record = plainHubRecord();

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology([record]) });

  /* The client answers a handle for this record, which is what carries the adoption past the projection lookup and on into a constructed device. Every other arm
   * leaves that handle unanswered, so this is the one place the seed reaches the accessory's own configuration.
   *
   * The removal delay is turned off deliberately: a sweep that decided to remove this accessory would otherwise only ARM a timer, and an arm reading the accessory
   * list straight afterwards would find it still there and call that sparing. With no delay, the sweep's verdict is the list.
   */
  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, handles: new Map([[ "plain", deviceHandle(record) ]]),
    options: ["Disable.Controller.DelayDeviceRemoval"], store });

  t.after(() => harness.shutdown.abort());

  await harness.controller.login();

  const configured = harness.controller.configuredDevices.get("uuid-AABBCCDDEE01");

  assert.ok(configured, "the adoption runs to a configured device rather than stopping at the accessory it registered");
  assert.deepEqual(harness.registered, ["uuid-AABBCCDDEE01"], "and the accessory behind that device is the one HomeKit was told about");

  /* The sweep runs in the same unbroken pass, immediately behind the seed that configured this device, and leaves it where it is. A device configured in this very
   * pass is the case the sweep's own first test is there for.
   */
  assert.deepEqual(harness.unregistered, [], "an accessory the seed just configured is not an orphan");
  assert.deepEqual(harness.accessories.map(accessory => accessory.UUID), ["uuid-AABBCCDDEE01"], "and it stays in HomeKit");

  /* What the accessory carries for the life of the pairing, written by the adoption itself rather than by anything a test arranged: the key this controller answers
   * by, the identity the accessory was minted under, and the hardware it names. The startup sweep and the platform's reclaim each read one of the three, so an
   * adoption seeding none of them would strand this accessory at the next start.
   *
   * The hardware address is the spelling the library STORES rather than the one the fixture wrote, because the admission record comes from the reduced state and the
   * reduction normalizes it on the way in - which is what makes the accessories the sweep arms below hand-write spell it the same way.
   */
  assert.deepEqual(configured.accessory.context, { controller: CONTROLLER_MAC, id: "AABBCCDDEE01", mac: "AABBCCDDEE01" });
});

test("the first start after an identity change retires every accessory created under the earlier form, and only those", async (t) => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });

  t.after(() => harness.shutdown.abort());

  /* The cache a mixed install restores. Created by an earlier version, recording no identity: the plain hub's accessory under this controller's key, a twin of it
   * stamped by the controller this one replaced under a UUID no seed produces, an Enterprise port's, one naming a managed record this plugin cannot project, and
   * one whose hardware has left. Created by this version, recording its identity: the port's current accessory, which shares the earlier one's MAC address, and
   * one whose hardware has left. And two strangers: one naming nothing here, and one naming that same unprojectable record, which no claim of this controller's
   * may reach. The sweep must part them three ways - retired at once, delayed as a departure, and left
   * alone - reading the identity record rather than whether the hardware happens to be present.
   */
  const staleOurs = accessory("uuid-aa:bb:cc:dd:ee:01", { controller: CONTROLLER_MAC, mac: "aa:bb:cc:dd:ee:01" });
  const staleStranded = accessory("uuid-stranded-01", { controller: "68:d7:9a:60:f6:f8", mac: "AA:BB:CC:DD:EE:01" });
  const stalePort = accessory("uuid-aa:bb:cc:dd:ee:02-PORT1", { controller: CONTROLLER_MAC, mac: "aa:bb:cc:dd:ee:02" });
  const currentPort = accessory("uuid-AABBCCDDEE02-PORT1", { controller: CONTROLLER_MAC, id: "AABBCCDDEE02-PORT1", mac: "AABBCCDDEE02" });
  const unprojected1x = accessory("uuid-aa:bb:cc:dd:ee:03", { controller: CONTROLLER_MAC, mac: "aa:bb:cc:dd:ee:03" });
  const unprojectedForeign = accessory("uuid-stale-03", { controller: "5.6.7.8", mac: "aa:bb:cc:dd:ee:03" });
  const departed1x = accessory("uuid-aa:bb:cc:dd:ee:99", { controller: CONTROLLER_MAC, mac: "aa:bb:cc:dd:ee:99" });
  const departedCurrent = accessory("uuid-AABBCCDDEE98", { controller: CONTROLLER_MAC, id: "AABBCCDDEE98", mac: "AABBCCDDEE98" });
  const stranger = accessory("uuid-stranger", { controller: "5.6.7.8", mac: "aa:bb:cc:dd:ee:99" });

  harness.accessories.push(staleOurs, staleStranded, stalePort, currentPort, unprojected1x, unprojectedForeign, departed1x, departedCurrent, stranger);

  await harness.controller.login();

  /* The seed adds the plain hub under its identity and adopts the port's current accessory, and the sweep that follows it retires the five accessories that record
   * no identity at once, saying why. The seed and the sweep run inside login() itself, so nothing here waits on a timer.
   */
  const reason = "It carries no record of the device identity this version keys accessories by.";

  assert.deepEqual(harness.registered, ["uuid-AABBCCDDEE01"]);
  assert.deepEqual(harness.unregistered, [ "uuid-aa:bb:cc:dd:ee:01", "uuid-stranded-01", "uuid-aa:bb:cc:dd:ee:02-PORT1", "uuid-aa:bb:cc:dd:ee:03",
    "uuid-aa:bb:cc:dd:ee:99" ], "an accessory recording no identity was created under an earlier form and goes at once, its hardware present or not");

  const immediate = harness.logged.filter(line => line.includes("Removing"));

  assert.equal(immediate.length, 5);
  assert.ok(immediate.every(line => line.endsWith(reason)));
  const delayed = harness.logged.filter(line => line.includes("Delaying device removal"));

  assert.equal(delayed.length, 1, "the one accessory recording an identity nothing projects is a departure");

  // The departure honors the delay and the queue's own membership read, and its removal line carries no reason; the port's current accessory and both
  // strangers are untouched - the one naming the unprojectable record above all, since a claim walked over unfiltered membership would have taken it.
  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS);

  assert.deepEqual(harness.unregistered.slice(5), ["uuid-AABBCCDDEE98"]);
  assert.ok(harness.logged.filter(line => line.includes("Removing")).slice(5).every(line => line.endsWith("from HomeKit.")));
  assert.deepEqual(harness.accessories.filter(x => x.UUID !== "uuid-AABBCCDDEE01"), [ currentPort, unprojectedForeign, stranger ]);
});

test("a disabled device's earlier accessory is retired at the first start with its reason, though nothing is added in its place", async (t) => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, options: ["Disable.Device.AABBCCDDEE01"], store });

  t.after(() => harness.shutdown.abort());

  // The plain hub is disabled, so the seed adds nothing under its identity, and the sweep still retires the accessory created under the earlier form - the
  // decision reads the identity record, never whether a replacement exists.
  const earlier = accessory("uuid-aa:bb:cc:dd:ee:01", { controller: CONTROLLER_MAC, mac: "aa:bb:cc:dd:ee:01" });

  harness.accessories.push(earlier);

  await harness.controller.login();

  assert.deepEqual(harness.registered, ["uuid-AABBCCDDEE02-PORT1"], "the port is added; the disabled hub is not");
  assert.deepEqual(harness.unregistered, ["uuid-aa:bb:cc:dd:ee:01"]);

  const removals = harness.logged.filter(line => line.includes("Removing"));

  assert.equal(removals.length, 1);
  assert.ok(removals.every(line => line.endsWith("It carries no record of the device identity this version keys accessories by.")));
});

test("a controller the user disabled takes every accessory it can claim out of HomeKit at once, by key or by identity", async (t) => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  // The controller's own scope disables it, which is the gate that runs after connect rather than the global one before it.
  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, options: ["Disable.Device." + serialForm(CONTROLLER_MAC)], store });

  t.after(() => harness.shutdown.abort());

  /* One accessory this version created under this controller's key, one an earlier version created that another controller stamped but that names the
   * Enterprise hub's hardware - which its port shares, so the claim lands at the hardware grain where a serial set built from port-qualified identities would
   * miss it - and a stranger naming nothing here. The disabled pass retires what the predicate claims, directly and without a delay.
   */
  const ours = accessory("uuid-AABBCCDDEE01", { controller: CONTROLLER_MAC, id: "AABBCCDDEE01", mac: "AABBCCDDEE01" });
  const foreign1x = accessory("uuid-stranded-02", { controller: "68:d7:9a:60:f6:f8", mac: "aa:bb:cc:dd:ee:02" });
  const stranger = accessory("uuid-stranger", { controller: "5.6.7.8", mac: "aa:bb:cc:dd:ee:99" });

  harness.accessories.push(ours, foreign1x, stranger);

  await harness.controller.login();

  assert.ok(harness.logged.some(line => line.includes("Disabling this UniFi Access controller in HomeKit.")));
  assert.deepEqual(harness.registered, [], "a disabled controller adds nothing");
  assert.deepEqual(harness.unregistered, [ "uuid-AABBCCDDEE01", "uuid-stranded-02" ]);
  assert.deepEqual(harness.accessories, [stranger]);
  assert.equal(harness.logged.filter(line => line.includes("Delaying device removal")).length, 0, "the disabled pass never queues");
});

test("login reports the identity outcome its exit took", async (t) => {

  const running = createStateStore({});

  running.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const reporting = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store: running });

  t.after(() => reporting.shutdown.abort());

  assert.equal(await reporting.controller.login(), "reporting", "a controller that connected and serves its membership says so");

  /* The global gate turns a login back before it ever connects, and the harness's own port cannot witness a connect that never happened - so this arm stands its
   * controller up over a port that counts what it was asked for. The double carries only what the constructor and this exit read.
   */
  const shutdown = new AbortController();

  let connects = 0;

  const gatedPlatform = makePlatformDouble({ entries: ["Disable.Device"], signal: shutdown.signal });

  const gated = new AccessController(gatedPlatform, { address: "1.2.3.4" }, async (): Promise<AccessClient> => {

    connects++;

    return clientDouble({ controllerInfo: null, store: createStateStore({}) });
  });

  t.after(() => shutdown.abort());

  assert.equal(await gated.login(), "unavailable", "a login the global gate turns back never learned an identity");
  assert.equal(connects, 0, "and it never reached the controller to ask for one");

  // The controller's own scope disables it after the connect, so it knows exactly who it is even though it will serve nothing.
  const turnedOff = createStateStore({});

  turnedOff.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const disabled = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, options: ["Disable.Device." + serialForm(CONTROLLER_MAC)],
    store: turnedOff });

  t.after(() => disabled.shutdown.abort());

  disabled.accessories.push(accessory("uuid-AABBCCDDEE01", { controller: CONTROLLER_MAC, id: "AABBCCDDEE01", mac: "AABBCCDDEE01" }));

  assert.equal(await disabled.controller.login(), "disabled", "a controller the user turned off in HomeKit connected first, so its identity is settled");
  assert.deepEqual(disabled.unregistered, ["uuid-AABBCCDDEE01"], "and it still takes the accessories it answered for with it");
});

test("a login whose connect exhausts its authentication budget reports no identity", async (t) => {

  const clock = new TestClock();
  const shutdown = new AbortController();

  let attempts = 0;

  const platform = makePlatformDouble({ clock, signal: shutdown.signal });

  /* Credentials the controller refuses on every attempt. Auth faults get a small consecutive budget so a controller still sorting out its own auth state
   * recovers, and this spends the whole of it...the waits between attempts are armed on the platform's clock, so the drain below walks the ladder on virtual time
   * and the arm reads what the policy waited rather than waiting it out.
   */
  const controller = new AccessController(platform, { address: "1.2.3.4" }, async (): Promise<AccessClient> => {

    attempts++;

    throw new AccessAuthError("Bad credentials.");
  });

  t.after(() => shutdown.abort());

  // The login is started rather than awaited, because the waits it is about are only registered once it is running and nothing else would step them.
  const login = controller.login();
  const steps = await drainClock(clock);

  assert.equal(await login, "unavailable", "a connect that never succeeded leaves this controller's identity unknown");
  assert.equal(attempts, ACCESS_CONTROLLER_AUTH_FAILURE_LIMIT, "and the budget is what stopped it, rather than a retry without end");
  assert.equal(steps, ACCESS_CONTROLLER_AUTH_FAILURE_LIMIT - 1, "one wait between each pair of attempts, and none after the attempt that spent the budget");
  assert.equal(clock.now(), AUTH_BUDGET_BACKOFF_MS, "and the whole of what it waited is the two waits that ladder prescribes");
  assert.equal(AUTH_BUDGET_BACKOFF_MS, defaultRetryBackoff(2) + defaultRetryBackoff(3),
    "so a change to the library's ladder reddens this arm rather than drifting past it");
});

test("an accessory under the device identity that records none is adopted rather than retired, because membership is read before the record", async (t) => {

  const store = createStateStore({});

  store.applyRefreshDocuments({ controller: null, topology: buildingTopology(enterpriseDevices()) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });

  t.after(() => harness.shutdown.abort());

  /* The accessory under the plain hub's own identity, carrying no identity record - the shape an older version's run leaves behind when it wipes the context of
   * an accessory this version created. The seed adopts it by its UUID, so nothing is registered for the hub, and the sweep must leave it alone because
   * membership accounts for it whatever its record says: a sweep that read the record first would retire the identity's own accessory.
   */
  const wiped = accessory("uuid-AABBCCDDEE01", { controller: CONTROLLER_MAC, mac: "AABBCCDDEE01" });

  harness.accessories.push(wiped);

  await harness.controller.login();

  assert.deepEqual(harness.registered, ["uuid-AABBCCDDEE02-PORT1"], "the hub's accessory is adopted, so only the port is added");
  assert.deepEqual(harness.unregistered, [], "an accessory membership accounts for is never the sweep's to retire");
  assert.ok(harness.accessories.includes(wiped));
});

test("an orphan is named from the controller's own record whichever spelling its context carries", () => {

  const store = createStateStore({});

  /* The record carrying no hardware identity is listed first deliberately: the walk returns on its first match, so a mac-less record placed after the matching one
   * is never visited and a fold reading its absent address would go unexercised.
   */
  store.applyRefreshDocuments({ controller: null, topology: buildingTopology([

    { alias: "", capabilities: ["is_hub"], device_type: "UAH", is_managed: true, name: "Unaddressed Hub", unique_id: "device0" }, ...enterpriseDevices()
  ]) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });

  // A cached accessory whose context carries the colon-bearing spelling the controller wrote when it was created, which is what the naming fold has to resolve.
  const stale = { UUID: "uuid-aa:bb:cc:dd:ee:01", context: { controller: CONTROLLER_MAC, mac: "aa:bb:cc:dd:ee:01" },
    displayName: "Stale Twin" } as unknown as AccessAccessory;

  harness.accessories.push(stale);
  harness.controller.removeHomeKitDevice(stale, true);

  assert.deepEqual(harness.unregistered, ["uuid-aa:bb:cc:dd:ee:01"]);

  const removals = harness.logged.filter(line => line.includes("Removing"));

  assert.equal(removals.length, 1);
  assert.ok(removals.every(line => line.includes("Plain Hub")), "the controller's own record is what names an accessory it never configured");
  assert.ok(!removals.some(line => line.includes("Stale Twin")));
});

test("a record whose hardware identity never arrived is admitted to nothing", () => {

  const store = createStateStore({});

  // The official API names a device by an identifier that is not always address-shaped, and the projection leaves the hardware identity absent when it is not.
  store.applyRefreshDocuments({ controller: null, topology: buildingTopology([

    { alias: "", capabilities: ["is_hub"], device_type: "UAH", is_managed: true, name: "Unaddressed Hub", unique_id: "device1" }
  ]) });

  const harness = makeController({ controllerInfo: { host: { mac: CONTROLLER_MAC } }, store });
  const record = store.snapshot().devices.get("device1");

  assert.ok(record, "the store should hold the record the topology carried");
  assert.equal(record.mac, undefined, "and it should hold it with no hardware identity, which is what this arm is about");

  // Adoption refuses it outright: there is no identity to derive an accessory from, so nothing is registered and nothing is tracked.
  assert.equal(harness.controller.addHomeKitDevice(record), false);
  assert.deepEqual(harness.registered, [], "a record with no hardware identity must never reach HomeKit");
  assert.equal(harness.controller.configuredDevices.size, 0);

  /* Membership never names it either, so nothing can account for an accessory derived from it and the sweep reclaims one. An implementation that composed an
   * identity anyway would derive this accessory's own UUID for the record, claim it, and keep it.
   */
  const orphan = accessory("uuid-undefined");

  harness.accessories.push(orphan);
  harness.controller.removeHomeKitDevice(orphan);

  harness.clock.advance(DEVICE_REMOVAL_DELAY_MS);

  assert.deepEqual(harness.unregistered, ["uuid-undefined"], "a record with no hardware identity can account for no accessory");
});

test("the plugin's shutdown reaches a controller through the one signal every controller composes from", async () => {

  const disposals: string[] = [];
  const harness = makeController({ config: { password: "p", username: "u" }, controllerInfo: { host: { mac: CONTROLLER_MAC } } });

  harness.controller.client = {

    controllerInfo: { host: { mac: CONTROLLER_MAC } },
    official: null,
    state: createStateStore({}),
    [Symbol.asyncDispose]: async (): Promise<void> => void disposals.push("client")
  } as unknown as AccessClient;

  assert.equal(harness.controller.signal.aborted, false);
  assert.equal(harness.controller.logApiErrors, true);

  // The plugin's lifetime ends. The controller registered nothing on the Homebridge API of its own, so this is the only thing that can reach it.
  harness.shutdown.abort();

  /* Three effects follow from that one abort: this controller's own terminal signal fires, the phase moved to its terminal state - which the public error-logging
   * projection is what reports - and the client was disposed. A wiring that aborted the signal without transitioning or disconnecting satisfies only the first.
   */
  assert.equal(harness.controller.signal.aborted, true);
  assert.equal(harness.controller.logApiErrors, false);

  // The teardown is dispatched rather than awaited, so it settles on the next turn.
  await settle();

  assert.deepEqual(disposals, ["client"], "the client must be disposed, and exactly once");
});

/* The webhook harness: a real AccessController driven through a real login(), over a client the connect port answers with.
 *
 * Everything the controller reaches outside itself is a double that records what it was asked for, in order, into one list - so an arm reads the sequence of acts
 * rather than a set of independent spies that cannot say what happened before what.
 */
interface WebhookOptions {

  // Every controller the plugin is configured for, which is what the orphan sweep reads to decide which paths are claimed. The controller under test is the
  // default, so an arm names this only to put a sibling entry beside it.
  controllers?: { address: string }[];
  duplicatePath?: boolean;
  enabled?: boolean;
  endpoints?: AccessOfficialWebhookEndpoint[];
  failures?: Record<string, Error>;
  hostResolution?: () => Promise<string>;
  listenerFailed?: boolean;
  official?: boolean;
  onCreate?: () => void;
  options?: string[];
}

interface WebhookHarness {

  calls: string[];
  // The clock this controller judges a delivery's age against, so an arm about staleness moves time rather than backdating a header.
  clock: TestClock;
  controller: AccessController;
  deliveries: unknown[];
  lines: string[];
  listener: TestHttpListener;
  listenerRequests: number;
  run: () => Promise<void>;
  shutdown: AbortController;
}

// The registration this controller composes for itself, which several arms compare against.
const WEBHOOK_PATH = "/unifi-access/1.2.3.4";
const WEBHOOK_URL = "http://10.0.0.7:10120" + WEBHOOK_PATH;
const WEBHOOK_NAME = "Homebridge UniFi Access (1.2.3.4)";

// One registration as the controller lists it back.
function endpointRecord(overrides: { endpoint?: string; id: string; name?: string; secret?: string }): AccessOfficialWebhookEndpoint {

  return { endpoint: overrides.endpoint ?? WEBHOOK_URL, events: ACCESS_WEBHOOK_EVENT_LIST, id: overrides.id, name: overrides.name ?? WEBHOOK_NAME,
    secret: overrides.secret ?? "secret-" + overrides.id };
}

// Sign a body exactly as the controller does, so a delivery arm can present a genuine one.
function sign(secret: string, timestampSeconds: number, body: string): string {

  return "t=" + timestampSeconds.toString() + ",v1=" + createHmac("sha256", secret).update(timestampSeconds.toString()).update(".").update(body).digest("hex");
}

function makeWebhookController(options: WebhookOptions = {}): WebhookHarness {

  const calls: string[] = [];
  const clock = new TestClock();
  const deliveries: unknown[] = [];
  const lines: string[] = [];
  const shutdown = new AbortController();
  /* The registrations this controller currently holds. The double keeps them the way the controller would, because an arm that creates one and then tears down
   * has to find it listed back or the teardown it is testing has nothing to retire.
   */
  const endpoints = options.endpoints ?? [];
  const failures = new Map(Object.entries(options.failures ?? {}));
  let listenerRequests = 0;

  // Refuse a call the arm asked to fail, after recording that it was made - a refusal is still an act the sequence should show.
  const refuse = (name: string): void => {

    const failure = failures.get(name);

    if(failure) {

      throw failure;
    }
  };

  const official = {

    webhooks: {

      createEndpoint: async (write: AccessOfficialWebhookEndpointWrite): Promise<AccessOfficialWebhookEndpoint> => {

        calls.push("create");
        refuse("create");
        options.onCreate?.();

        const minted = { ...write, id: "minted", secret: "minted-secret" };

        endpoints.push(minted);

        return minted;
      },
      deleteEndpoint: async (id: string): Promise<void> => {

        calls.push("delete:" + id);
        refuse("delete");
        endpoints.splice(endpoints.findIndex(record => record.id === id), 1);
      },
      fetchAllEndpoints: async (): Promise<AccessOfficialWebhookEndpoint[]> => {

        calls.push("fetch");
        refuse("fetch");

        return [...endpoints];
      },
      updateEndpoint: async (id: string, write: AccessOfficialWebhookEndpointWrite): Promise<AccessOfficialWebhookEndpoint> => {

        calls.push("update:" + id);
        refuse("update");

        const rewritten = { ...write, id, secret: "updated-secret" };

        endpoints.splice(endpoints.findIndex(record => record.id === id), 1, rewritten);

        return rewritten;
      }
    }
  } as unknown as OfficialApi;

  const listener = new TestHttpListener({ signal: shutdown.signal });

  // A path this arm claims before the controller can, which is what two controller entries configured with one address collide over. Registered through the
  // double's own method ahead of the recording below, because claiming it is the arm's act rather than one of the controller's.
  if(options.duplicatePath === true) {

    listener.route(WEBHOOK_PATH, () => ({ status: 200 }));
  }

  /* A listener whose lifetime ended on a bind failure it already reported, which is the condition that actually reaches the controller's refusal branch. The
   * double refuses every registration afterwards by throwing that reason, exactly as the listener does.
   */
  if(options.listenerFailed === true) {

    listener.abort(new HbpuAbortError("failed"));
  }

  /* Every act the controller performs goes into one sequence, its route registration included, so an arm reads that the route came up between the mint and the
   * orphan sweep rather than only that it exists once everything is done. The double answers the registration itself; this records that it was asked for.
   */
  const register: TestHttpListener["route"] = listener.route.bind(listener);

  listener.route = (path, handler, routeOptions): Disposable => {

    const handle = register(path, handler, routeOptions);

    calls.push("route:" + String(path));

    return handle;
  };

  const store = createStateStore({});

  const client = clientDouble({ controllerInfo: { host: { firmware_version: "4.0.0", mac: CONTROLLER_MAC }, version: "2.0.0" },
    official: (options.official === false) ? null : official, onDispose: (): void => void calls.push("dispose"), store });

  const entries = options.options ?? [];

  if(options.enabled !== false) {

    entries.push("Enable.Controller.Webhooks");
  }

  const platform = makePlatformDouble({

    api: {

      hap: { uuid: { generate: (input: string): string => "uuid-" + input } },
      on: (): void => undefined,
      registerPlatformAccessories: (): void => undefined,
      unregisterPlatformAccessories: (): void => undefined,
      updatePlatformAccessories: (): void => undefined
    },
    clock,
    config: { controllers: options.controllers ?? [{ address: "1.2.3.4" }], options: [] },
    entries,
    localAddressFor: options.hostResolution ?? (async (): Promise<string> => "10.0.0.7"),
    log: {

      error: (message: string, ...parameters: unknown[]): void => void lines.push("error: " + format(message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => void lines.push("info: " + format(message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => void lines.push("warn: " + format(message, ...parameters))
    },
    signal: shutdown.signal,
    // The double stands in for the listener, cast at the injection site exactly as the double's own documentation states: both classes carry private fields, so
    // nothing structural assigns one to the other and the cast is this file's own statement that the substitution is deliberate.
    webhookListener: (): HttpListener => {

      listenerRequests++;

      return listener as unknown as HttpListener;
    },
    webhookPort: 10120
  });

  const connect: AccessControllerConnect = async (): Promise<AccessClient> => client;
  const controller = new AccessController(platform, { address: "1.2.3.4", tokens: { access: "t" } }, connect);

  return {

    calls,
    clock,
    controller,
    deliveries,
    lines,
    listener,
    get listenerRequests(): number {

      return listenerRequests;
    },
    run: async (): Promise<void> => {

      await controller.login();

      // Deliveries reach the accessories through the bridge, so listening on it is how an arm sees what the route admitted.
      controller.events.on(ACCESS_WEBHOOK_EVENT_PREFIX + ACCESS_WEBHOOK_EVENTS.doorUnlock, (delivery: unknown) => void deliveries.push(delivery));

      await settle(DISPATCH_SETTLE_TURNS);
    },
    shutdown
  };
}

test("with webhooks off, a controller lists its endpoints once, clears its own, and binds nothing", async (t) => {

  const harness = makeWebhookController({ enabled: false, endpoints: [endpointRecord({ id: "stale" })] });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  /* Turning the option off cleans the controller rather than leaving it delivering to a port nothing listens on. The listing is the one new act a default
   * configuration performs, and it happens after the observers rather than on the startup path.
   */
  assert.deepEqual(harness.calls, [ "fetch", "delete:stale" ]);
  assert.equal(harness.listenerRequests, 0, "a plugin with webhooks off must never construct a listener");
  assert.equal(harness.listener.routes.size, 0);
});

test("with webhooks on but no published API to register through, a controller says so and binds nothing", async (t) => {

  const harness = makeWebhookController({ official: false });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  assert.ok(harness.lines.some(line => line.includes("Webhooks require an API token with webhook permissions for this controller.")), "the reason must be named");
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.listenerRequests, 0);
});

test("a controller with nothing registered mints a registration and routes it, in that order", async (t) => {

  const harness = makeWebhookController();

  t.after(() => harness.shutdown.abort());

  await harness.run();

  /* The route is registered only after the endpoint is in hand, which is what closes the window in which a delivery could arrive at a route with no secret to
   * verify it against.
   */
  assert.deepEqual(harness.calls, [ "fetch", "create", "route:" + WEBHOOK_PATH ]);
  assert.ok(harness.lines.some(line => line.includes("Registered for Access webhook deliveries at " + WEBHOOK_URL + ".")), "the registration must be reported");
});

test("a registration describing something else is rewritten in place rather than duplicated", async (t) => {

  // The same path on a different host, which is what a moved Homebridge host leaves behind at the controller.
  const harness = makeWebhookController({ endpoints: [endpointRecord({ endpoint: "http://10.9.9.9:10120" + WEBHOOK_PATH, id: "moved" })] });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  assert.deepEqual(harness.calls, [ "fetch", "update:moved", "route:" + WEBHOOK_PATH ]);
});

test("a registration that already says what we want is taken as it stands", async (t) => {

  const harness = makeWebhookController({ endpoints: [endpointRecord({ id: "existing" })] });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  // Nothing is minted and nothing is rewritten, which is what keeps the secret the controller already holds and makes a restart cost it nothing.
  assert.deepEqual(harness.calls, [ "fetch", "route:" + WEBHOOK_PATH ]);
});

test("registrations that piled up at one path are cleared, and the one being reused is not", async (t) => {

  const harness = makeWebhookController({ endpoints: [ endpointRecord({ id: "keep" }), endpointRecord({ endpoint: "http://10.9.9.9:10120" + WEBHOOK_PATH,
    id: "leftover" }) ] });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  // Exactly one deletion, and it names the second record. An implementation sweeping every match at the path would delete the one it is about to reuse.
  assert.deepEqual(harness.calls, [ "fetch", "delete:leftover", "route:" + WEBHOOK_PATH ]);
});

// The registration a controller configured at 9.9.9.9 held at this install's own authority, before the user re-addressed it to the 1.2.3.4 under test.
const ABANDONED_PATH = "/unifi-access/9.9.9.9";
const ABANDONED_NAME = "Homebridge UniFi Access (9.9.9.9)";

function abandonedRecord(): AccessOfficialWebhookEndpoint {

  return endpointRecord({ endpoint: "http://10.0.0.7:10120" + ABANDONED_PATH, id: "abandoned", name: ABANDONED_NAME });
}

test("a registration this plugin holds at an address no configured controller answers for is removed once the route is live", async (t) => {

  const harness = makeWebhookController({ endpoints: [abandonedRecord()] });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  /* The sweep reads the listing this attempt already took, so reconciling still costs one read, and it runs last - after the route is live - so a refusal can
   * never cost the user the registration this attempt just made.
   */
  assert.deepEqual(harness.calls, [ "fetch", "create", "route:" + WEBHOOK_PATH, "delete:abandoned" ]);
  assert.ok(harness.lines.some(line => line.includes("Removed a webhook registration this plugin left at a controller address it is not configured for: " +
    ABANDONED_NAME + ".")), "the removal must name the registration it removed");
});

test("a registration at a sibling controller's own path is left where it is", async (t) => {

  const harness = makeWebhookController({ controllers: [ { address: "1.2.3.4" }, { address: "5.6.7.8" } ],
    endpoints: [endpointRecord({ endpoint: "http://10.0.0.7:10120/unifi-access/5.6.7.8", id: "sibling", name: "Homebridge UniFi Access (5.6.7.8)" })] });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  // A path another configured controller answers for is that controller's own, and a sweep that reached it would have one controller deleting its sibling's work.
  assert.deepEqual(harness.calls, [ "fetch", "create", "route:" + WEBHOOK_PATH ]);
});

test("a controller that refuses the sweep keeps the webhooks it just configured", async (t) => {

  const harness = makeWebhookController({ endpoints: [abandonedRecord()],
    failures: { delete: new AccessOfficialApiError("The controller refused the request.", { code: "CODE_OPERATION_FORBIDDEN" }) } });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  /* The refusal costs the orphan and nothing else: the route is live, the registration is reported, and the deletion says why at debug alone - a controller that
   * will not clean up after a re-addressing is not something to put an error in front of the user about.
   */
  assert.deepEqual(harness.calls, [ "fetch", "create", "route:" + WEBHOOK_PATH, "delete:abandoned" ]);
  assert.ok(harness.listener.routes.has(WEBHOOK_PATH), "the route must survive a sweep the controller refused");
  assert.ok(harness.lines.some(line => line.includes("Registered for Access webhook deliveries at " + WEBHOOK_URL + ".")), "the registration must still be reported");
  assert.ok(!harness.lines.some(line => line.startsWith("error: ") || line.startsWith("warn: ")), "a refused sweep must not raise its voice");
});

test("a controller refused its route removes the registration its own attempt created", async (t) => {

  // Two controller entries configured with one address collide on the path, which is the unsupported configuration this arm stands for.
  const harness = makeWebhookController({ duplicatePath: true });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  assert.deepEqual(harness.calls, [ "fetch", "create", "delete:minted" ]);
  assert.ok(harness.lines.some(line => line.startsWith("error: ") && line.includes("already routes")), "the refusing condition must be named");
  assert.ok(!harness.lines.some(line => line.includes("Registered for Access webhook deliveries")), "a controller that never routed must not claim it registered");
});

test("a controller that meets a listener whose lifetime already ended reports it and holds no registration", async (t) => {

  const harness = makeWebhookController({ listenerFailed: true });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  /* The plugin's own sentence carries the library's message, composed here rather than retyped, so a change to the library's wording reddens this arm instead
   * of a stale literal quietly agreeing with nothing.
   */
  assert.deepEqual(harness.calls, [ "fetch", "create", "delete:minted" ]);
  assert.ok(harness.lines.some(line => line.startsWith("error: ") && line.includes("Unable to receive Access webhook deliveries. " +
    new HbpuAbortError("failed").message)), "the refusing condition must be named");
  assert.ok(!harness.lines.some(line => line.includes("Registered for Access webhook deliveries")));
});

test("a host that does not resolve fails the registration and leaves nothing behind", async (t) => {

  const harness = makeWebhookController({ hostResolution: async (): Promise<string> => {

    throw new Error("getaddrinfo ENOTFOUND access.local");
  } });

  t.after(() => harness.shutdown.abort());

  await harness.run();

  /* The probe reports a lookup it could not answer rather than handing back an address that means nothing, so the attempt stops before it asks the controller
   * for anything at all and no endpoint is ever composed against a host this plugin cannot be reached at.
   */
  assert.deepEqual(harness.calls, []);
  assert.ok(harness.lines.some(line => line.startsWith("error: ") && line.includes("Unable to determine the address the Access controller can reach this " +
    "plugin on: getaddrinfo ENOTFOUND access.local.")), "the failure must name what could not be resolved");
  assert.equal(harness.listener.routes.size, 0, "a controller that never learned its address must route nothing");
});

test("a shutdown landing while the address lookup is pending is the teardown it is rather than a failure to report", async (t) => {

  /* A lookup left pending, which is what one looks like while a resolver is not answering, and the arm below is what ends it. Debug is turned on because the
   * line this arm is about is a debug line: an orderly teardown is not something the user is told about at any louder level.
   */
  let refuse: (reason: unknown) => void = (): void => undefined;
  const harness = makeWebhookController({ hostResolution: async (): Promise<string> => new Promise<string>((_resolve, reject) => { refuse = reject; }),
    options: ["Enable.Log.Debug"] });

  t.after(() => harness.shutdown.abort());

  await harness.controller.login();
  await settle(DISPATCH_SETTLE_TURNS);

  /* The plugin's lifetime is what ends a lookup still in flight, because the platform hands its own signal to the library's probe and the probe rejects with that
   * signal's reason. Both halves of that happen here: the signal fires, and the wait it was handed to refuses exactly as the probe would.
   */
  harness.shutdown.abort();
  refuse(new HbpuAbortError("shutdown"));

  await settle(DISPATCH_SETTLE_TURNS);

  // An orderly teardown is not something to put an error in front of the user about, so the shutdown line stands in for the one the failure path would write.
  assert.ok(!harness.lines.some(line => line.includes("Unable to determine the address")), "an orderly teardown must not read as a host that could not be reached");
  assert.ok(harness.lines.some(line => line.includes("The webhook configuration ended with a shutdown in progress: shutdown.")), "the teardown must say so at debug");
  assert.equal(harness.listener.routes.size, 0, "and nothing may be routed against a controller that is going away");
});

test("a shutdown arriving mid-configuration removes the registration the attempt had just minted", async (t) => {

  /* The plugin goes away in the window between minting a registration and routing it. Nothing would ever retire that record, so the attempt undoes its own rather
   * than leaving the controller delivering to a plugin that is not there.
   */
  let interrupt: () => void = (): void => undefined;
  const harness = makeWebhookController({ onCreate: (): void => interrupt() });

  interrupt = (): void => harness.shutdown.abort();

  t.after(() => harness.shutdown.abort());

  await harness.controller.login();
  await settle(DISPATCH_SETTLE_TURNS);

  assert.ok(harness.calls.includes("delete:minted"), "a registration minted into a shutdown must be undone");
  assert.equal(harness.listener.routes.size, 0, "and nothing may be routed against a controller that is going away");
});

test("a token that cannot manage endpoints is told what to grant, whichever way the controller refuses", async (t) => {

  const refused = async (failure: Error): Promise<string[]> => {

    const harness = makeWebhookController({ failures: { fetch: failure } });

    t.after(() => harness.shutdown.abort());

    await harness.run();

    return harness.lines;
  };

  const permissions = await refused(new AccessAuthorizationError("The account lacks the privileges this operation requires on the UniFi Access controller."));
  const envelope = await refused(new AccessOfficialApiError("The controller refused the request.", { code: "CODE_OPERATION_FORBIDDEN" }));

  // Both refusal classes reach the same remediation, because both mean the same thing to the person who has to act on it.
  for(const lines of [ permissions, envelope ]) {

    assert.ok(lines.some(line => line.startsWith("warn: ") && line.includes("The API token cannot manage webhook endpoints") && line.includes(WEBHOOK_URL)),
      "the remediation must name the URL to register by hand");
  }
});

test("turning a controller off in HomeKit retires the registration the option left behind", async (t) => {

  // The controller's own scope disables it, which is the gate that runs after connect rather than the global one before it.
  const harness = makeWebhookController({ endpoints: [endpointRecord({ id: "stale" })], options: ["Disable.Device." + serialForm(CONTROLLER_MAC)] });

  t.after(() => harness.shutdown.abort());

  await harness.controller.login();
  await settle(DISPATCH_SETTLE_TURNS);

  // The retirement runs while the client is still alive, because deleting a registration is an official call like any other.
  assert.deepEqual(harness.calls, [ "fetch", "delete:stale", "dispose" ]);
});

test("teardown retires the registration before the client goes away, and does nothing when none was held", async (t) => {

  const holding = makeWebhookController();

  t.after(() => holding.shutdown.abort());

  await holding.run();

  assert.deepEqual(holding.calls, [ "fetch", "create", "route:" + WEBHOOK_PATH ]);

  holding.shutdown.abort();
  await settle(DISPATCH_SETTLE_TURNS);

  // The delete needs the client alive, so it must precede the disposal rather than race it.
  assert.deepEqual(holding.calls.slice(3), [ "fetch", "delete:minted", "dispose" ]);

  const empty = makeWebhookController({ enabled: false });

  t.after(() => empty.shutdown.abort());

  await empty.run();
  empty.shutdown.abort();
  await settle(DISPATCH_SETTLE_TURNS);

  // A controller holding no registration owes teardown nothing beyond disposing its client.
  assert.deepEqual(empty.calls, [ "fetch", "dispose" ]);
});

test("the route admits a genuine delivery once and refuses everything else about it", async (t) => {

  const harness = makeWebhookController();

  t.after(() => harness.shutdown.abort());

  await harness.run();

  assert.ok(harness.listener.routes.has(WEBHOOK_PATH), "the controller should have routed its own path");

  const body = JSON.stringify({ data: { actor: null, device: null, location: { id: "door1", name: "Front Door" }, object: {} },
    event: ACCESS_WEBHOOK_EVENTS.doorUnlock, event_object_id: "delivery1" });
  /* The moment a delivery is stamped with, read from the same clock the controller judges its age against and re-read after each advance below. A header composed
   * from the wall clock would be judged against virtual time and come out arbitrarily old.
   */
  const now = (): number => Math.floor(harness.clock.now() / 1000);

  // Nothing to verify against.
  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from(body), headers: {} }).status, 401);

  /* A well-formed header that fails the code is a secret mismatch or a forgery, and the first is worth one breadcrumb per registration. A second failure must not
   * add a second line, or a forger could fill the log at will.
   */
  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from(body),
    headers: { signature: sign("the-wrong-secret", now(), body) } }).status, 401);
  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from(body),
    headers: { signature: sign("the-wrong-secret", now(), body) } }).status, 401);
  assert.equal(harness.lines.filter(line => line.includes("failed signature verification")).length, 1, "the breadcrumb is once per registration");

  /* A `signature` header a sender wrote twice, in the comma-joined form Node hands a consumer for an ordinary repeated header rather than the array a test could
   * compose by hand. It reaches verification as the one string it arrived as, and the property that has to hold is that repeating a header never makes a code
   * valid over this body: the first carries no valid code at all, and the second appends a forgery after an authentic value, which is the pair the parse reads.
   */
  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from(body), headers: { signature: "t=1,v1=aa, t=2,v1=bb" } }).status, 401);
  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from(body),
    headers: { signature: sign("minted-secret", now(), body) + ", " + sign("the-wrong-secret", now(), body) } }).status, 401);

  /* Authentic, and fresh when it was signed - but the host's own clock moves past the window before it arrives, which is the age the check is about. Moving time
   * rather than backdating the header is what proves the judgment reads this clock at all.
   */
  const dated = sign("minted-secret", now(), body);

  harness.clock.advance(ACCESS_WEBHOOK_FRESHNESS_WINDOW_MS + 1000);

  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from(body), headers: { signature: dated } }).status, 401);

  // Authentic and fresh, but not JSON at all.
  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from("not json"),
    headers: { signature: sign("minted-secret", now(), "not json") } }).status, 401);

  const genuine = sign("minted-secret", now(), body);

  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from(body), headers: { signature: genuine } }).status, 200);
  assert.equal(harness.deliveries.length, 1, "an admitted delivery reaches the accessories");

  // The same delivery again inside the window is a replay, and the ledger refuses it.
  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from(body), headers: { signature: genuine } }).status, 401);
  assert.equal(harness.deliveries.length, 1);
});

test("a request the route does not claim is answered before the controller ever judges it", async (t) => {

  const harness = makeWebhookController();

  t.after(() => harness.shutdown.abort());

  await harness.run();

  const body = JSON.stringify({ data: { actor: null, device: null, location: { id: "door1", name: "Front Door" }, object: {} },
    event: ACCESS_WEBHOOK_EVENTS.doorUnlock, event_object_id: "unclaimed1" });
  const request = { body: Buffer.from(body), headers: { signature: sign("minted-secret", Math.floor(harness.clock.now() / 1000), body) } };

  /* Both answers are the listener's, and neither costs the controller a verdict: a path this controller never claimed is nobody's, and the route accepts POST
   * alone because that is how a delivery arrives. An authentic body is used for both, so what makes each one refuse is the addressing and not the payload.
   */
  assert.equal(harness.listener.deliver("/unifi-access/9.9.9.9", request).status, 404);
  assert.equal(harness.listener.deliver(WEBHOOK_PATH, request, "GET").status, 405);
  assert.equal(harness.deliveries.length, 0, "neither may reach the accessories");
});

test("an authentic delivery this plugin does not model is answered without being emitted", async (t) => {

  const harness = makeWebhookController();

  t.after(() => harness.shutdown.abort());

  await harness.run();

  const body = JSON.stringify({ event: "something.the.plugin.never.modeled", event_object_id: "other1" });

  /* The controller is told the delivery was taken, so it stops retrying something this plugin is simply not interested in - and nothing is emitted, because there
   * is nothing here that could read it.
   */
  assert.equal(harness.listener.deliver(WEBHOOK_PATH, { body: Buffer.from(body),
    headers: { signature: sign("minted-secret", Math.floor(harness.clock.now() / 1000), body) } }).status, 200);
  assert.equal(harness.deliveries.length, 0);
});

test("the publish chokepoint forwards the caller's own per-publish options to the client", async () => {

  const harness = makeController();
  const debugs: string[] = [];
  const mqtt = new TestMqttClient({ log: { debug: (message: string, ...parameters: unknown[]): void => void debugs.push(format(message, ...parameters)),
    error: (): void => undefined, info: (): void => undefined, warn: (): void => undefined } });

  // The client is injected as the double, cast at the injection site exactly as the double documents.
  harness.controller.mqtt = mqtt as unknown as MqttClient;

  harness.controller.mqttPublish("AABBCCDDEEFF/lock", "true");
  harness.controller.mqttPublish("AABBCCDDEEFF/lock", "false", { signal: AbortSignal.abort() });

  await settle(DISPATCH_SETTLE_TURNS);

  // A publish with no options lands; one carrying an already-aborted signal is refused on that signal, which proves the options reached the client.
  assert.deepEqual(mqtt.published, [{ payload: "true", topic: "AABBCCDDEEFF/lock" }]);
  assert.deepEqual(debugs, ["MQTT publish aborted: AABBCCDDEEFF/lock."]);
});
