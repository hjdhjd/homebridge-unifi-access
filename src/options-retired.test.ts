/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options-retired.test.ts: The translation of retired per-member feature options into the list options that carry them, as a fixture table of exact input/output
 * pairs over this plugin's own catalog and families.
 *
 * The boot view and the overlay are asserted separately because they answer different questions. The BOOT VIEW says what the engine is built on and which families
 * still need the overlay, and its output is compared entry for entry - a translation that emitted an extra entry, dropped a user's unrelated text, or reordered the
 * array would change what the engine resolves. The OVERLAY says what a reader with its own device and controller in hand gets back, which is where the retired
 * grammar's exact three-level precedence lives, and it is the half that can differ from the engine's post-translation reading: a rewrite composed without topology
 * cannot tell a controller identifier from a device one, so the rows that pair a controller scope with a device scope assert each scope's answer separately and
 * say which is which.
 *
 * The durable migration and the envelope the settings server composes are asserted the same way, over the real catalog and the real engine, so a list a row reads
 * back is the list a hub would carry.
 */
import { ALL_CHOICES, FeatureOptions } from "homebridge-plugin-utils";
import type { RetiredController, RetiredTranslation } from "homebridge-plugin-utils";
import { composeMigrationPatch, migrateRetiredOptions, translateRetiredOptions } from "./options-retired.ts";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { hubSensorChoices, logEventChoices } from "./policy.ts";
import assert from "node:assert/strict";

// The controller these rows resolve against, a sibling that proves one controller's entries never answer for another, and a device beneath the first with a sibling
// beside it.
const CONTROLLER_MAC = "AABBCCDDEEFF";
const OTHER_MAC = "112233445566";
const DEVICE_MAC = "0123456789AB";
const SIBLING_DEVICE_MAC = "0123456789AC";

// The address a controller reached with an API token alone is configured at, and the scope identity it answers by: the address with its periods repaired into
// hyphens, spelled as a literal so a row proves the spelling rather than agreeing with whatever the repair returns.
const ADDRESS = "10.0.0.1";
const ADDRESS_IDENTITY = "10-0-0-1";

// The values each list offers, read from the tables the hub and the settings page read, which is the domain every list read below resolves against.
const SENSORS = hubSensorChoices().map((choice) => choice.value);
const EVENTS = logEventChoices().map((choice) => choice.value);

// The surviving option of every retired family, in the order the module declares them, restated here rather than read from the module so a family it stopped
// declaring reddens every row that expects the family overlaid.
const FAMILY_OPTIONS = [ "Hub.Sensors", "Log.Events" ];

// The surviving options a translation still overlays, read through the overlay itself: an overlaid option answers a selection, and any other answers undefined.
function overlaid(translation: RetiredTranslation): string[] {

  return FAMILY_OPTIONS.filter((option) => translation.selection({ domain: [], option }) !== undefined);
}

// The served engine over a set of configured entries, which is how every row here reads a list back.
function engineOn(options: readonly string[]): FeatureOptions {

  return new FeatureOptions(featureOptionCategories, featureOptions, [...options]);
}

/* What a list resolves to at a scope, read through the served engine exactly as a hub's own list read takes it when the overlay answers nothing: the same domain,
 * and the same default-when-unset reading, so what these assertions prove is what a hub would carry.
 *
 * @param options - The configured entries to resolve over.
 * @param option  - The list to resolve.
 * @param id      - The device or controller scope to resolve at, or undefined for the global reading.
 *
 * @returns The members the list selects there.
 */
function selects(options: readonly string[], option: string, id?: string): readonly string[] {

  return engineOn(options).valueList({ defaultWhenUnset: true, device: id, domain: (option === "Hub.Sensors") ? SENSORS : EVENTS, option });
}

describe("the families", () => {

  /* Every switch an earlier version of this plugin declared, with the value its list stores for it, spelled here rather than read from the module, so a member whose
   * value drifted from the tables the hub reads reddens the switches it misreads. Each switch turned off alone has to leave exactly its own member out, read through
   * the engine the platform builds, against the whole of the table the hub reads its list against.
   */
  test("each retired switch turned off alone leaves exactly its own member out of its list", () => {

    for(const [ option, list, value ] of [ [ "Hub.DPS", "Hub.Sensors", "DPS" ], [ "Hub.REL", "Hub.Sensors", "REL" ], [ "Hub.REN", "Hub.Sensors", "REN" ],
      [ "Hub.REX", "Hub.Sensors", "REX" ], [ "Hub.SideDoor.DPS", "Hub.Sensors", "SideDoorDPS" ], [ "Log.Doorbell", "Log.Events", "Doorbell" ],
      [ "Log.DPS", "Log.Events", "DPS" ], [ "Log.Lock", "Log.Events", "Lock" ], [ "Log.REL", "Log.Events", "REL" ], [ "Log.REN", "Log.Events", "REN" ],
      [ "Log.REX", "Log.Events", "REX" ] ] as const) {

      const domain = (list === "Hub.Sensors") ? SENSORS : EVENTS;

      assert.deepEqual(selects(translateRetiredOptions(["Disable." + option]).configuredOptions, list), domain.filter((member) => member !== value),
        "turning " + option + " off leaves " + value + " alone out of " + list);
    }
  });
});

describe("the boot view", () => {

  // A configuration that names nothing retired is handed back untouched, the very array with nothing overlaid and nothing to narrate. This is the converged steady
  // state every migrated installation reaches, and it is what makes the overlay cost nothing there.
  test("a canonical configuration passes through as the same array, with no family overlaid and nothing translated", () => {

    const options = [ "Enable.Hub.Sensors=REL,REN", "Disable.Hub.Doorbell", "Enable.Log.Events=Lock" ];
    const translation = translateRetiredOptions(options);

    assert.equal(translation.configuredOptions, options, "the array the configuration carries is the array the engine is built on");
    assert.deepEqual(overlaid(translation), [], "no family needs the overlay");
    assert.deepEqual(translation.translated, [], "nothing was translated");
  });

  /* Text the translation cannot account for is the user's own, so it survives byte for byte, beside a retired entry as much as on its own. The translation runs on
   * every boot over every configuration, and a malformed entry or an older dotted spelling of an option the catalog still declares has to pass through rather than
   * throw or be quietly rewritten.
   */
  test("entries the translation cannot account for pass through byte-verbatim", () => {

    const options = [ "", "NotAnAction.Hub.DPS", "Enable", "Enable.Some.Option.Nobody.Declares", "Enable.Mqtt.Topic." + CONTROLLER_MAC + ".unifi" ];

    assert.deepEqual(translateRetiredOptions(options).configuredOptions, options, "the whole array survives untouched");
    assert.deepEqual(translateRetiredOptions([ ...options, "Disable.Hub.DPS" ]).configuredOptions, [ ...options, "Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS" ],
      "and beside a retired entry every one of them keeps its place, with the composition after them");
  });

  // The plain global case: one retired switch turned off composes the list of every other member, the retired entry leaves the engine's view, and the family joins
  // the overlay.
  test("a global Disable composes the list of everything else", () => {

    const translation = translateRetiredOptions(["Disable.Hub.DPS"]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS"], "the retired entry is replaced by the list of the rest");
    assert.deepEqual(overlaid(translation), ["Hub.Sensors"], "the sensor family is overlaid");
    assert.deepEqual(translation.translated, ["Disable.Hub.DPS"], "the original entry is named for the startup line");
  });

  // A switch whose own name begins with another catalog option's is still read as the switch it is.
  test("the side door's sensor composes onto the sensor list", () => {

    assert.deepEqual(translateRetiredOptions(["Disable.Hub.SideDoor.DPS"]).configuredOptions, ["Enable.Hub.Sensors=DPS,REL,REN,REX"],
      "the side door's switch is a member of the sensor family, not a scope of the side door option");
  });

  // A scope spelled in lower case is the same scope, since an identifier matches without regard to case, and its composition is written in the spelling it first
  // appeared in.
  test("a lower-cased scoped entry composes at its scope in its own spelling", () => {

    const entry = ("Disable.Log.Lock." + CONTROLLER_MAC).toLowerCase();
    const translation = translateRetiredOptions([entry]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Log.Events." + CONTROLLER_MAC.toLowerCase() + "=Doorbell,DPS,REL,REN,REX"],
      "the scope states its own list in the spelling the configuration wrote");
    assert.deepEqual(translation.translated, [entry], "the entry is named as written");
  });

  // A switch turned on that every retired switch already defaulted to restates the default, so nothing is composed for it, but it is still an entry in the older
  // grammar, and the startup line names it.
  test("a bare enable composes nothing and is named among the translated", () => {

    const translation = translateRetiredOptions(["Enable.Hub.DPS"]);

    assert.deepEqual(translation.configuredOptions, [], "the retired entry leaves and nothing replaces it");
    assert.deepEqual(translation.translated, ["Enable.Hub.DPS"], "the entry is still named for the startup line");
  });

  /* A list the user wrote is evidence that they have adopted the current grammar, so it wins outright: the retired entries beside it leave the engine's view,
   * nothing is composed to compete with the list, and the family does NOT join the overlay. This is the row that tells the composition apart from an overwrite of
   * the user's own entry by the family's.
   */
  test("the user's own list outranks the family, which is still named", () => {

    const translation = translateRetiredOptions([ "Enable.Hub.Sensors=REL", "Disable.Hub.DPS" ]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Hub.Sensors=REL"], "the user's own list is what the engine is left with");
    assert.deepEqual(overlaid(translation), [], "a superseded family is not overlaid");
    assert.deepEqual(translation.translated, ["Disable.Hub.DPS"], "the superseded entry is still named for the startup line");
  });

  // Every member turned off at a scope is the empty selection, which the plain scoped Disable states exactly.
  test("every member off at a scope composes the plain Disable", () => {

    const translation = translateRetiredOptions([ "DPS", "REL", "REN", "REX", "SideDoor.DPS" ].map((member) => "Disable.Hub." + member + "." + DEVICE_MAC));

    assert.deepEqual(translation.configuredOptions, ["Disable.Hub.Sensors." + DEVICE_MAC], "no sensor survives at the device, which the plain Disable states");
    assert.deepEqual(selects(translation.configuredOptions, "Hub.Sensors", DEVICE_MAC), [], "and the device reads no sensor at all");
  });
});

describe("the overlay", () => {

  // The overlay answers only for a family the configuration still carries in the retired grammar, so a configuration naming nothing retired answers undefined and the
  // reader reads the engine as it always does.
  test("an unconfigured family leaves the reader to the engine", () => {

    assert.equal(translateRetiredOptions([]).selection({ controller: CONTROLLER_MAC, device: DEVICE_MAC, domain: SENSORS, option: "Hub.Sensors" }), undefined);
  });

  /* The three-level row the overlay exists for. A controller-scoped Disable and a device-scoped re-enable compose the way they always have: the device's own entry
   * outranks its controller's, so the device keeps every sensor, while a sibling beneath the same controller reads the controller's composition. The boot view
   * composes the device's scope against the global level alone and states nothing for it, which is the approximation the overlay answers ahead of.
   */
  test("a controller Disable with a device re-enable answers every member at that device and the controller's composition at a sibling", () => {

    const translation = translateRetiredOptions([ "Disable.Hub.DPS." + CONTROLLER_MAC, "Enable.Hub.DPS." + DEVICE_MAC ]);

    assert.deepEqual(translation.selection({ controller: CONTROLLER_MAC, device: DEVICE_MAC, domain: SENSORS, option: "Hub.Sensors" }), SENSORS,
      "the device's own re-enable outranks its controller's disable");
    assert.deepEqual(translation.selection({ controller: CONTROLLER_MAC, device: SIBLING_DEVICE_MAC, domain: SENSORS, option: "Hub.Sensors" }),
      [ "REL", "REN", "REX", "SideDoorDPS" ], "a sibling beneath the same controller reads the controller's composition");
    assert.deepEqual(translation.configuredOptions, ["Enable.Hub.Sensors." + CONTROLLER_MAC + "=REL,REN,REX,SideDoorDPS"],
      "while the boot view states nothing for the device, which is why the overlay answers ahead of the engine");
  });

  // A controller-scoped entry reaches the devices beneath that controller and no other, so an overlay blind to which controller a device sits under fails here.
  test("a controller-scoped entry never answers for another controller", () => {

    const translation = translateRetiredOptions(["Disable.Log.Lock." + CONTROLLER_MAC]);

    assert.deepEqual(translation.selection({ controller: CONTROLLER_MAC, device: DEVICE_MAC, domain: EVENTS, option: "Log.Events" }),
      [ "Doorbell", "DPS", "REL", "REN", "REX" ], "a device beneath the controller loses the category its controller turned off");
    assert.deepEqual(translation.selection({ controller: OTHER_MAC, device: SIBLING_DEVICE_MAC, domain: EVENTS, option: "Log.Events" }), EVENTS,
      "a device beneath another controller keeps every category");
  });

  // The answer is expressed in the caller's own domain spelling and confined to it, so a member the configuration selected that the device does not offer is absent
  // rather than handed back as a member of a domain it never belonged to.
  test("the selection is answered in the domain's own spelling and confined to it", () => {

    assert.deepEqual(translateRetiredOptions(["Disable.Hub.DPS"]).selection({ controller: CONTROLLER_MAC, device: DEVICE_MAC, domain: [ "dps", "rel", "rex" ],
      option: "Hub.Sensors" }), [ "rel", "rex" ]);
  });
});

describe("the durable migration", () => {

  // The topology the settings page's probes gather: one controller with a device beneath it.
  const TOPOLOGY: RetiredController[] = [{ devices: [DEVICE_MAC], id: CONTROLLER_MAC }];

  test("a globally disabled sensor composes the list of everything else, and the retired entry leaves", () => {

    const migration = migrateRetiredOptions({ configuredOptions: ["Disable.Hub.DPS"] });

    assert.deepEqual(migration.configuredOptions, ["Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS"],
      "one member's switch turned off composes the family's list carrying every other member");
    assert.deepEqual(selects(migration.configuredOptions, "Hub.Sensors"), [ "REL", "REN", "REX", "SideDoorDPS" ],
      "and the composed list resolves to exactly those members");
    assert.deepEqual(selects(migration.configuredOptions, "Log.Events"), EVENTS, "while the family nothing was configured for composes nothing and still reads whole");
  });

  test("a scoped logging category turned off composes that scope's list alone", () => {

    const migration = migrateRetiredOptions({ configuredOptions: ["Disable.Log.Lock." + CONTROLLER_MAC], controllers: TOPOLOGY });

    assert.deepEqual(selects(migration.configuredOptions, "Log.Events", CONTROLLER_MAC), [ "Doorbell", "DPS", "REL", "REN", "REX" ],
      "the scope the entry named composes a list less the category it turned off");
    assert.deepEqual(selects(migration.configuredOptions, "Log.Events"), EVENTS, "and the global reading is untouched, because nothing was configured there");
    assert.deepEqual(selects(migration.configuredOptions, "Log.Events", OTHER_MAC), EVENTS, "as is every other scope's");
  });

  test("a member re-enabled at one scope over a global disable keeps that scope every member", () => {

    const migration = migrateRetiredOptions({ configuredOptions: [ "Disable.Hub.DPS", "Enable.Hub.DPS." + DEVICE_MAC ], controllers: TOPOLOGY });

    assert.ok(migration.configuredOptions.includes("Enable.Hub.Sensors." + DEVICE_MAC + "=" + ALL_CHOICES),
      "a scope whose composition is every member stores the all-members form the catalog registers, rather than restating the whole list");
    assert.deepEqual(selects(migration.configuredOptions, "Hub.Sensors", DEVICE_MAC), SENSORS, "so the device keeps the sensor the global entry took away");
    assert.deepEqual(selects(migration.configuredOptions, "Hub.Sensors"), [ "REL", "REN", "REX", "SideDoorDPS" ], "while every other hub reads the global composition");
  });

  test("a retired entry is read and dropped in any spelling the grammar accepts", () => {

    // The lower-cased dotted spelling is one a hand-authored 1.x file carries, and the translation reads it through the engine's own grammar rather than by matching
    // text, so it is dropped by the same reading that composed from it.
    const migration = migrateRetiredOptions({ configuredOptions: [("Disable.Hub.REX." + CONTROLLER_MAC).toLowerCase()], controllers: TOPOLOGY });

    assert.deepEqual(selects(migration.configuredOptions, "Hub.Sensors", CONTROLLER_MAC), [ "DPS", "REL", "REN", "SideDoorDPS" ],
      "the entry is read at the scope it names");

    for(const entry of migration.configuredOptions) {

      assert.ok(!entry.toLowerCase().includes("hub.rex"), "and no retired entry survives the pass: " + entry);
    }
  });

  test("a scope restating what it would inherit composes no entry of its own", () => {

    const migration = migrateRetiredOptions({ configuredOptions: [ "Disable.Hub.DPS", "Disable.Hub.DPS." + DEVICE_MAC ], controllers: TOPOLOGY });

    assert.deepEqual(migration.configuredOptions, ["Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS"],
      "the scoped entry composes the same members the global one does, so emitting a scoped list would churn the file for nothing");
    assert.deepEqual(selects(migration.configuredOptions, "Hub.Sensors", DEVICE_MAC), [ "REL", "REN", "REX", "SideDoorDPS" ],
      "and the device still reads what it read before");
  });

  test("the side door's sensor and the doorbell category compose onto their own families", () => {

    const sensors = migrateRetiredOptions({ configuredOptions: ["Disable.Hub.SideDoor.DPS"] });

    assert.deepEqual(selects(sensors.configuredOptions, "Hub.Sensors"), [ "DPS", "REL", "REN", "REX" ],
      "a name whose own prefix is another catalog option is still read as the option it is");

    const events = migrateRetiredOptions({ configuredOptions: ["Disable.Log.Doorbell"] });

    // The raw entry is read as well as its resolved reading, because the engine resolves members in its own domain order and only the entry shows the order composed.
    assert.deepEqual(events.configuredOptions, ["Enable.Log.Events=DPS,Lock,REL,REN,REX"],
      "and the doorbell category composes onto the logging list in the order it lists them");
    assert.deepEqual(selects(events.configuredOptions, "Log.Events"), [ "DPS", "Lock", "REL", "REN", "REX" ], "which resolves to exactly those categories");
  });

  // A scoped entry cannot be placed without topology, so the family keeps its entries untouched and says so. Nothing is guessed at and nothing is lost.
  test("a scoped entry with no topology keeps its family's entries and reports them remaining", () => {

    const options = ["Disable.Hub.DPS." + DEVICE_MAC];
    const migration = migrateRetiredOptions({ configuredOptions: options });

    assert.deepEqual(migration.configuredOptions, options, "the entries stand exactly as written");
    assert.equal(migration.remaining, true, "the caller is told to probe wider and come back");
  });

  /* Every device this plugin carries sits beneath a controller, so an omitted topology and an empty one are the same pass: neither places a scope, and a scoped family
   * keeps its entries whole and reports itself remaining either way rather than composing a device scope against the global level alone.
   */
  test("an omitted topology and an empty one place nothing alike", () => {

    const options = ["Disable.Hub.DPS." + DEVICE_MAC];

    for(const migration of [ migrateRetiredOptions({ configuredOptions: options }), migrateRetiredOptions({ configuredOptions: options, controllers: [] }) ]) {

      assert.deepEqual(migration.configuredOptions, options, "the entries stand exactly as written");
      assert.equal(migration.remaining, true, "the caller is told to probe wider and come back");
    }
  });

  /* The topology-exact composition, and the reason the migration waits for topology at all. A controller-scoped Disable and a device-scoped re-enable compose at the
   * device through its TRUE three-level walk, which the in-memory rewrite cannot reach: without knowing that this device sits under that controller, the device's own
   * scope composes against the global level alone and loses its re-enable. The written entry is what the runtime reads from then on, so it has to be the exact one.
   */
  test("a controller and a device beneath it migrate exactly once the topology places them", () => {

    const options = [ "Disable.Hub.DPS." + CONTROLLER_MAC, "Enable.Hub.DPS." + DEVICE_MAC ];
    const migration = migrateRetiredOptions({ configuredOptions: options, controllers: TOPOLOGY });
    const engine = engineOn(migration.configuredOptions);

    assert.equal(migration.remaining, false, "every scope was placed, so nothing is left for a later pass");
    assert.deepEqual(migration.configuredOptions, [ "Enable.Hub.Sensors." + CONTROLLER_MAC + "=REL,REN,REX,SideDoorDPS",
      "Enable.Hub.Sensors." + DEVICE_MAC + "=" + ALL_CHOICES ], "the controller states its own list and the device states every member");
    assert.deepEqual(engine.valueList({ controller: CONTROLLER_MAC, defaultWhenUnset: true, device: DEVICE_MAC, domain: SENSORS, option: "Hub.Sensors" }), SENSORS,
      "so the device keeps the sensor its controller turned off");
    assert.deepEqual(engine.valueList({ controller: CONTROLLER_MAC, defaultWhenUnset: true, device: SIBLING_DEVICE_MAC, domain: SENSORS, option: "Hub.Sensors" }),
      [ "REL", "REN", "REX", "SideDoorDPS" ], "while a sibling beneath the same controller reads the controller's list");

    // The same configuration without topology composes the device's scope against the global level alone, which is the approximation this pass exists to replace.
    assert.equal(migrateRetiredOptions({ configuredOptions: options }).remaining, true, "without topology the family waits rather than writing the approximation");
  });

  // A controller reached with an API token alone answers by its address identity, and the page hands that identity over as the controller's own, so the devices it
  // lists place beneath it exactly as a credentialed controller's do.
  test("a token-only controller's address identity places its devices", () => {

    const migration = migrateRetiredOptions({ configuredOptions: [ "Disable.Hub.DPS." + ADDRESS_IDENTITY, "Enable.Hub.DPS." + DEVICE_MAC ],
      controllers: [{ devices: [DEVICE_MAC], id: ADDRESS_IDENTITY }] });

    assert.equal(migration.remaining, false, "the address identity placed the controller's scope and the device's");
    assert.deepEqual(migration.configuredOptions, [ "Enable.Hub.Sensors." + ADDRESS_IDENTITY + "=REL,REN,REX,SideDoorDPS",
      "Enable.Hub.Sensors." + DEVICE_MAC + "=" + ALL_CHOICES ], "the controller and the device beneath it compose exactly");
  });

  // Retirement is per family: one family whose scopes the topology places migrates while another whose scope it cannot keeps its entries, in a single pass.
  test("a family the topology cannot place waits while its neighbors migrate", () => {

    const options = [ "Disable.Hub.DPS", "Disable.Log.Lock.EEFF00112233" ];
    const migration = migrateRetiredOptions({ configuredOptions: options, controllers: TOPOLOGY });

    assert.deepEqual(migration.configuredOptions, [ "Disable.Log.Lock.EEFF00112233", "Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS" ],
      "the placeable family is rewritten and the unplaceable one stands exactly as written");
    assert.equal(migration.remaining, true, "the unplaceable family is reported so a later pass can finish it");
  });
});

describe("the migration envelope", () => {

  /* The common install: the controller migration finished long ago and answers null, while the feature options still speak the retired grammar. A null controller
   * patch must never read as "nothing to do" - virtually every existing configuration is in exactly this state, and reading it that way would leave the translation
   * to never converge and the startup line promising it to be false.
   */
  test("a null controller patch with a translation to make still commits", () => {

    const composed = composeMigrationPatch({ migratePatch: null, platformOptions: ["Disable.Hub.DPS"] });

    assert.deepEqual(composed.patch, { options: ["Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS"] }, "the translation alone is worth a write");
  });

  /* A controllers-only patch is a live shape: the controller migration can rebuild the controllers array while carrying no options key at all. What selects the
   * array the translation runs over is the PRESENCE OF THAT KEY, never the patch object - reading an absent key would hand the translation an empty array and erase
   * the user's settings on the way to writing it back.
   */
  test("a controllers-only patch composes with the configuration's own options intact", () => {

    const composed = composeMigrationPatch({ migratePatch: { controllers: [{ address: ADDRESS }] }, platformOptions: ["Disable.Hub.DPS"] });

    assert.deepEqual(composed.patch, { controllers: [{ address: ADDRESS }], options: ["Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS"] },
      "the controllers rewrite and the translated options share one patch");
  });

  /* The controller migration and the translation write one options array between them: the translation runs over what the controller migration produced, so the
   * final patch carries the composition rather than a race. The controller migration here moved an entry keyed by the controller's address onto its MAC address,
   * which the configuration's own options do not yet say.
   */
  test("both writers compose into one options write", () => {

    const composed = composeMigrationPatch({ migratePatch: { options: [ "Enable.Mqtt.Topic." + CONTROLLER_MAC + "=unifi/gate", "Disable.Hub.DPS" ] },
      platformOptions: [ "Enable.Mqtt.Topic." + ADDRESS_IDENTITY + "=unifi/gate", "Disable.Hub.DPS" ] });

    assert.deepEqual(composed.patch, { options: [ "Enable.Mqtt.Topic." + CONTROLLER_MAC + "=unifi/gate", "Enable.Hub.Sensors=REL,REN,REX,SideDoorDPS" ] },
      "the controller migration's own move survives and the retired entry beside it is rewritten");
  });

  // A converged configuration with nothing for the controller migration or the translation to do answers null, which is what keeps a settings-page open from
  // touching the disk at all.
  test("neither writer having anything to do answers null", () => {

    const composed = composeMigrationPatch({ migratePatch: null, platformOptions: ["Enable.Hub.Sensors=REL,REN"] });

    assert.equal(composed.patch, null, "a configuration already carrying its lists has nothing left to find, so a later open stages no patch");
    assert.equal(composed.remaining, false, "and nothing is left to place");
    assert.equal(composeMigrationPatch({ migratePatch: null, platformOptions: [] }).patch, null, "and neither does one carrying no entries at all");
  });

  // A controller patch the translation finds nothing to add to is committed exactly as it arrived, with no options key manufactured for it.
  test("a controller patch the translation leaves alone commits unchanged", () => {

    const migratePatch = { controllers: [{ address: ADDRESS }] };
    const composed = composeMigrationPatch({ migratePatch, platformOptions: ["Enable.Hub.Sensors=REL,REN"] });

    assert.deepEqual(composed.patch, migratePatch, "the patch is handed back as it came, carrying no options key it never had");
  });

  // The detector half the settings page gates its wider controller probes on: a scoped entry the topology-free pass cannot place is reported, and nothing is written
  // for its family until a pass that can place it.
  test("the envelope reports a family still needing topology", () => {

    const composed = composeMigrationPatch({ migratePatch: null, platformOptions: ["Disable.Hub.DPS." + DEVICE_MAC] });

    assert.equal(composed.remaining, true, "the page is told to probe wider");
    assert.equal(composed.patch, null, "and nothing is written in the meantime");
  });

  // The user's own list outranks the family on the page as it does at startup: the retired entries beside it leave, and the list is written as the user wrote it.
  test("the user's own list outranks the family through the envelope", () => {

    const composed = composeMigrationPatch({ migratePatch: null, platformOptions: [ "Enable.Hub.Sensors=REL", "Disable.Hub.DPS" ] });

    assert.deepEqual(composed.patch, { options: ["Enable.Hub.Sensors=REL"] }, "the retired entry leaves and the user's own list stands");
    assert.equal(composed.remaining, false, "and a superseded family needs no later pass");
  });
});
