/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * types.test.ts: Type-level assertions for the accessory context threading.
 *
 * ENFORCEMENT NOTE: node --strip-types executes this file without checking a single type, so the runner proves nothing here on its own. The teeth are the typecheck
 * gate - tsc --noEmit covers every test file through the base tsconfig - and the assertions below are written so that a regression is a compile error rather than a
 * runtime failure.
 */
import type { AccessAccessoryContext } from "./types.ts";
import type { AccessPlatform } from "./platform.ts";
import type { Equal } from "homebridge-plugin-utils/testing";
import type { PlatformAccessory } from "homebridge";
import assert from "node:assert/strict";
import test from "node:test";

// The platform's accessory list is threaded with our own context type rather than homebridge's unknown-context default.
const accessoryIsThreaded: Equal<AccessPlatform["accessories"][number], PlatformAccessory<AccessAccessoryContext>> = true;

// The context's declared members keep their exact declared types.
const macIsOptionalString: Equal<AccessAccessoryContext["mac"], string | undefined> = true;
const controllerIsOptionalString: Equal<AccessAccessoryContext["controller"], string | undefined> = true;
const idIsOptionalString: Equal<AccessAccessoryContext["id"], string | undefined> = true;

/* The declared keys replace homebridge's index signature outright, so an undeclared key does not resolve at all. Without this assertion every member assertion above
 * would still pass while each mistyped context read fell through an index signature and resolved to something.
 */
// @ts-expect-error - reading an undeclared context key must be a compile error.
export type UndeclaredContextKey = AccessAccessoryContext["somethingUndeclared"];

test("the accessory context threading is enforced by the typechecker", () => {

  assert.equal(accessoryIsThreaded, true);
  assert.equal(macIsOptionalString, true);
  assert.equal(controllerIsOptionalString, true);
  assert.equal(idIsOptionalString, true);
});
