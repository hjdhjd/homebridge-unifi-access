/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.test.ts: Tests for the feature option catalog's metadata channel and its documentation scope hooks.
 *
 * Every arm here drives the REAL catalog rather than a fixture of its own, which is what makes the completeness sweep meaningful: a capability flag added to an
 * option without prose to describe it fails this suite rather than surfacing in the published reference as a raw wire key. The model vocabulary needs no such sweep
 * because it is a closed union the compiler already holds the map to.
 */
import { ALL_CHOICES, buildCatalogIndex } from "homebridge-plugin-utils";
import { accessMethodChoices, doorServiceChoices, hubSensorChoices, hubSensorModels, logEventChoices } from "./policy.ts";
import { describeCategoryScope, describeOptionScope, featureOptionCategories, featureOptions } from "./options.ts";
import { ACCESS_WEBHOOK_PORT } from "./settings.ts";
import type { AccessFeatureOption } from "./options.ts";
import assert from "node:assert/strict";
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
});

test("the side door group is scoped to the gate that has one", () => {

  for(const name of [ "SideDoor", "SideDoor.Lock.Trigger" ]) {

    assert.deepEqual(entryFor("Hub", name).meta, { modelKey: ["UA Gate"] }, "Hub." + name + " belongs to the UA Gate alone");
  }

  assert.equal(entryFor("Hub", "SideDoor.Lock.Trigger").group, "SideDoor",
    "Hub.SideDoor.Lock.Trigger hangs off the side door lock, so it hides when that lock is turned off");
});

test("a capability-gated option renders its own prose suffix", () => {

  assert.equal(describeOptionScope(entryFor("AccessMethod", "Switches")), " <BR>*Supported on UniFi Access readers.*",
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

test("the door service is one inline choice whose default is the automatic one, offered on every hub", () => {

  const service = entryFor("Hub", "Door.Service");

  assert.equal(service.choices, doorServiceChoices, "the catalog offers the policy's own list, never a copy of it");
  assert.equal(service.default, true);
  assert.equal(service.defaultValue, "Automatic");
  assert.equal(service.meta, undefined, "every hub model has a door, so nothing narrows where the choice is offered");
  assert.equal(service.scopes, undefined);

  for(const name of [ "Door.UseLock", "Door.UseGarageOpener" ]) {

    assert.equal(featureOptions["Hub"]?.find(option => option.name === name), undefined, "Hub." + name + " is not a catalog entry");
  }
});

test("the access methods are one selection over a page-registered source, none selected by default, offered on readers", () => {

  const entries = featureOptions["AccessMethod"] ?? [];

  assert.deepEqual(entries.map(entry => entry.name), ["Switches"], "one selection stands for every method");

  const switches = entryFor("AccessMethod", "Switches");

  assert.equal(switches.choices, "accessMethods");
  assert.equal(switches.multiple, true);
  assert.equal(switches.default, true);
  assert.equal(switches.defaultValue, "");
  assert.deepEqual(switches.meta?.hasCapability, ["is_reader"]);

  // The domain the page offers where no reader is in view is the catalog's own list, so the two can never disagree about a method's spelling.
  assert.deepEqual(switches.meta?.choiceDomain, accessMethodChoices());
});

test("the hub's sensors and its logging categories are each one all-members selection over a page-registered source", () => {

  const sensors = entryFor("Hub", "Sensors");

  assert.equal(sensors.choices, "hubSensors");
  assert.equal(sensors.multiple, true);
  assert.equal(sensors.default, true);
  assert.equal(sensors.defaultValue, ALL_CHOICES, "an unconfigured hub selects every sensor, which is what keeps a 1.x hub carrying the ones it always had");
  assert.deepEqual(sensors.meta?.choiceDomain, hubSensorChoices(), "the domain offered where no hub is in view is the whole member table");

  /* The row's page visibility follows the table rather than a hand-spelled union, and the union the table answers is the scope this option is published under, so
   * both readings are held: a member added to the table brings its model with it, and the published scope is asserted as the literal a reader sees.
   */
  assert.deepEqual(sensors.meta?.modelKey, hubSensorModels());
  assert.deepEqual(sensors.meta?.modelKey, [ "UA Ultra", "UA Hub", "UA Hub Door Mini", "UA Gate" ]);

  const events = entryFor("Log", "Events");

  assert.equal(events.choices, "logEvents");
  assert.equal(events.multiple, true);
  assert.equal(events.default, true);
  assert.equal(events.defaultValue, ALL_CHOICES, "and every category is logged until a user narrows the list");
  assert.deepEqual(events.meta?.choiceDomain, logEventChoices());
  assert.deepEqual(events.meta?.hasCapability, ["is_hub"], "the categories are a hub's own events, so the row is offered on hubs alone");
});

test("no per-sensor or per-category boolean survives in the catalog", () => {

  // Each name a 1.x configuration addressed a single sensor or a single logged category by. The lists supersede all of them, and the settings migration is what
  // carries a user's choices across, so a name still declared here would be a second home for a setting that has one.
  const retired = { Hub: [ "DPS", "REL", "REN", "REX", "SideDoor.DPS" ], Log: [ "Doorbell", "DPS", "Lock", "REL", "REN", "REX" ] };

  for(const [ category, names ] of Object.entries(retired)) {

    for(const name of names) {

      assert.equal((featureOptions[category] ?? []).find(option => option.name === name), undefined, category + "." + name + " is not a catalog entry");
    }
  }
});

test("an option scoped to several models or several flags names every one in its suffix, and repeated prose is named once", () => {

  assert.equal(describeOptionScope(entryFor("Hub", "Sensors")),
    " <BR>*Supported on UniFi Access Ultra, UniFi Access Hub, UniFi Access Hub Door Mini, and UniFi Access Gate.*", "every model the option is scoped to is named");

  // Two capability flags that share one description are named once, and a capability list outranks a model list beside it.
  const probe: AccessFeatureOption = { default: true, description: "", meta: { hasCapability: [ "mobile_unlock_ver2", "support_mobile_unlock" ], modelKey: ["UA Hub"] },
    name: "Probe" };

  assert.equal(describeOptionScope(probe), " <BR>*Supported on UniFi Access readers that support mobile authentication.*");

  // A model list carrying only the every-device sentinel names nothing.
  assert.equal(describeOptionScope({ default: true, description: "", meta: { modelKey: ["all"] }, name: "Probe" }), undefined);
});
