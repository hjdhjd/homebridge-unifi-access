/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webhooks.ts: The plugin's stateful webhook mechanism - the replay ledger every accepted delivery is admitted through.
 *
 * The webhook subsystem is divided by what a piece has to remember. Every decision that is a function of its inputs alone - which header carries a signature,
 * whether a delivery is fresh, what a controller's endpoint should say - lives in policy.ts, where it is testable without standing anything up. What lives here
 * is the one piece that carries state from one delivery to the next and so cannot go there: a bounded memory of the identifiers already accepted.
 *
 * The socket underneath all of it comes from homebridge-plugin-utils, whose HttpListener owns binding and its retry, the bounded body read, path routing, and
 * the lifecycle lines a user reads; the address a controller can reach this host on comes from that same library's routing probe. Both are the mechanism any
 * plugin receiving an HTTP delivery needs, where this ledger's horizon is a policy about replay belonging to the plugin that holds it.
 */

/**
 * A bounded memory of the deliveries already accepted, keyed by the identifier the sender mints per delivery, so a captured delivery replayed inside the freshness
 * window is refused the second time.
 *
 * Entries expire on that same horizon: a delivery older than the window is refused before this ledger is ever consulted, so nothing older needs remembering, and
 * the ledger's size is bounded by the delivery rate over one window rather than by uptime.
 */
export class AccessDeliveryLedger {

  readonly #seen: Map<string, number>;
  readonly #windowMs: number;

  /**
   * @param options          - The ledger's inputs.
   * @param options.windowMs - How long an accepted identifier is remembered.
   */
  constructor(options: { windowMs: number }) {

    this.#seen = new Map();
    this.#windowMs = options.windowMs;
  }

  /**
   * Admit a delivery once.
   *
   * @param options       - The delivery's identifier and the clock reading to judge it against.
   * @param options.id    - The identifier the sender minted for this delivery.
   * @param options.nowMs - The current clock reading, injected so the ledger stays testable without waiting on real time.
   *
   * @returns `true` the first time an identifier is seen inside the window, and `false` for a repeat.
   */
  public admit(options: { id: string; nowMs: number }): boolean {

    const { id, nowMs } = options;
    const horizon = nowMs - this.#windowMs;

    // Prune on every call rather than on a timer of its own. The work is proportional to what the window actually holds, and it means the ledger owns no
    // lifecycle a caller would have to end.
    for(const [ seen, acceptedAt ] of this.#seen) {

      if(acceptedAt < horizon) {

        this.#seen.delete(seen);
      }
    }

    if(this.#seen.has(id)) {

      return false;
    }

    this.#seen.set(id, nowMs);

    return true;
  }

  // Forget every delivery this ledger remembers.
  public clear(): void {

    this.#seen.clear();
  }
}
