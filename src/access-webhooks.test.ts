/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-webhooks.test.ts: Tests for the plugin's HTTP listener, its replay ledger, and its local address probe.
 *
 * Every listener arm drives a real server on an ephemeral port and speaks real HTTP to it. That is deliberate: what this module is for is the behavior of an
 * actual socket - a body arriving in pieces, a header sent twice, a connection that outlives its request, a port somebody else already holds - and none of that
 * is exercised by calling the handlers directly.
 */
import { AccessDeliveryLedger, AccessWebhookListener, localAddressFor } from "./access-webhooks.ts";
import { Agent, createServer, request as httpRequest } from "node:http";
import { ACCESS_WEBHOOK_BODY_LIMIT } from "./settings.ts";
import { Buffer } from "node:buffer";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSocket } from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";
import { isIP } from "node:net";
import test from "node:test";
import { verifyWebhookSignature } from "unifi-access";

// A listener under test, with the lines it emitted, a promise that settles once it has bound, and the abort that ends its lifetime.
interface ListenerHarness {

  bound: Promise<void>;
  lines: string[];
  listener: AccessWebhookListener;
  stop: () => void;
}

/* Stand up a listener over a capturing log. The port defaults to zero, which asks the operating system for an ephemeral one and keeps these arms from contending
 * with anything else on the machine.
 *
 * The lifetime ends with the test, registered here rather than at each call site: an arm that fails partway would otherwise leave a bound server behind and the
 * whole run would hang on it rather than reporting the failure and exiting.
 *
 * @param t       - The test this listener belongs to.
 * @param options - The port to bind and the retry interval, both defaulted for the arms that care about neither.
 */
function makeListener(t: TestContext, options: { port?: number; retryMs?: number } = {}): ListenerHarness {

  const lines: string[] = [];
  let announce: () => void = (): void => undefined;
  const bound = new Promise<void>((resolve) => { announce = resolve; });

  const log = {

    debug: (message: string): void => { lines.push("debug: " + message); },
    error: (message: string, ...parameters: unknown[]): void => { lines.push("error: " + message + " " + parameters.map(String).join(" ")); },
    info: (message: string, ...parameters: unknown[]): void => {

      lines.push("info: " + message + " " + parameters.map(String).join(" "));
      announce();
    },
    warn: (message: string): void => { lines.push("warn: " + message); }
  };

  const aborter = new AbortController();

  t.after(() => aborter.abort());

  return { bound, lines, listener: new AccessWebhookListener({ log, port: options.port ?? 0, retryMs: options.retryMs, signal: aborter.signal }),
    stop: (): void => aborter.abort() };
}

/* Wait for a condition to hold, polling on a short interval and giving up at the deadline so a broken arm fails rather than hangs.
 *
 * Written as a recursive attempt rather than a loop, which keeps the awaits out of iteration.
 *
 * @param condition - What we are waiting for.
 * @param timeoutMs - How long to wait before answering false.
 *
 * @returns Whether the condition held before the deadline.
 */
async function until(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {

  const deadline = Date.now() + timeoutMs;

  const attempt = async (): Promise<boolean> => {

    if(condition()) {

      return true;
    }

    if(Date.now() >= deadline) {

      return false;
    }

    await delay(10);

    return attempt();
  };

  return attempt();
}

// One HTTP request against a listener under test, answered with its status and body.
async function post(options: { agent?: Agent; body?: Buffer | string; headers?: Record<string, string | string[]>; method?: string; path: string;
  port: number; }): Promise<{ body: string; status: number }> {

  return new Promise((resolve, reject) => {

    const request = httpRequest({ agent: options.agent, headers: options.headers, host: "127.0.0.1", method: options.method ?? "POST", path: options.path,
      port: options.port }, (response) => {

      const chunks: Buffer[] = [];

      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), status: response.statusCode ?? 0 }));
    });

    request.on("error", reject);
    request.end(options.body);
  });
}

// Hold an ephemeral port so a listener asked for it finds it taken, and hand back the port and the way to let it go.
async function blockPort(): Promise<{ port: number; release: () => Promise<void> }> {

  const blocker = createServer();

  await new Promise<void>((resolve) => void blocker.listen(0, resolve));

  const address = blocker.address();

  return { port: ((address === null) || (typeof address === "string")) ? 0 : address.port,
    release: async (): Promise<void> => new Promise<void>((resolve) => void blocker.close(() => resolve())) };
}

// Whether a port can be bound, retried briefly so a socket still unwinding is waited out rather than read as a held port.
async function bindable(port: number, timeoutMs = 2000): Promise<boolean> {

  const attempt = async (): Promise<boolean> => new Promise<boolean>((resolve) => {

    const probe = createServer();

    probe.once("error", () => resolve(false));
    probe.listen(port, () => void probe.close(() => resolve(true)));
  });

  const deadline = Date.now() + timeoutMs;

  const retry = async (): Promise<boolean> => {

    if(await attempt()) {

      return true;
    }

    if(Date.now() >= deadline) {

      return false;
    }

    await delay(10);

    return retry();
  };

  return retry();
}

// The local address this machine's routing table would send toward a host, computed inline so an arm can compare the module's answer against an independent one.
async function probeRoute(host: string): Promise<string | null> {

  const socket = createSocket("udp4");

  try {

    return await new Promise<string | null>((resolve) => {

      socket.on("error", () => resolve(null));
      socket.connect(443, host, () => resolve(socket.address().address));
    });
  } finally {

    try {

      socket.close();
    } catch {

      // A socket that never opened has nothing to close, and nothing here can act on that either way.
    }
  }
}

// Sign a body exactly as the controller does: a unix timestamp and a message authentication code over that timestamp, a literal separator, and the body itself.
function sign(secret: string, timestamp: string, body: string): string {

  return "t=" + timestamp + ",v1=" + createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex");
}

test("the listener answers each kind of request with the status that describes it", async (t) => {

  const harness = makeListener(t);

  await harness.bound;

  const port = harness.listener.boundPort;

  assert.ok(port > 0, "an ephemeral port must resolve to a real one");

  const accepted = harness.listener.route("/accept", () => true);
  const refused = harness.listener.route("/refuse", () => false);
  const faulty = harness.listener.route("/fault", () => { throw new Error("handler fell over"); });

  // Deliveries are posted, and anything else is answered without a body ever being read.
  assert.equal((await post({ method: "GET", path: "/accept", port })).status, 405);

  // A path nothing routed is nobody's delivery.
  assert.equal((await post({ body: "{}", path: "/nothing", port })).status, 404);

  // The route's verdict is the answer: taken, or refused as unauthentic.
  assert.equal((await post({ body: "{}", path: "/accept", port })).status, 200);
  assert.equal((await post({ body: "{}", path: "/refuse", port })).status, 401);

  /* A fault inside a route is reported as a failure here rather than as a refusal, because those mean different things to whatever is retrying on the other end.
   * The fault is logged once, with the throw's own message.
   */
  assert.equal((await post({ body: "{}", path: "/fault", port })).status, 500);
  assert.ok(harness.lines.some(line => line.includes("A webhook delivery handler failed") && line.includes("handler fell over")), "the fault must be reported once");

  for(const handle of [ accepted, refused, faulty ]) {

    handle[Symbol.dispose]();
  }

  // A disposed route is gone, so the path it held answers as unrouted again.
  assert.equal((await post({ body: "{}", path: "/accept", port })).status, 404);
});

test("a body past the limit is refused and never reaches the route", async (t) => {

  const harness = makeListener(t);

  await harness.bound;

  let reached = 0;

  const handle = harness.listener.route("/big", () => {

    reached++;

    return true;
  });

  const oversized = Buffer.alloc(ACCESS_WEBHOOK_BODY_LIMIT + 4096, 0x61);
  const outcome = await post({ body: oversized, path: "/big", port: harness.listener.boundPort }).then(answer => answer.status).catch(() => "reset");

  assert.equal(reached, 0, "a body past the limit must never reach a route");

  /* The server answers and drops the socket the moment the limit is crossed. Whether the client reads that answer before the reset reaches it is the network's
   * business, so both outcomes are accepted - the assertion that matters is the one above, that nothing was handed an unusable body.
   */
  assert.ok((outcome === "reset") || (outcome === 413), "an oversized body is refused rather than accepted");

  handle[Symbol.dispose]();
});

test("the body reaches a route exactly as it arrived, so a signature over the raw bytes verifies", async (t) => {

  const harness = makeListener(t);

  await harness.bound;

  const secret = "a-controller-minted-secret";
  const port = harness.listener.boundPort;
  const handle = harness.listener.route("/verify",
    (delivery) => verifyWebhookSignature({ body: delivery.body, header: delivery.signature ?? "", secret }) !== null);

  // Irregular whitespace and key order - exactly what a parse and re-encode would tidy away, and exactly what the signature covers.
  const raw = "{\n  \"event\":\"access.door.unlock\",   \"data\":{ \"z\":1, \"a\":2 }\n}";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const header = sign(secret, timestamp, raw);

  assert.equal((await post({ body: raw, headers: { Signature: header }, path: "/verify", port })).status, 200, "a body handed through verbatim verifies");

  /* The same JSON re-serialized, under the signature over the original. This is the body a listener that parsed and re-encoded would hand on, and it must not
   * verify - which is what makes this arm fail such a listener rather than quietly accepting it.
   */
  assert.equal((await post({ body: JSON.stringify(JSON.parse(raw)), headers: { Signature: header }, path: "/verify", port })).status, 401);

  handle[Symbol.dispose]();
});

test("a header the route cannot use reaches it as nothing, and a repeated one smuggles no signature past the check", async (t) => {

  const harness = makeListener(t);

  await harness.bound;

  const seen: (string | undefined)[] = [];
  const secret = "a-controller-minted-secret";
  const port = harness.listener.boundPort;

  const handle = harness.listener.route("/header", (delivery) => {

    seen.push(delivery.signature);

    return verifyWebhookSignature({ body: delivery.body, header: delivery.signature ?? "", secret }) !== null;
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const genuine = sign(secret, timestamp, "{}");

  // No header at all reaches the route as nothing, and the route refuses it.
  assert.equal((await post({ body: "{}", path: "/header", port })).status, 401);

  /* A header sent twice. Node joins repeats of an ordinary header into one comma-separated value rather than handing over an array, so what reaches the route is a
   * single mangled string carrying no code valid over this body - which is the property that matters, since repeating a header must never make an invalid
   * signature valid. The route's parameter still admits the array Node reserves for its own few special headers, and refuses that too.
   */
  assert.equal((await post({ body: "{}", headers: { Signature: [ "t=1,v1=aa", "t=2,v1=bb" ] }, path: "/header", port })).status, 401);

  // The well-formed single header verifies, so the refusals above are about the header rather than about a route that accepts nothing at all.
  assert.equal((await post({ body: "{}", headers: { Signature: genuine }, path: "/header", port })).status, 200);

  assert.equal(seen[0], undefined, "an absent header must reach the route as nothing at all");
  assert.ok(seen[1]?.includes("t=1,v1=aa") && seen[1].includes("t=2,v1=bb"), "a repeated header arrives joined into one value rather than as an array");
  assert.equal(seen[2], genuine);

  handle[Symbol.dispose]();
});

test("a pooled keep-alive connection does not hold the port past the lifetime", async (t) => {

  const harness = makeListener(t);

  await harness.bound;

  const port = harness.listener.boundPort;
  const handle = harness.listener.route("/keepalive", () => true);
  const agent = new Agent({ keepAlive: true });

  assert.equal((await post({ agent, body: "{}", path: "/keepalive", port })).status, 200);

  /* The socket is still open and pooled at this point, which is exactly what would keep a server from finishing its close. Dropping the connections explicitly is
   * what makes the port free again immediately rather than whenever the peer happens to let go.
   */
  harness.stop();

  assert.ok(await bindable(port), "the port must be free once the lifetime ends, which it is not if a pooled connection held the server open");

  handle[Symbol.dispose]();
  agent.destroy();
});

test("a route is refused on a path already taken, and the refusal says so", async (t) => {

  const harness = makeListener(t);

  await harness.bound;

  const handle = harness.listener.route("/taken", () => true);

  // Two controllers configured with one address would collide here. The message is the catcher's mechanism, so it names which condition refused.
  assert.throws(() => harness.listener.route("/taken", () => true), (error: unknown) => (error instanceof TypeError) && error.message.includes("already routed"));

  handle[Symbol.dispose]();

  // Once the path is released it can be routed again, so the refusal is about the collision rather than about the path itself.
  harness.listener.route("/taken", () => true)[Symbol.dispose]();
});

test("a listener whose lifetime has ended is closed and accepts no further routes", async (t) => {

  const harness = makeListener(t);

  await harness.bound;

  harness.stop();

  assert.equal(harness.listener.closed, true);

  /* A closed listener accepts nothing further, and its refusal names which condition refused rather than leaving a catcher to tell two failure shapes apart. This
   * is the state a controller configuring itself against a listener that has already gone away meets.
   */
  assert.throws(() => harness.listener.route("/anything", () => true), (error: unknown) => (error instanceof TypeError) && error.message.includes("closed"));
});

test("a fatal server error closes the listener and reports itself", async (t) => {

  /* Binding a privileged port is refused for an ordinary user on many platforms, and that refusal is a real server error rather than a port conflict, so it takes
   * the fatal arm rather than the retry arm. Some platforms let an ordinary user bind one, and there the listener simply comes up and this arm has nothing to
   * observe, so it skips with its reason recorded rather than asserting something untrue.
   */
  const harness = makeListener(t, { port: 1 });

  assert.ok(await until(() => harness.listener.closed || (harness.listener.boundPort !== 0)), "the listener must settle one way or the other");

  if(harness.listener.boundPort !== 0) {

    t.skip("this platform lets an ordinary user bind a privileged port, so the refusal this arm needs does not happen here");

    return;
  }

  assert.equal(harness.listener.closed, true);
  assert.ok(harness.lines.some(line => line.startsWith("error: The Access webhook listener encountered an error")), "the fault must be reported");
  assert.throws(() => harness.listener.route("/anything", () => true), (error: unknown) => (error instanceof TypeError) && error.message.includes("closed"));
});

test("a port already in use is never bound once the lifetime has ended", async (t) => {

  const blocker = await blockPort();
  const harness = makeListener(t, { port: blocker.port, retryMs: 10 });

  assert.ok(await until(() => harness.lines.some(line => line.includes("in use"))), "the conflict must be reported");

  // The lifetime ends before the retry could fire, which cancels it. A retry that re-listened regardless would take the port the moment it frees.
  harness.stop();

  await blocker.release();
  await delay(100);

  assert.equal(harness.listener.boundPort, 0, "a listener whose lifetime ended must never bind, however free the port becomes");
});

test("a port that frees up is bound on the retry", async (t) => {

  const blocker = await blockPort();
  const harness = makeListener(t, { port: blocker.port, retryMs: 10 });

  assert.ok(await until(() => harness.lines.some(line => line.includes("in use"))), "the conflict must be reported");

  await blocker.release();

  assert.ok(await until(() => harness.listener.boundPort === blocker.port), "the retry must bind the port once it frees");
});

test("a port held through several intervals is waited out rather than given up on", async (t) => {

  const blocker = await blockPort();
  const harness = makeListener(t, { port: blocker.port, retryMs: 10 });

  /* The error handler stands for the life of the server, so every failed attempt reports and arms the next. A listener that armed one retry and then gave up
   * would report the conflict once and never come up at all.
   */
  assert.ok(await until(() => harness.lines.filter(line => line.includes("in use")).length >= 3), "each occurrence must report and arm another attempt");

  await blocker.release();

  assert.ok(await until(() => harness.listener.boundPort === blocker.port), "the listener must still come up after several conflicts");
});

test("the delivery ledger admits an identifier once inside its window and forgets it after", () => {

  const ledger = new AccessDeliveryLedger({ windowMs: 1000 });

  assert.equal(ledger.admit({ id: "one", nowMs: 10000 }), true);
  assert.equal(ledger.admit({ id: "one", nowMs: 10500 }), false, "a repeat inside the window is a replay");

  // Past the window the identifier is forgotten, because a delivery that old is refused before this ledger is consulted at all.
  assert.equal(ledger.admit({ id: "one", nowMs: 11001 }), true);

  // Pruning is what bounds the ledger, and a later re-admission of a pruned identifier is what shows it happened rather than the map simply growing.
  assert.equal(ledger.admit({ id: "two", nowMs: 11001 }), true);
  assert.equal(ledger.admit({ id: "two", nowMs: 12002 }), true, "an entry past the horizon is pruned rather than accumulated");

  assert.equal(ledger.admit({ id: "three", nowMs: 12002 }), true);
  ledger.clear();
  assert.equal(ledger.admit({ id: "three", nowMs: 12002 }), true, "a cleared ledger remembers nothing");
});

test("localAddressFor answers an address literal rather than the name it was asked about", async () => {

  // A stub that handed the input back would pass a weaker assertion than this one: the answer has to be an address, and it has to be the loopback one.
  const named = await localAddressFor("localhost");

  assert.ok(isIP(named) !== 0, "the answer must be an address literal");
  assert.ok(named.startsWith("127.") || (named === "::1"), "a loopback peer is reached over loopback");

  assert.equal(await localAddressFor("127.0.0.1"), "127.0.0.1");
});

test("localAddressFor reads the operating system's own routing rather than assuming loopback", async (t) => {

  /* The documentation range. Nothing is sent to it and nothing needs to answer, but the kernel still picks the interface it would leave from, and an inline probe
   * computes that same answer independently - so this arm fails a stub that hardcodes a loopback address.
   *
   * A machine with no route toward it fails both sides identically, which would prove nothing, so that case skips with its reason recorded.
   */
  const expected = await probeRoute("192.0.2.1");

  if(expected === null) {

    t.skip("this machine has no route toward the documentation range, so both sides of the comparison would fail identically");

    return;
  }

  assert.equal(await localAddressFor("192.0.2.1"), expected);
});
