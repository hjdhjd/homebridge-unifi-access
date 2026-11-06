/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.test.ts: The plugin's entry point, loaded first and called the way Homebridge calls it.
 *
 * Homebridge loads a plugin through its entry point, so the entry is the first plugin module to evaluate and every other module evaluates in the order the entry's
 * imports reach it. Every other suite loads its subject and its helpers first, which evaluates the plugin in another order, so a module that reads at load a binding
 * its import cycle has not yet initialized in the entry's order fails only when the entry loads first. Node runs each test file in its own process, so this one loads
 * the plugin as Homebridge does: its static imports are Node's own, and the entry is the first plugin module it imports.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { default: registerPlugin } = await import("./index.ts");

// The entry has already loaded these modules, so importing them evaluates nothing and hands back the very bindings the entry registered.
const { PLATFORM_NAME, PLUGIN_NAME } = await import("./settings.ts");
const { AccessPlatform } = await import("./platform.ts");

// The entry reads registerPlatform alone from the API Homebridge hands it, so a recorder carrying that one call stands in for the whole API.
test("the plugin's entry point registers the platform once, under the plugin's name and the platform's", () => {

  const registrations: unknown[][] = [];

  registerPlugin({ registerPlatform: (...registration: unknown[]): void => {

    registrations.push(registration);
  } } as unknown as Parameters<typeof registerPlugin>[0]);

  assert.deepEqual(registrations, [[ PLUGIN_NAME, PLATFORM_NAME, AccessPlatform ]], "one registration, of AccessPlatform under PLUGIN_NAME and PLATFORM_NAME");
});
