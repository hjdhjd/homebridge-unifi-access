/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * removal.test.ts: Behavior tests over the real RemovalStabilityGate.
 *
 * The gate owns the plugin's one destructive decision - whether a removal is allowed at all, and when the removal it permits actually runs. This suite constructs it
 * directly against recording stubs, so what is exercised is the class itself rather than any controller wired to it: the stability arithmetic at its boundaries, the
 * first-stabilization latch that tells an initial startup entry from a later recovery, the one-shot sweep, the first-deadline-wins delay, the fire-time re-check, the
 * cancellation paths, the delay's line, and the lifetime signal.
 *
 * Timing is the subject here, so every arm builds its gate on its own test clock and drives time by advancing it: every timer the gate arms goes through that clock,
 * and every instant it reads comes from it. Each arm builds its own gate, because the first-stabilization latch is a one-way fact about the object's life that a
 * shared instance would carry from one arm into the next.
 *
 * The pure arithmetic these decisions rest on (computeStableSince, isStabilityWindowElapsed) is asserted as arithmetic in policy.test.ts, and this suite asserts the
 * stateful class those functions serve and does not restate them. What runSweep does in production, the controller's own sweep, is the controller suite's to walk: the
 * recorder here proves only that the gate calls it, and at which instants.
 */
import { ACCESS_REMOVAL_STABILITY_WINDOW } from "../settings.ts";
import type { AccessAccessory } from "../types.ts";
import { RemovalStabilityGate } from "./removal.ts";
import { TestClock } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { format } from "node:util";
import { makeTestAccessory } from "../testing.helpers.ts";
import test from "node:test";

// Everything the gate's actions and log wrote, plus the delay the supplier answers with. A plain mutable record rather than closures with accessors: an arm reads
// recorder.sweeps or moves recorder.grace directly, which is what the gate's own suppliers and actions see on their next call.
interface GateRecorder {

  grace: number;
  logLines: string[];
  removals: AccessAccessory[];
  sweeps: number;
}

// Build a gate against recording stubs and its own test clock, with a victim accessory to schedule and a good-state push bound to that gate. The accessory is a harness
// accessory presented through the harness's own boundary cast, so this suite invents no accessory shape of its own and what the gate's API receives is the same object
// every other suite hands it.
function buildGate(options: { graceSeconds?: number } = {}): { accessory: ReturnType<typeof makeTestAccessory>; clock: TestClock; controller: AbortController;
  gate: RemovalStabilityGate; pushGood: (uptimeMs: number) => void; recorder: GateRecorder; } {

  const clock = new TestClock();
  const controller = new AbortController();
  const recorder: GateRecorder = { grace: options.graceSeconds ?? 60, logLines: [], removals: [], sweeps: 0 };
  const sink = (message: string, ...parameters: unknown[]): void => {

    recorder.logLines.push(format(message, ...parameters));
  };

  const gate = new RemovalStabilityGate({

    actions: {

      removeDevice: (accessory: AccessAccessory): void => { recorder.removals.push(accessory); },
      runSweep: (): void => { recorder.sweeps++; }
    },
    clock,
    graceSeconds: (): number => recorder.grace,
    log: { debug: sink, error: sink, info: sink, warn: sink },
    signal: controller.signal
  });

  // Push a good-state fact carrying the given uptime, in the seconds a controller's document reports it in. A full-window uptime is the trusted long-up posture the
  // plugin extends to a controller that has been up longer than the settling window; a shallower one leaves the remainder of the window to run.
  const pushGood = (uptimeMs: number): void => gate.refresh({ good: true, uptimeSeconds: uptimeMs / 1000 });

  return { accessory: makeTestAccessory("Victim", "74ACB9000201"), clock, controller, gate, pushGood, recorder };
}

// The delay lines the gate emitted, which are the only lines it writes unless a fire faults.
function delayingLines(recorder: GateRecorder): string[] {

  return recorder.logLines.filter((line) => line.includes("Delaying device removal"));
}

test("a partial uptime is trusted only as far as it goes - stability arrives when the remainder of the window elapses", (t) => {

  const { clock, controller, gate, pushGood } = buildGate();

  // The abort drains every timer the gate armed on its test clock, so nothing this arm armed outlives it.
  t.after(() => controller.abort());

  // A controller up for a third of the window: the entry is backdated by exactly that, so two thirds of the window remain.
  pushGood(200000);

  assert.equal(gate.removalStable, false, "a controller up for less than the window is not yet trusted");

  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW - 200000 - 1);

  assert.equal(gate.removalStable, false, "one millisecond short of the window, removal is still barred");

  clock.advance(1);

  assert.equal(gate.removalStable, true, "the window elapsed, so removal is allowed");
});

// A document reports its uptime in seconds where the gate counts in milliseconds, so a push taking the number as milliseconds would leave nearly the whole window to run.
test("an uptime pushed in seconds counts as that many seconds, to the exact millisecond the window ends", (t) => {

  const { clock, controller, gate } = buildGate();

  t.after(() => controller.abort());

  gate.refresh({ good: true, uptimeSeconds: 120 });

  assert.equal(clock.nextDeadline, 480000, "two minutes up leaves eight minutes of the window");

  clock.advance(479999);

  assert.equal(gate.removalStable, false, "one millisecond short of it, removal is still barred");

  clock.advance(1);

  assert.equal(gate.removalStable, true, "and at it, removal is allowed");
});

// A client that read no controller document, a token alone, reports no uptime at all, so its first period has nothing to backdate from.
test("a null uptime serves a full window", (t) => {

  const { clock, controller, gate } = buildGate();

  t.after(() => controller.abort());

  gate.refresh({ good: true, uptimeSeconds: null });

  assert.equal(clock.nextDeadline, ACCESS_REMOVAL_STABILITY_WINDOW, "the sweep waits out the whole window");

  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW - 1);

  assert.equal(gate.removalStable, false, "one millisecond short of it, removal is still barred");

  clock.advance(1);

  assert.equal(gate.removalStable, true, "and at it, removal is allowed");
});

test("recovery counts from now: after the first stabilization the uptime backdate stands down", (t) => {

  const { clock, controller, gate, pushGood } = buildGate();

  t.after(() => controller.abort());

  // A genuine first stabilization, which is what sets the latch. Without this opening the destabilize below would be a no-op against a null clock and the
  // "restabilize" would take the first-ever branch, so the backdate would be honored and the arm would prove nothing.
  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.equal(gate.removalStable, true, "a long-up controller is trusted on the first entry");

  gate.refresh({ good: false });

  assert.equal(gate.removalStable, false, "leaving good state bars removal at once");

  // The recovery, carrying the same fully-backdated uptime the first entry did. It is deliberately ignored: a disruption we observed resets our trust regardless of
  // how long the controller process has been up.
  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.equal(gate.removalStable, false, "the recovery counts from now, so the backdate buys nothing");

  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW - 1);

  assert.equal(gate.removalStable, false, "one millisecond short of a full fresh window, removal is still barred");

  clock.advance(1);

  assert.equal(gate.removalStable, true, "a full fresh window after the recovery, removal is allowed again");
});

test("a long-up entry arms the sweep at no delay, fires it exactly once, and an agreeing second push arms nothing", (t) => {

  const { clock, controller, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.equal(recorder.sweeps, 0, "the sweep is armed rather than run inline");

  clock.advance(0);

  assert.equal(recorder.sweeps, 1, "the zero-delay sweep ran on the clock's next advance");

  // A push that agrees with the state the gate is already in is a no-op, so the root can push on every fact change without ceremony.
  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.equal(recorder.sweeps, 1, "an agreeing second good push neither re-armed nor re-ran the sweep");
});

test("a partial-uptime entry defers the sweep to the exact instant the window elapses", (t) => {

  const { clock, controller, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  pushGood(200000);
  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW - 200000 - 1);

  assert.equal(recorder.sweeps, 0, "the sweep does not run before the window is complete");

  clock.advance(1);

  assert.equal(recorder.sweeps, 1, "the sweep ran as the window completed");
});

// A real timer can come due a millisecond before the wall clock reads its deadline, which this test clock never does on its own, so the row holds its reads one
// millisecond short. The sweep never re-arms, so a controller read as unstable at its fire would hold every departure until the next good period.
test("a sweep whose timer fires a millisecond before the clock reads the window's end finds the controller stable", (t) => {

  const { clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  pushGood(200000);

  const read = clock.now.bind(clock);

  clock.now = (): number => read() - 1;
  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW - 200000);

  assert.equal(recorder.sweeps, 1, "the sweep's timer fired");
  assert.equal(gate.removalStable, true, "and the window it waited out reads as complete");
});

test("a pending delay is dropped by the disruption, and the accessory can be scheduled afresh once stability returns", (t) => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);

  // Retire the sweep first, so the drain assertion below watches the delay alone. The two can coexist briefly - a backdated entry leaves the zero-delay sweep
  // registered but unfired while a delay is already schedulable - and spending the sweep here is what keeps this arm's observable single.
  clock.advance(0);

  assert.equal(recorder.sweeps, 1, "the sweep is spent");

  gate.schedule({ accessory: accessory, stillGone: () => true });
  gate.refresh({ good: false });
  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.deepEqual(recorder.removals, [], "the disruption dropped the pending delay before it could fire");
  assert.equal(recorder.sweeps, 1, "and no sweep ran either");

  // The staleness re-check that a partial clear cannot survive: a registry entry left behind for this accessory would silently dedup the fresh schedule away, so
  // the fresh delay firing is what proves the drain reached the keyed timer rather than only the sweep.
  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => true });
  clock.advance(60000);

  assert.deepEqual(recorder.removals, [accessory], "the same accessory scheduled afresh armed and fired");
});

// The row above reads what a removal did. This one reads the timeline, because a timer left armed for its fire to refuse still ends in no removal, and only the drain is
// what the reset promises.
test("a reset leaves nothing armed: the pending removal is off the timeline at once", (t) => {

  const { accessory, clock, controller, gate, pushGood } = buildGate();

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  clock.advance(0);
  gate.schedule({ accessory: accessory, stillGone: () => true });

  assert.equal(clock.nextDeadline, 60000, "the delay stands on the timeline");

  gate.refresh({ good: false });

  assert.equal(clock.nextDeadline, null, "the reset cancels the removal rather than leaving its fire to refuse it");
});

// With its timer left standing, a fire reading the live state alone would find the device still gone and remove it through the disruption. Neither half reddens this row
// alone: the fire's stability term refuses a timer the reset left, and the reset's drain takes a timer the fire would not refuse, so the pair is what it asserts.
test("a removal armed before a disruption never fires through it", (t) => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  clock.advance(0);
  gate.schedule({ accessory: accessory, stillGone: () => true });
  gate.refresh({ good: false });
  clock.advance(60000);

  assert.deepEqual(recorder.removals, [], "the disruption ended the removal, whichever half caught it");
});

test("a sweep still pending when the disruption arrives never runs", (t) => {

  const { clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  // A partial uptime leaves the sweep pending at the remaining window, which is the state a disruption has to reach into.
  pushGood(200000);
  gate.refresh({ good: false });
  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.equal(recorder.sweeps, 0, "the pending sweep was drained by the disruption");
});

test("first deadline wins: a re-schedule inside the delay keeps the original deadline and removes exactly once", (t) => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => true });
  gate.schedule({ accessory: accessory, stillGone: () => true });

  // The dedup is silent, so the single delay line is what marks the second call as a no-op: a device that keeps re-yielding while it stays gone must not have its delay
  // restarted on every yield.
  assert.equal(delayingLines(recorder).length, 1, "the redundant schedule said nothing of its own");

  clock.advance(60000);

  assert.equal(recorder.removals.length, 1, "the accessory was removed exactly once");
});

test("with the delay disabled the removal is immediate, and nothing is left armed behind it", (t) => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate({ graceSeconds: 0 });

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => true });

  assert.equal(recorder.removals.length, 1, "the removal ran synchronously inside the schedule call");
  assert.deepEqual(delayingLines(recorder), [], "no delay is stated when none is taken");

  // The no-timer-armed negative, proven behaviorally: a timer armed alongside the immediate removal would fire a second one here.
  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.equal(recorder.removals.length, 1, "no armed timer followed the immediate removal");
});

test("the fire re-reads live state: a device that returned during its delay is not removed", (t) => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  let gone = true;

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => gone });

  // The device comes back inside its delay, which is the whole point of having one.
  gone = false;

  clock.advance(60000);

  // The stability half of the fire-time conjunction has no row of its own, and that is deliberate: reaching the fire with a dropped clock would require a drain that
  // failed to pair with the clock drop, and leaving good state performs both as a single act, so that term is defense in depth rather than a reachable branch.
  assert.deepEqual(recorder.removals, [], "the returned device was not removed");
});

test("cancelFor drops a pending removal, and cancelling an accessory that holds none is silent", (t) => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => true });
  gate.cancelFor(accessory.UUID);

  assert.doesNotThrow(() => gate.cancelFor("never-scheduled"), "cancelling an accessory with no pending removal does nothing");

  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.deepEqual(recorder.removals, [], "the cancelled delay never fired");
});

test("an unstable controller schedules nothing at all - no timer, no removal, and no line", (t) => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  // Never stabilized: the gate is in the state a plugin start against an unreachable controller leaves it in.
  gate.schedule({ accessory: accessory, stillGone: () => true });

  assert.deepEqual(recorder.logLines, [], "the stability gate returns ahead of any logging, so a suppressed schedule is entirely silent");

  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.deepEqual(recorder.removals, [], "nothing was armed while the controller was untrusted");

  // The same call once the controller has settled is the positive control: it arms, states its delay, and fires.
  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => true });
  clock.advance(60000);

  assert.equal(recorder.removals.length, 1, "the identical call landed once the controller was trusted");
});

test("the delay line carries the resolved interval, and the fire itself says nothing", (t) => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => true });

  assert.deepEqual(recorder.logLines, ["Victim: Delaying device removal for at least 60 seconds."], "the delay line carries the resolved interval");

  clock.advance(60000);

  assert.equal(recorder.logLines.length, 1, "the fire itself says nothing");
});

test("a one-second delay is stated in the singular", (t) => {

  const { accessory, controller, gate, pushGood, recorder } = buildGate({ graceSeconds: 1 });

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => true });

  assert.deepEqual(delayingLines(recorder), ["Victim: Delaying device removal for at least 1 second."], "a single-second delay reads as one second, not one seconds");
});

// The fire runs from a timer the registry fires with no catch around it, so a throw it let go would leave the advance here as it would leave the timer for Homebridge's
// process handler. The re-check and the removal share the catch, and the re-check is the one a stub can fault without standing a controller up.
test("a fire's fault is said once on the gate's log, naming the accessory, and goes no further", (t) => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate();

  t.after(() => controller.abort());

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => {

    throw new Error("the record cannot be read");
  } });

  assert.doesNotThrow(() => clock.advance(60000), "the fault stops at the fire's own catch");
  assert.deepEqual(recorder.logLines.slice(1), ["Unable to remove Victim from HomeKit: the record cannot be read."], "and is said once, naming the accessory");
});

test("teardown drains a pending delay and a pending sweep, and a schedule after teardown arms nothing", () => {

  const { accessory, clock, controller, gate, pushGood, recorder } = buildGate();

  pushGood(ACCESS_REMOVAL_STABILITY_WINDOW);
  gate.schedule({ accessory: accessory, stillGone: () => true });

  controller.abort();

  assert.equal(clock.nextDeadline, null, "teardown left nothing on the timeline");

  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.deepEqual(recorder.removals, [], "teardown drained the pending delay");
  assert.equal(recorder.sweeps, 0, "and the sweep still due beside it");

  // A post-teardown schedule still passes the stability gate and still states its delay - the clock is untouched by an abort - so what is asserted is the absence of the
  // removal: the registry is retired, so no timer arms and nothing can fire later.
  gate.schedule({ accessory: accessory, stillGone: () => true });
  clock.advance(ACCESS_REMOVAL_STABILITY_WINDOW);

  assert.deepEqual(recorder.removals, [], "a schedule against a torn-down gate can never produce a removal");
});
