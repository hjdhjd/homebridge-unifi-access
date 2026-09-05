/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.test.ts: Tests for the feature option catalog's metadata channel and its documentation scope hooks.
 *
 * Every arm here drives the REAL catalog rather than a fixture of its own, which is what makes the completeness sweep meaningful: a capability flag added to an
 * option without prose to describe it fails this suite rather than surfacing in the published reference as a raw wire key. The model vocabulary needs no such sweep
 * because it is a closed union the compiler already holds the map to.
 */
import { describeCategoryScope, describeOptionScope, featureOptionCategories, featureOptions } from "./options.ts";
import { ACCESS_WEBHOOK_PORT } from "./settings.ts";
import type { AccessFeatureOption } from "./options.ts";
import assert from "node:assert/strict";
import { buildCatalogIndex } from "homebridge-plugin-utils";
import test from "node:test";

// The catalog entry a category and option name address, asserted to exist so each check below reads an entry rather than a nullable one.
function entryFor(category: string, name: string): AccessFeatureOption {

  const entry = (featureOptions[category] ?? []).find(option => option.name === name);

  assert.ok(entry, "the catalog should declare " + category + "." + name);

  return entry;
}

// Every capability flag the live catalog gates anything on, options and categories alike, deduplicated.
function configuredCapabilities(): string[] {

  const flags = new Set<string>();

  for(const category of featureOptionCategories) {

    for(const flag of category.meta?.hasCapability ?? []) {

      flags.add(flag);
    }
  }

  for(const entries of Object.values(featureOptions)) {

    for(const entry of entries) {

      for(const flag of entry.meta?.hasCapability ?? []) {

        flags.add(flag);
      }
    }
  }

  return [...flags];
}

test("every capability the catalog gates on has documentation prose", () => {

  const flags = configuredCapabilities();

  assert.ok(flags.length > 0, "the sweep is only meaningful against a catalog that actually gates on capabilities");

  for(const flag of flags) {

    // The hook falls back to the raw key for a flag the map does not carry, so the suffix rendering the key verbatim is exactly what an unmapped flag looks like.
    const rendered = describeOptionScope({ default: true, description: "", meta: { hasCapability: [flag] }, name: "Probe" });

    assert.ok(rendered, flag + " should render a scope suffix");
    assert.ok(!rendered.includes(" <BR>*Supported on " + flag + ".*"), flag + " should resolve to prose rather than surfacing as a raw capability key");
  }
});

test("the doorbell family is gated on the doorbell capability", () => {

  for(const name of [ "Doorbell", "Doorbell.DoorGuards", "Doorbell.Trigger" ]) {

    assert.deepEqual(entryFor("Hub", name).meta, { hasCapability: ["door_bell"] }, "Hub." + name + " declares the doorbell capability and nothing else");
  }

  assert.deepEqual(entryFor("Log", "Doorbell").meta, { hasCapability: ["door_bell"] }, "the logging option for the same events is gated identically");
});

test("the terminal input sensors carry the model sets their hardware supports", () => {

  for(const category of [ "Hub", "Log" ]) {

    assert.deepEqual(entryFor(category, "DPS").meta, { modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini", "UA Gate" ] },
      category + ".DPS covers every hub that drives a door position sensor");
    assert.deepEqual(entryFor(category, "REL").meta, { modelKey: ["UA Hub"] }, category + ".REL is a UA Hub input alone");
    assert.deepEqual(entryFor(category, "REN").meta, { modelKey: ["UA Hub"] }, category + ".REN is a UA Hub input alone");
    assert.deepEqual(entryFor(category, "REX").meta, { modelKey: [ "UA Ultra", "UA Hub", "UA Hub Door Mini" ] },
      category + ".REX covers the hubs that drive a request to exit input, and never the gate");
  }
});

test("the side door group is scoped to the gate that has one", () => {

  for(const name of [ "SideDoor", "SideDoor.DPS", "SideDoor.Lock.Trigger" ]) {

    assert.deepEqual(entryFor("Hub", name).meta, { modelKey: ["UA Gate"] }, "Hub." + name + " belongs to the UA Gate alone");
  }

  for(const name of [ "SideDoor.DPS", "SideDoor.Lock.Trigger" ]) {

    assert.equal(entryFor("Hub", name).group, "SideDoor", "Hub." + name + " hangs off the side door lock, so it hides when that lock is turned off");
  }
});

test("a capability-gated option renders its own prose suffix", () => {

  assert.equal(describeOptionScope(entryFor("AccessMethod", "Face")), " <BR>*Supported on UniFi Access readers that support face unlock authentication.*",
    "the capability gate is what the suffix names");
  assert.equal(describeOptionScope(entryFor("Hub", "SideDoor")), " <BR>*Supported on UniFi Access Gate.*",
    "an option gated on a model alone names the model instead");
  assert.equal(describeOptionScope(entryFor("Hub", "Lock.Trigger")), undefined, "an option gated on nothing at all gets no suffix");
});

test("a category scoped to every device type renders no scope sentence", () => {

  for(const name of [ "Device", "Hub", "AccessMethod", "Log" ]) {

    const category = featureOptionCategories.find(entry => entry.name === name);

    assert.ok(category, "the catalog should declare the " + name + " category");
    assert.deepEqual(category.meta?.modelKey, ["all"], name + " is scoped to every device type");
    assert.equal(describeCategoryScope(category), undefined, "the sentinel says every device type, so there is no scope worth naming");
  }
});

test("a controller-scoped category names the controller in its scope sentence", () => {

  const category = featureOptionCategories.find(entry => entry.name === "Controller");

  assert.ok(category, "the catalog should declare the Controller category");
  assert.equal(describeCategoryScope(category), "These option(s) apply to: Access controllers.", "controller scope is prose a reader gains something from");
});

test("the generated MQTT options carry no meta and document unconditionally", () => {

  const category = featureOptionCategories.find(entry => (entry.name !== "Controller") && (entry.meta?.modelKey?.[0] === "controller"));

  assert.ok(category, "the generated MQTT category should be present and scoped to the controller");

  const entries = featureOptions[category.name] ?? [];

  assert.ok(entries.length > 0, "the generated category should carry its options");

  for(const entry of entries) {

    assert.equal(entry.meta, undefined, category.name + "." + entry.name + " comes from the shared generator, which declares no meta channel of its own");
    assert.equal(describeOptionScope(entry), undefined, "an entry with no meta is documented without any scope qualification");
  }
});

test("the webhook options declare the defaults and the scope the listener and the webUI both read", () => {

  const webhooks = entryFor("Controller", "Webhooks");

  // The feature is off until a user turns it on, and it carries no value of its own.
  assert.equal(webhooks.default, false);
  assert.equal(webhooks.defaultValue, undefined);
  assert.equal(webhooks.scopes, undefined, "an entry declaring no scopes is offered at every scope its category allows");

  const port = entryFor("Controller", "Webhooks.Port");

  /* One listener serves every controller, so the port is a plugin-wide deployment decision rather than a per-controller one and the entry is declared
   * global-only. The framework admits an option to a view only where its scopes tuple names that view's kind, which is what keeps this one off a controller's
   * own view while the option that turns the feature on stays there.
   */
  assert.equal(port.default, true);
  assert.equal(port.defaultValue, ACCESS_WEBHOOK_PORT);
  assert.deepEqual(port.scopes, ["global"]);
  assert.equal(port.group, "Webhooks", "the port renders beneath the option that turns the feature on");
});

test("the door guard filter is a device-scoped picker over a page-registered source", () => {

  const guards = entryFor("Hub", "Doorbell.DoorGuards");

  // A picker over the guards the door in view lists, storing the selection as a list, offered only where a door is in view.
  assert.equal(guards.choices, "doorGuards");
  assert.equal(guards.multiple, true);
  assert.deepEqual(guards.scopes, ["device"]);

  // Offered as soon as the row renders, with nothing selected, which the filter reads as no filtering.
  assert.equal(guards.default, true);
  assert.equal(guards.defaultValue, "");
});

test("the catalog builds: every picker declaration is one the engine honors", () => {

  assert.doesNotThrow(() => buildCatalogIndex(featureOptionCategories, featureOptions));
});
