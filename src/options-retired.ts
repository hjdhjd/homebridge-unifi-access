/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options-retired.ts: This plugin's retired feature option families, declared as data over homebridge-plugin-utils' translation, with the settings page's migration
 * envelope beside them.
 *
 * The module is Node-side. The platform imports it to build its engine on the boot view, and the settings server imports it from dist/ to compose the patch a page
 * open commits. The page never imports it: the page's own interpreters stay types-only, and it reaches the translation through the settings server's route.
 */
import type { Nullable, RetiredController, RetiredFamily, RetiredMigration, RetiredOptions, RetiredTranslation } from "homebridge-plugin-utils";
import { createRetiredOptions, sameEntries } from "homebridge-plugin-utils";
import { featureOptionCategories, featureOptions } from "./options.ts";

/* The retired families, in the order their compositions are emitted and the startup narration names their entries, so a translated configuration reads the same
 * way run to run. Each member is spelled out rather than derived from the hub's member tables, because the members name the catalog an earlier version of this
 * plugin declared, and nothing adds to that catalog: a member a table gains later never had a switch of its own to translate. Every retired switch defaulted on,
 * which is what a composition resolves against wherever a configuration says nothing.
 */
const RETIRED_FAMILIES: readonly RetiredFamily[] = [

  { members: [

    { default: true, option: "Hub.DPS", value: "DPS" },
    { default: true, option: "Hub.REL", value: "REL" },
    { default: true, option: "Hub.REN", value: "REN" },
    { default: true, option: "Hub.REX", value: "REX" },
    { default: true, option: "Hub.SideDoor.DPS", value: "SideDoorDPS" }
  ], option: "Hub.Sensors" },
  { members: [

    { default: true, option: "Log.Doorbell", value: "Doorbell" },
    { default: true, option: "Log.DPS", value: "DPS" },
    { default: true, option: "Log.Lock", value: "Lock" },
    { default: true, option: "Log.REL", value: "REL" },
    { default: true, option: "Log.REN", value: "REN" },
    { default: true, option: "Log.REX", value: "REX" }
  ], option: "Log.Events" }
];

// The translation over this plugin's catalog, built once at module load, where homebridge-plugin-utils refuses a family that cannot mean what it says before any
// configuration is read.
const retired = createRetiredOptions({ categories: featureOptionCategories, families: RETIRED_FAMILIES, options: featureOptions });

/**
 * Read a configuration written for any version of this plugin and answer what the current engine should be built on, with the overlay a reader holding its own
 * device and controller consults before the engine.
 *
 * homebridge-plugin-utils' translation composes the families, so every surviving entry keeps its position with the compositions after them, and the entries named
 * for the startup narration list each family's own in the order the families are declared.
 *
 * @param configuredOptions - The configured feature options, exactly as they appear in the configuration.
 *
 * @returns The boot view, the overlay, and the entries the translation acted on.
 */
export function translateRetiredOptions(configuredOptions: readonly string[]): RetiredTranslation {

  return retired.translate(configuredOptions);
}

// The durable migration.

/* The patch the settings page's own controller migration produces - the per-controller properties moved into their feature options, the entries keyed by a
 * controller's address moved onto its MAC address, and each controller item rebuilt - and the envelope this module composes into. The options array is present only
 * when that migration rewrote one - a controllers-only patch is a live shape and carries no options key at all, which is why every reader here tests for the KEY
 * rather than for the patch.
 */
export interface MigrationPatch {

  readonly options?: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * Rewrite a configuration's retired feature option entries into the current grammar, permanently, as far as the supplied topology makes exact.
 *
 * This is the same translation the platform performs in memory on every boot, with the one thing that pass cannot have: the topology. homebridge-plugin-utils'
 * rewrite composes each family through the controllers that answered this pass.
 *
 * The controllers default to an empty list rather than staying omitted, because homebridge-plugin-utils reads an omitted list as a plugin with no controller level
 * and would compose a device scope against the global level alone. Every device this plugin carries sits beneath a controller, so a pass with no topology places no
 * scope: a family naming one keeps its entries exactly as written and reports itself remaining, while a family whose scopes are all global migrates exactly.
 *
 * @param args
 * @param args.configuredOptions - The configured feature options to rewrite.
 * @param args.controllers       - Optional. The controllers that answered this pass, each with the devices beneath it. Omit it for the topology-free pass.
 *
 * @returns The rewritten options and whether any family still waits for a wider topology.
 */
export function migrateRetiredOptions({ configuredOptions, controllers = [] }: Parameters<RetiredOptions["migrate"]>[0]): RetiredMigration {

  return retired.migrate({ configuredOptions, controllers });
}

/**
 * Compose the single patch a settings-page open should commit, or `null` when there is nothing to write.
 *
 * Two writers meet here and only one array can be written, so the composition is deliberately a sequence rather than a merge: the controller migration produces its
 * patch first, and the feature-option translation runs over whatever that patch left standing. Which array that is turns on the PRESENCE OF THE OPTIONS KEY, never on
 * the patch object - a controllers-only patch is a live shape, and reading its absent key would hand the translation an empty array and erase the user's settings.
 *
 * A null controller patch is the common case, not an exceptional one: virtually every existing installation finished that migration long ago. It must never be read
 * as "nothing to do", or the feature-option translation would never converge and the startup line promising it would be false.
 *
 * @param args
 * @param args.controllers     - The controllers that answered this pass, each with the devices beneath it. Omit it for the topology-free pass.
 * @param args.migratePatch    - The patch the controller migration produced, or null when it produced none.
 * @param args.platformOptions - The configuration's own feature options, which the translation runs over when the patch carries no options key.
 *
 * @returns The patch to commit (or null), and whether any family still carries retired entries.
 */
export function composeMigrationPatch({ controllers, migratePatch, platformOptions }: { controllers?: readonly RetiredController[];
  migratePatch?: Nullable<MigrationPatch>; platformOptions?: readonly string[]; }): { patch: Nullable<MigrationPatch>; remaining: boolean } {

  const source = (migratePatch && ("options" in migratePatch) && Array.isArray(migratePatch.options)) ? migratePatch.options :
    (Array.isArray(platformOptions) ? platformOptions : []);
  const migration = migrateRetiredOptions({ configuredOptions: source, controllers });

  // Whether the translation says something the configured options do not, entry for entry, which is what decides whether a rewrite is worth committing at all.
  const translated = !sameEntries(source, migration.configuredOptions, (left, right) => left === right);

  if(!migratePatch && !translated) {

    return { patch: null, remaining: migration.remaining };
  }

  return { patch: translated ? { ...migratePatch, options: [...migration.configuredOptions] } : (migratePatch ?? null), remaining: migration.remaining };
}
