/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * removal.ts: The controller's removal-stability decision, as a companion the controller pushes facts into.
 *
 * Removing an accessory is the plugin's one destructive act, so it is gated on the controller having been continuously good for a settling window. This module owns
 * that whole decision - the good-state clock, the window, the delayed-removal timers, and the single chokepoint every controller-state-driven removal routes through.
 * The design follows these principles:
 *
 *   1. Facts in, actions out. The gate holds no controller reference and reads no controller state. The root recomputes the good-state conjunction and PUSHES the
 *      result through `refresh`; every act that touches the accessory graph is reached through the narrow {@link RemovalGateActions} surface handed at construction.
 *      That is what keeps the gate a decision rather than a second place removal happens.
 *
 *   2. Mechanism vs policy separation. The arithmetic is pure and lives in policy.ts (`computeStableSince`, `isStabilityWindowElapsed`); the timer mechanism is
 *      homebridge-plugin-utils' `TimerRegistry`, bound to the controller's lifetime signal. What is left here is the policy: when the clock starts, when it drops, and
 *      what a removal request is allowed to do.
 *
 *   3. One drain, one rule. Leaving good-state means "all bets are off, no destructive action": the clock drops and every pending timer cancels together, as the
 *      single act {@link RemovalStabilityGate.reset} performs. Because the sweep one-shot and the per-accessory delays live in one registry, that rule cannot be
 *      half-applied.
 *
 * The gate is constructed once per controller and never rebuilt, because its first-stabilization latch is a fact about this process's whole life rather than about
 * the current connection.
 */
import { ACCESS_DEVICE_REMOVAL_DELAY_MESSAGE, ACCESS_REMOVAL_STABILITY_WINDOW } from "../settings.ts";
import type { Clock, HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { TimerRegistry, formatErrorMessage } from "homebridge-plugin-utils";
import { computeStableSince, isStabilityWindowElapsed } from "../policy.ts";
import type { AccessAccessory } from "../types.ts";

/**
 * The controller fact the root pushes into the gate. The uptime exists ONLY on the good arm: the controller's document is readable only once the client exists, and the
 * good arm's own truth guarantees that it does. A push assembled during the pre-connect window therefore cannot carry an uptime by construction rather than by caller
 * discipline.
 */
export type RemovalStabilityFacts = { good: false } | { good: true; uptimeSeconds: Nullable<number> };

/**
 * The acts the gate's decisions run, handed in at construction. Each touches the accessory graph, which is the root's territory, so the gate reaches them only through
 * this surface and never holds the controller itself.
 */
export interface RemovalGateActions {

  // Remove an accessory from HomeKit, the one act a removal decision runs.
  removeDevice: (accessory: AccessAccessory) => void;

  // Re-assess the full device inventory. Run once per good-state period, when the stability window first elapses.
  runSweep: () => void;
}

/**
 * A removal request. `stillGone` is re-evaluated against live controller state when the delay fires.
 */
export interface RemovalScheduleOptions {

  accessory: AccessAccessory;
  stillGone: () => boolean;
}

/**
 * Construction options for {@link RemovalStabilityGate}.
 */
export interface RemovalStabilityGateOptions {

  actions: RemovalGateActions;
  // The time source the gate reads each good-state instant from and arms its sweep and its delayed removals on.
  clock: Clock;
  // The user's configured removal delay, in seconds, resolved per request rather than captured, so a live configuration change governs the next removal.
  graceSeconds: () => number;
  log: HomebridgePluginLogging;
  // The controller's lifetime signal. The gate's timers bind to it, so teardown drains whatever is armed and a registration after it is inert.
  signal: AbortSignal;
}

/**
 * The removal-stability decision for one controller: whether destructive removal is currently allowed, and the delayed scheduling of the removals it permits.
 */
export class RemovalStabilityGate {

  readonly #actions: RemovalGateActions;

  readonly #clock: Clock;

  readonly #graceSeconds: () => number;

  // True once the controller has reached good-state at least once, which tells the initial startup entry (uptime-backdated) apart from a later recovery (counted from
  // now). It pairs with the clock below under one rule the shape cannot state on its own: the latch flips true only in the same act that stamps the clock, and only
  // the clock is ever cleared. The latch is therefore a one-way fact about this process's life, while the clock tracks the current good-state period.
  #hasStabilizedOnce = false;

  readonly #log: HomebridgePluginLogging;

  // The instant the controller entered its current continuous good state, or null when it is not good. Backdated by the controller's uptime at the first good-state
  // entry so a long-up controller is trusted immediately.
  #stableSince: Nullable<number> = null;

  // Every timer the gate owns: the one-shot stability sweep as an anonymous entry, and each pending delayed removal keyed by accessory UUID. One registry is what lets
  // the leaving-good-state rule cancel all of them as a single act.
  readonly #timers: TimerRegistry;

  public constructor(options: RemovalStabilityGateOptions) {

    this.#actions = options.actions;
    this.#clock = options.clock;
    this.#graceSeconds = options.graceSeconds;
    this.#log = options.log;
    this.#timers = new TimerRegistry({ clock: options.clock, signal: options.signal });
  }

  /**
   * Cancel a single pending delayed removal by accessory UUID, for a returning orphan or an accessory on its way out. Silently does nothing when the accessory holds no
   * pending removal.
   *
   * @param uuid - The accessory UUID whose pending removal to cancel.
   */
  public cancelFor(uuid: string): void {

    this.#timers.clear(uuid);
  }

  /**
   * Drive the good-state clock from a pushed controller fact. Entering good-state stamps the clock and arms the one-shot sweep; leaving it drops the clock and every
   * pending removal. A push that agrees with the current state is a no-op, so the root can push on every fact change without ceremony.
   *
   * @param facts - See {@link RemovalStabilityFacts}.
   */
  public refresh(facts: RemovalStabilityFacts): void {

    if(facts.good && (this.#stableSince === null)) {

      // One instant serves the stamp, the uptime backdate, and the delay arithmetic below, so they all describe the same moment rather than drifting across separate
      // reads that could straddle a millisecond boundary and disagree.
      const nowMs = this.#clock.now();

      // A null uptime is a client that read no controller document, a token alone, so its first period starts at this instant and serves a full window.
      this.#stableSince = computeStableSince({ hasStabilizedBefore: this.#hasStabilizedOnce, nowMs, uptimeMs: (facts.uptimeSeconds ?? 0) * 1000,
        windowMs: ACCESS_REMOVAL_STABILITY_WINDOW });
      this.#hasStabilizedOnce = true;

      // What REMAINS of the window from the stamped instant, which is zero for a controller already up longer than the window.
      const delay = Math.max(0, (this.#stableSince + ACCESS_REMOVAL_STABILITY_WINDOW) - nowMs);

      /* Arm the one-shot sweep. It needs no key: this branch is the only place it arms and it requires a null clock, which the same branch immediately falsifies, so a
       * second arming cannot happen while one is pending; and the full drain is the only thing that cancels it. The keyed namespace is therefore nothing but accessory
       * UUIDs, with no reserved-key convention to reason about.
       *
       * At startup a zero delay runs the sweep in a later macrotask, after the controller's initial device population - a benign double reconcile, since reconciling
       * is repeatable and the orphan pass reads live membership claims beside the configured set, so it cannot evict an accessory membership accounts for but has not
       * yet adopted, whatever the ordering.
       *
       * A timer can come due a millisecond before the clock reads its deadline, and the sweep reads the gate at its own fire and never re-arms, so a window read as
       * unfinished there would hold every departure until the next good period. The timer firing is what says the window is over, so the clock is stamped to agree.
       */
      this.#timers.schedule(() => {

        this.#stableSince = this.#clock.now() - ACCESS_REMOVAL_STABILITY_WINDOW;
        this.#actions.runSweep();
      }, delay);

      return;
    }

    if(!facts.good && (this.#stableSince !== null)) {

      this.reset();
    }
  }

  /**
   * Whether the controller has been continuously good for at least the stability window - the gate every destructive removal must pass. Recomputed on every read
   * rather than memoized, because a delay armed inside the window fires outside it and must see the answer as of its own fire time.
   */
  public get removalStable(): boolean {

    return isStabilityWindowElapsed({ nowMs: this.#clock.now(), stableSinceMs: this.#stableSince, windowMs: ACCESS_REMOVAL_STABILITY_WINDOW });
  }

  /**
   * Leave good-state: drop the clock and cancel every pending timer, the sweep one-shot and each delayed removal alike. This is the "all bets are off, no destructive
   * action during a disruption" rule as one act, so the clock and the timers can never disagree. The first-stabilization latch is deliberately untouched - it records
   * that this process has stabilized before, which a disruption does not undo.
   */
  public reset(): void {

    this.#stableSince = null;
    this.#timers.clearAll();
  }

  /* Mark an accessory for removal, honoring the user's removal delay. This is the single removal chokepoint every controller-state-driven removal routes through, and
   * the stability policy lives here: nothing schedules unless the controller has been continuously good for the window. The membership and orphan callers pre-gate on
   * `removalStable` before calling, so the in-chokepoint gate is deliberately redundant for them - it exists so the policy holds for every caller by construction
   * rather than by caller discipline. With the delay disabled (interval 0) we remove immediately - the stability gate already provided the safety. Keyed by accessory
   * UUID: the one id shared by a membership leave and an id-less cache orphan.
   *
   * @param options - See {@link RemovalScheduleOptions}.
   */
  public schedule(options: RemovalScheduleOptions): void {

    const { accessory, stillGone } = options;

    if(!this.removalStable) {

      return;
    }

    // First deadline wins: an accessory already inside its delay keeps the deadline it was given. Registering under a key replaces whatever it held, so without this
    // guard a device that keeps re-yielding while it stays gone would have its delay restarted on every yield and could outlive any bound.
    if(this.#timers.has(accessory.UUID)) {

      return;
    }

    const delayInterval = this.#graceSeconds();

    // Inline, the removal runs inside the pass that asked for it, and that pass's per-accessory catch reports a fault on the way out of HomeKit.
    if(delayInterval <= 0) {

      this.#actions.removeDevice(accessory);

      return;
    }

    this.#log.info(ACCESS_DEVICE_REMOVAL_DELAY_MESSAGE, accessory.displayName, delayInterval, delayInterval > 1 ? "s" : "");

    // The delay's removal runs from a timer the registry fires with no catch around it, so the catch takes the timer's whole body, the re-check included: a throw from
    // the re-check or from the removal would otherwise escape the timer and take Homebridge down rather than cost this accessory its removal.
    this.#timers.setTimeout(accessory.UUID, () => {

      try {

        // The caller's predicate is what decides here: it re-reads live controller state, so a device that returned during the delay is not removed. Re-confirming
        // stability alongside it is defense in depth - reaching this line with the clock dropped would mean a drain had failed to pair with the clock drop, which
        // reset() makes a single act.
        if(this.removalStable && stillGone()) {

          this.#actions.removeDevice(accessory);
        }
      } catch(error) {

        this.#log.error("Unable to remove %s from HomeKit: %s.", accessory.displayName, formatErrorMessage(error));
      }
    }, delayInterval * 1000);
  }
}
