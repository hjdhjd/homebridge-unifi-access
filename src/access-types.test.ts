/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-types.test.ts: Type-level pins for the accessory context threading.
 *
 * ENFORCEMENT NOTE: node --strip-types executes this file without checking a single type, so the runner proves nothing here on its own. The teeth are the typecheck
 * gate - tsc --noEmit covers every test file through the base tsconfig - and the pins below are written so that a regression is a compile error rather than a
 * runtime failure.
 */
import type { AccessAccessoryContext } from "./access-types.ts";
import type { AccessPlatform } from "./access-platform.ts";
import type { PlatformAccessory } from "homebridge";
import assert from "node:assert/strict";
import test from "node:test";

/* Strict type equality, rather than bare assignability. The deferred conditional makes the checker compare the two types structurally in both directions, which is
 * what refuses a member widened to any - an assignability check accepts such a member happily and would let the context contract rot unnoticed. The type parameter
 * appears once in each signature by construction, which is the whole mechanism, so the arity rule is disabled rather than satisfied.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// The platform's accessory list is threaded with our own context type rather than homebridge's unknown-context default.
const accessoryIsThreaded: Equal<AccessPlatform["accessories"][number], PlatformAccessory<AccessAccessoryContext>> = true;

// The context's declared members keep their exact declared types.
const macIsOptionalString: Equal<AccessAccessoryContext["mac"], string | undefined> = true;
const controllerIsOptionalString: Equal<AccessAccessoryContext["controller"], string | undefined> = true;
const idIsOptionalString: Equal<AccessAccessoryContext["id"], string | undefined> = true;

/* The declared keys replace homebridge's index signature outright, so an undeclared key does not resolve at all. Without this pin every member pin above would
 * still pass while each mistyped context read fell through an index signature and resolved to something.
 */
// @ts-expect-error - reading an undeclared context key must be a compile error.
export type UndeclaredContextKey = AccessAccessoryContext["somethingUndeclared"];

test("the accessory context threading is pinned by the typechecker", () => {

  assert.equal(accessoryIsThreaded, true);
  assert.equal(macIsOptionalString, true);
  assert.equal(controllerIsOptionalString, true);
  assert.equal(idIsOptionalString, true);
});
