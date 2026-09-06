/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webhooks.test.ts: Tests for the plugin's replay ledger.
 *
 * The module under test holds the one piece of the delivery path that remembers anything from one delivery to the next, so this file is about exactly that:
 * what the ledger admits, what it refuses as a repeat, and what it forgets. The listener a delivery arrives through and the probe that finds this host's
 * reachable address belong to homebridge-plugin-utils and are covered by its suite, and the pure decisions around the ledger by the policy suite.
 */
import { AccessDeliveryLedger } from "./webhooks.ts";
import assert from "node:assert/strict";
import test from "node:test";

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
