/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-config.mjs: Pure interpreters over the injected Access platform configuration.
 */
"use strict";

/* The single home for our plugin-config shape. Every function here is pure - no I/O, no global reach - and reads the primary platform-config entry the webUI
 * framework injects into our hooks or what the UI server's probe answered. The framework owns reading and writing the persisted config through its session; this
 * module owns the Access-specific knowledge of what a controller is, what counts as an identity it can connect with, and what the UI server's probe answered.
 * Keeping that knowledge in one place means a config-shape change is a single edit, and it keeps the hooks in ui.mjs from reading the entry's shape themselves:
 * they reach its controllers and its options only through these helpers.
 *
 * Two settings substrates meet here. A feature option is where a setting lives, and a set of per-controller configuration properties are a second home the plugin
 * honors so that a configuration nobody has opened the webUI on keeps working. The migration reconciles the two, moving each property's value into the option that
 * supersedes it and rebuilding the item without it, and the same pass folds the retired 1.x per-member booleans into the lists that supersede them and carries the
 * entries keyed by a controller's address onto its MAC address. The module takes no imports at all - the engine class, the served catalog, homebridge-plugin-utils'
 * listed-address and display-name rules, and every framework helper the interpreters use are handed in - so the whole of it is exercisable under Node against the
 * real engine, the real catalog, and the real rules, with no network and no DOM.
 */

/* The keys a controllers[] item converges to: everything the plugin's own controller options type declares, less the properties that migrate into feature
 * options. Each item's successor is rebuilt from this list rather than edited down from the original, which is what retires a key by simply never carrying it - a
 * consumed legacy key leaves that way, as does any key a hand-edit left behind that neither the plugin nor its configuration schema reads. An item key therefore
 * deletes by OMISSION, and the migration's assertions read it that way.
 *
 * The list is wider than a connection triple deliberately. An item carries an API token and a TLS-verification preference alongside its credentials, and a rebuild
 * that carried only the credentials would silently delete both.
 */
export const CONTROLLER_KEYS = [ "address", "name", "password", "tokens", "username", "verifyTls" ];

/* The legacy PER-CONTROLLER configuration properties, each paired with the feature option that supersedes it at controller scope. These cannot move on the strength
 * of the configuration alone: an option entry is addressed by the controller's MAC address, and a configuration file records only the address the plugin connects
 * to, so a controller has to actually answer before its settings have anywhere to land. The wiring probes for the MAC and hands in what it resolved; an item whose
 * controller stayed silent keeps its properties and gets another chance at the next open.
 */
const PER_CONTROLLER_SETTINGS = {

  mqttTopic: "Mqtt.Topic",
  mqttUrl: "Mqtt.Url"
};

/* The families whose per-member booleans one list stands for, each naming the members of the list against the boolean that was that member's own switch. A 1.x
 * configuration addresses those booleans by name and the served catalog declares none of them, so this table is what lets the framework's own grammar read such an
 * entry at all: each name is added back to a LEGACY catalog the composition reads through, and never to the catalog the page serves.
 *
 * Each member is a pair of the list's own value, which is what a composed entry stores, against the boolean that switched it. They are an ordered array because the
 * order is the order the list offers its members, and that is the order a composed entry has to read in.
 */
const RETIRED_FAMILIES = [

  {

    members: [ [ "DPS", "Hub.DPS" ], [ "REL", "Hub.REL" ], [ "REN", "Hub.REN" ], [ "REX", "Hub.REX" ], [ "SideDoorDPS", "Hub.SideDoor.DPS" ] ],
    option: "Hub.Sensors"
  },
  {

    members: [ [ "Doorbell", "Log.Doorbell" ], [ "DPS", "Log.DPS" ], [ "Lock", "Log.Lock" ], [ "REL", "Log.REL" ], [ "REN", "Log.REN" ], [ "REX", "Log.REX" ] ],
    option: "Log.Events"
  }
];

// The feature option a device's custom HomeKit name is stored under, at the device's own scope, which is the one scope the option declares and where the plugin
// reads it.
const DEVICE_NAME_OPTION = "Device.Name";

// The plain string identity fields an editor writes onto a controller item. Each one deletes by omission when the user leaves it empty, which is what makes clearing
// a field in the editor mean the same thing as never having filled it in. The tokens object and the TLS preference are written by arms of their own below, since
// neither is a string this presence test could read.
const IDENTITY_KEYS = [ "address", "password", "username" ];

/* Whether a controller item describes an identity the plugin can connect with, which is the browser-side statement of the plugin's own composeConnectIdentity rule
 * and is checked against it by this module's test suite.
 *
 * The rule reads in one order and that order is the whole of it: a complete credential pair is an identity, with or without a token beside it; half a pair describes
 * no way of authenticating and is rejected BEFORE the token is ever considered, so a username with no password is invalid even with a perfectly good token in the
 * same item; and a token on its own is an identity. An address is a separate requirement the caller asks about separately, exactly as the platform's own
 * configuration gate does.
 */
export const hasValidIdentity = (controller) => {

  const password = controller?.password;
  const token = controller?.tokens?.access;
  const username = controller?.username;

  if(username?.length && password?.length) {

    return true;
  }

  if(username?.length || password?.length) {

    return false;
  }

  return Boolean(token?.length);
};

// The headline for a controller the plugin could not reach, rendered on the connection card's result line and as the framework's error-view headline.
export const CONNECTION_FAILURE_HEADLINE = "Unable to connect to the UniFi Access controller.";

// The headline for a UI server answering in a shape it never writes, rendered on the card's result line and as the framework's error-view headline.
export const SERVER_FAILURE_HEADLINE = "The plugin's UI server did not answer as expected.";

// Why the UI server failed when nothing more specific is known: an answer in a shape it never writes, or a rejected probe request that carried no message of its own.
const SERVER_FAILURE_MESSAGE = "The plugin's UI server answered in an unrecognized shape.";

// What to do about a UI server answering in a shape it never writes, rendered beneath the headline above on the card and in the error view.
export const SERVER_FAILURE_GUIDANCE = "Reload this page. If it keeps happening, restart Homebridge and check its log for the reason.";

// The headline for a sidebar entry whose controller left the configuration, rendered as the framework's error-view headline.
const STALE_SELECTION_HEADLINE = "This controller is no longer in the plugin configuration.";

// Why a sidebar entry cannot be listed, rendered as the error view's detail beneath the headline above.
const STALE_SELECTION_MESSAGE = "Its entry left the configuration after the sidebar was built.";

// What to do about a sidebar entry whose controller left the configuration, rendered as the error view's guidance.
const STALE_SELECTION_GUIDANCE = "Refresh the controller list to take it off the sidebar.";

/* Read the UI server's device probe, which is the ONE place the server's kind-tagged response protocol is interpreted.
 *
 * The server answers a kind-tagged union rather than a device list the browser has to interpret, because its successful outcomes differ in what a user can do with
 * them rather than in what they look like. Each leads with the controller's own row: a credentialed connect fills it from the controller's information document and
 * follows it with the topology document's devices, while a token-only connect, which never reaches that document, fills it with the configured address and empty
 * values and follows it with the official API's adopted inventory. Telling them apart is what lets the page say what a local user's credentials would add - the
 * controller's own document, with its name, its uptime, and an Enterprise hub's ports - without ever reporting a working controller as broken.
 *
 * The verdict carries the device list, the outcome tag, and the failure text together, so each consumer reads the one field it needs without re-deriving the
 * outcome: the connection editor treats anything but a failure as a valid login, while the device view hands the list and the text straight to the framework. A
 * response in a shape the server never writes reads as a failure, because guessing at it is how a malformed answer becomes a silently empty page. A failure
 * verdict also carries the headline its surfaces render it under, and a guidance line only where each surface's own standing guidance would send the user after the
 * wrong thing.
 */
export const classifyProbeResponse = (response) => {

  switch(response?.kind) {

    /* Both successes carry a device list, so one arm validates the shape for each and the tag is carried through to tell the two apart downstream. Whether the
     * controller refused a token supplied beside the credentials is carried through as well, and an answer that does not state it reads as false rather than
     * undefined, so every surface that speaks for a success branches on a boolean.
     */
    case "connected":
    case "token-only":

      return Array.isArray(response.devices) ? { devices: response.devices, kind: response.kind, message: "", tokenRefused: response.tokenRefused === true } :
        { devices: [], guidance: SERVER_FAILURE_GUIDANCE, headline: SERVER_FAILURE_HEADLINE, kind: "error",
          message: "The plugin's UI server answered a connection without a device list." };

    case "error":

      return { devices: [], headline: CONNECTION_FAILURE_HEADLINE, kind: "error", message: (typeof response.message === "string") ? response.message : "" };

    default:

      return { devices: [], guidance: SERVER_FAILURE_GUIDANCE, headline: SERVER_FAILURE_HEADLINE, kind: "error", message: SERVER_FAILURE_MESSAGE };
  }
};

/* Read the detail a rejected probe request carries, which is the one place such a rejection is interpreted, so every surface that runs the connection check reads
 * it the same way.
 *
 * The bridge rejects with the plain object the host's UI server sends, which carries a message, and a thrown error carries one too, so the message is read off
 * whatever was thrown rather than off an error alone. A rejection that is itself a string is its own detail. Anything that leaves no non-empty string carries the
 * unrecognized-shape sentence instead, because rendering an object as text would show the user nothing they can act on.
 *
 * @param reason - What the request was rejected with.
 *
 * @returns The detail the connection check's failure shows beneath its sentence.
 */
export const readProbeRejection = (reason) => {

  const message = reason?.message;
  const detail = (typeof message === "string") ? message : ((typeof reason === "string") ? reason : "");

  return detail.length ? detail : SERVER_FAILURE_MESSAGE;
};

/* The verdict of a sidebar entry whose controller left the configuration after the sidebar was built. It is composed here beside the probe verdicts because it is
 * one: every device-list outcome the page hands the framework for a selected controller goes through the one result composition below, so the copy for this
 * failure lives with the copy for every other. Fresh per call, so no two results share a device array.
 */
export const staleSelectionVerdict = () => ({ devices: [], guidance: STALE_SELECTION_GUIDANCE, headline: STALE_SELECTION_HEADLINE, kind: "error",
  message: STALE_SELECTION_MESSAGE });

/* Map a probe verdict onto the device list and connection outcome the framework's own hook contract carries, with each outcome's own copy beside it. A success
 * carries its devices and an empty message, and a failure carries no devices, its reason, its headline, and its guidance where it has one. Only the members an
 * outcome carries are written, because an absent member is how the contract says the framework's own wording applies.
 *
 * No success needs a nothing-to-list notice: every device list a controller answers with opens with that controller's own row, whichever way it was reached, so
 * the shortest list a reachable controller can produce still carries a node to select and an options table to render against it.
 */
export const deviceListResult = (verdict) => {

  const result = { devices: verdict.devices, error: verdict.message };

  if(verdict.kind === "error") {

    result.headline = verdict.headline;

    if(verdict.guidance !== undefined) {

      result.guidance = verdict.guidance;
    }
  }

  return result;
};

/* Compose one controller item from a base item and the identity an editor is writing onto it. Every key the base holds that the identity does not write carries
 * through, which is what keeps a credential edit from discarding the item's name or a per-controller setting the migration has not retired yet. The identity writes
 * the identity fields, the tokens, and the TLS preference whole, so the base's own token and TLS preference survive an edit only as the editor carries them. Each
 * identity field the user left empty is deleted rather than stored as an empty string, so a cleared field reads exactly as an absent one everywhere the
 * configuration is consulted.
 *
 * The tokens and the TLS preference are written by arms of their own. Neither is a string, so the presence test the loop applies would read undefined for both and
 * delete them from every item an editor touched.
 *
 * The tokens object is composed fresh from the access token an editor carries rather than carried over by reference, and an editor carrying none writes no tokens
 * member at all. Never writing an empty object is what keeps a cleared token indistinguishable from one that was never entered: an absent member and an empty one
 * must read identically everywhere, so only one of those two shapes is ever written.
 *
 * TLS verification is written only when it is on. An absent property and a false one mean the same thing to the plugin, and carrying the false form would add a key
 * to every item the editor touches for no reading anything makes.
 */
const withIdentityApplied = (base, identity) => {

  const successor = { ...base };

  for(const key of IDENTITY_KEYS) {

    if(identity[key]?.length) {

      successor[key] = identity[key];

      continue;
    }

    delete successor[key];
  }

  const access = identity.tokens?.access;

  if(access?.length) {

    successor.tokens = { access };
  } else {

    delete successor.tokens;
  }

  if(identity.verifyTls === true) {

    successor.verifyTls = true;

    return successor;
  }

  delete successor.verifyTls;

  return successor;
};

// What a save says when the address it writes is one another configured controller already holds. It is stated once, here beside the rule that refuses such a
// save, and the page hands it to every surface that speaks the refusal.
export const CONTROLLER_LISTED_WARNING = "This controller is already listed.";

// The index of the item a save writes onto: the one whose address is exactly the address the save started from, or -1 for an add and for an original address no
// item holds. The composer and the early check find their target here alike, so they ask the rule about the same item.
const saveTarget = (items, originalAddress) => (originalAddress === undefined) ? -1 : items.findIndex((item) => item?.address === originalAddress);

/* Build the interpreters of the configured controller list over homebridge-plugin-utils' listed-address rule: its listing form, the form addresses are compared
 * in, and its check of whether a saved address is already listed at another position. Every interpreter here reads the list one entry per listed address, so each
 * one needs the rule, and handing the rule in is what keeps this module import-free while the page, its suites, and the plugin all read a controller's address
 * through the one rule. What counts as one address is the rule's to state; what this module states is which entry at an address is kept, and what a save may
 * write. None of these needs the served catalog, so a save's refusal never waits on a catalog read.
 *
 * Every lookup on the page stays exact, because a lookup asks which stored entry a key names and the stored string is that key. The refusal asks a different
 * question - whether a new entry would name a controller already listed - and the plugin uses only the first entry at an address, skipping every later one at
 * startup, so a listed address typed again in another spelling would write an entry the plugin never uses. An address the rule gives no form - absent, empty, or
 * not a string, any of which a hand edit can leave - never matches, so an empty field is left to the connection test's own sentence rather than read as a listed
 * address.
 *
 * @param injected.addressListedElsewhere - homebridge-plugin-utils' check of whether an address being saved is already listed at another position.
 * @param injected.addressListingForm     - homebridge-plugin-utils' listing form of an address, or null for a value that has none.
 *
 * @returns The interpreters of the configured controller list, each under the name the page calls it by.
 */
export const makeControllerList = ({ addressListedElsewhere, addressListingForm }) => {

  /* The configured controllers, one entry per listed address: the stored entries in their stored order, with every entry after the first at one listing form left
   * out, and an empty list when the configuration holds no list at all, so a caller never branches on what a hand edit left there. An entry that is not an object
   * is left out too, because every reader reads an entry's members, and an entry whose address has no form is never a repeat and is always kept.
   *
   * The first entry at an address is kept because it is the one the plugin uses: startup skips every later entry at that address. The page therefore reads,
   * edits, lists, and removes that same entry, and every write composed over this list persists the list as read, which is how a repeated entry leaves the
   * configuration file. The entries are the stored objects themselves rather than copies, so a writer carries each entry it does not name across untouched.
   */
  const controllers = (config) => {

    if(!Array.isArray(config?.controllers)) {

      return [];
    }

    const listed = new Set();

    return config.controllers.filter((item) => {

      if((typeof item !== "object") || (item === null)) {

        return false;
      }

      const form = addressListingForm(item.address);

      if(form === null) {

        return true;
      }

      if(listed.has(form)) {

        return false;
      }

      listed.add(form);

      return true;
    });
  };

  // The primary controller entry (the first), or undefined on a fresh configuration.
  const primaryController = (config) => controllers(config)[0];

  /* Whether the address a save writes onto the item at `index` is held by any other configured item, where an index of -1 names no target and the save appends.
   * This is the one question the save's composer, the first-run composer, and the page's early checks all ask of the rule, so none of them can disagree about
   * what counts as the same controller.
   *
   * The items are the configured controllers as the page reads them, one entry per listed address, so no position but the target's own holds the target's form,
   * and a save that writes its target's own address in any spelling is never refused.
   */
  const heldElsewhere = (items, index, address) => addressListedElsewhere({ address, addresses: items.map((item) => item.address), index });

  /* Compose the controllers array that writes one controller's identity, either onto the item it already has or as a new item at the end.
   *
   * The item the write lands on is found by the address the caller started from, not by the address being written, so an edit that changes a controller's
   * address replaces that controller rather than adding a second one beside it. An `originalAddress` that names no configured item - and the absent one an add
   * passes - appends instead, which is the whole of what distinguishes adding a controller from editing one.
   *
   * A save whose written address another item already holds is refused rather than composed, answering null, on the append and the replace alike. The composer
   * runs against the configuration as it stands at the write, so this is the refusal that decides, including for a save queued behind another that changed the
   * configuration after the page last read it.
   *
   * @param config - The platform configuration entry.
   * @param save   - The identity to write, and the address of the item it started from, absent for an add.
   *
   * @returns The controllers array to write, one entry per listed address, or null when the address is already listed and nothing is to be written.
   */
  const controllersWithSave = (config, { address, originalAddress, password, tokens, username, verifyTls }) => {

    const identity = { address, password, tokens, username, verifyTls };
    const items = controllers(config);
    const index = saveTarget(items, originalAddress);

    if(heldElsewhere(items, index, address)) {

      return null;
    }

    if(index === -1) {

      return [ ...items, withIdentityApplied({}, identity) ];
    }

    const next = [...items];

    next[index] = withIdentityApplied(items[index], identity);

    return next;
  };

  /* Whether a controller save would be refused because another configured controller already holds the address it writes, asked of the configuration the page
   * last received so a save can answer before its connection test. The composer asks the same rule again inside the write, against the configuration as it then
   * stands, and its answer is the one that decides. A stale configuration can make the answers differ - this one can refuse a save the composer would accept,
   * which the user retries, or pass one the composer then refuses - but it can never let a duplicate through.
   *
   * @param config - The platform configuration entry.
   * @param save   - The address the save writes, and the address of the item it started from, absent for an add.
   *
   * @returns True when another configured controller already holds the written address.
   */
  const controllerListedElsewhere = (config, { address, originalAddress }) => {

    const items = controllers(config);

    return heldElsewhere(items, saveTarget(items, originalAddress), address);
  };

  /* Whether the first-run save would be refused because a controller after the primary already holds the address it writes. The first-run save always writes
   * onto the primary, so the primary is the rule's target, and a first run that writes the primary's own address in any spelling is never refused, because the
   * page reads one entry per listed address and no later entry it reads holds the primary's form.
   *
   * @param config   - The platform configuration entry.
   * @param identity - The identity the first-run form would write, of which only the address is read.
   *
   * @returns True when another configured controller already holds the written address.
   */
  const primaryListedElsewhere = (config, { address }) => heldElsewhere(controllers(config), 0, address);

  /* Produce the patch that writes an identity onto the primary controller, preserving the additional controllers the configured list holds, one entry per listed
   * address, and the primary's other fields. This is the first-run save, and it composes nothing at all for an identity the plugin could not connect with: a
   * configuration written from an incomplete form would leave the user with a controller entry the platform's own gate skips and no first run to walk them back
   * through it.
   *
   * On a true first run controllers[0] is undefined; the successor is composed from the identity alone, so no separate initialization is needed.
   *
   * @param config   - The platform configuration entry.
   * @param identity - The identity to write onto the primary controller.
   *
   * @returns The `{ controllers }` patch, or null when the identity is not one the plugin can connect with, and null as well when a controller after the primary
   *          holds the address the identity writes, by the rule a controller save is refused under.
   */
  const withPrimaryIdentity = (config, identity) => {

    if(!identity?.address?.length || !hasValidIdentity(identity)) {

      return null;
    }

    const next = [...controllers(config)];

    if(heldElsewhere(next, 0, identity.address)) {

      return null;
    }

    next[0] = withIdentityApplied(next[0] ?? {}, identity);

    return { controllers: next };
  };

  return { controllerListedElsewhere, controllers, controllersWithSave, primaryController, primaryListedElsewhere, withPrimaryIdentity };
};

/* Build the configuration interpreters that need the served catalog: the legacy-settings migration, the controller save, the controller removal, the predicate
 * naming which controllers still have settings to migrate, and the device-row namer. Injecting the engine class, the catalog index, the catalog builder, the entry
 * enumerators, the list formatter, the identifier repair, and homebridge-plugin-utils' display-name rule is what keeps this module import-free and exercisable under
 * Node against the real engine, the real catalog, and the real rule, rather than against a stand-in that could drift from any of them. The configured controller
 * list's reader and its save composer are handed in as makeControllerList built them, so every interpreter here reads and writes the entry at each address the page
 * shows and the plugin uses.
 *
 * @param injected.FeatureOptions              - The feature-option engine class.
 * @param injected.buildCatalogIndex           - The framework's catalog builder, which the retired-family composition builds its legacy catalog with.
 * @param injected.catalog                     - The catalog index built from the served categories and options, which carries both alongside its derived indices.
 * @param injected.controllers                 - The configured controllers, one entry per listed address, as makeControllerList reads them.
 * @param injected.controllersWithSave         - The controllers array a save writes, or null for an address already listed, as makeControllerList composes it.
 * @param injected.displayedName               - homebridge-plugin-utils' display-name rule, which answers the custom name where one resolves and the fallback
 *                                               otherwise, as HomeKit carries it.
 * @param injected.enumerateConfiguredEntries  - The framework's own enumerator over the configured entries addressing one option.
 * @param injected.enumerateScopeEntries       - The framework's own enumerator over the configured entries reading at one scope identifier.
 * @param injected.formatValueList             - The framework's composition of a list option's stored form from its selected members.
 * @param injected.scopeSafeId                 - The framework's repair of an arbitrary string into a scope identifier.
 *
 * @returns The interpreters: the migration, the awaiting-migration predicate, the controller save, the controller removal, and the device-row namer the sidebar
 *          names its device links through.
 */
export const makeAccessConfig = ({ FeatureOptions, buildCatalogIndex, catalog, controllers, controllersWithSave, displayedName, enumerateConfiguredEntries,
  enumerateScopeEntries, formatValueList, scopeSafeId }) => {

  // A feature-option engine over the served catalog and the config's own entries. The array is handed in directly rather than copied: every engine transform this
  // module drives - the option set, the scope clear, the scope move - composes a fresh array and reassigns its own field, and where this module assigns the
  // engine's entries itself it hands over a fresh filtered array, so the array it was given is never written to.
  const engineFor = (config) => new FeatureOptions(catalog.categories, catalog.options, Array.isArray(config?.options) ? config.options : []);

  /* The served catalog's options with every retired boolean added back to the category its name begins with, each as the default-on boolean it was. This is what the
   * retired-family composition reads a 1.x entry through: the served catalog declares none of these names, so the framework's grammar would decline to parse such an
   * entry at all, and a name-matching read of the raw array would be this module re-implementing the storage format.
   */
  const legacyOptions = () => {

    const options = { ...catalog.options };

    for(const family of RETIRED_FAMILIES) {

      for(const [ , retired ] of family.members) {

        const separator = retired.indexOf(".");
        const category = retired.slice(0, separator);

        options[category] = [ ...(options[category] ?? []), { default: true, description: "", name: retired.slice(separator + 1) } ];
      }
    }

    return options;
  };

  /* The served catalog's own entry for an option name, or undefined when the catalog declares no such option. An entry with an empty name is its category's own
   * option, addressed by the bare category name exactly as the framework's expandOption composes it. Every question about one option's own declaration - its
   * default state and its registered value - resolves through this one walk, so no two readings of a declaration can disagree.
   */
  const catalogEntry = (option) => {

    for(const [ category, entries ] of Object.entries(catalog?.options ?? {})) {

      for(const entry of entries) {

        if((entry.name.length ? (category + "." + entry.name) : category) === option) {

          return entry;
        }
      }
    }

    return undefined;
  };

  // The value the catalog registers as an option's default, read off the served entry's own defaultValue field through the walk above. The engine's same-named
  // method answers a different question - the boolean enabled-state default - while its valueDefault reads this same declaration, rendered as a string.
  const registeredDefault = (option) => catalogEntry(option)?.defaultValue;

  // Whether an option is enabled by default, which is what decides whether its registered default is already the answer the user gets. A default-on value option
  // resolves to that default when nothing is configured; a default-off one resolves to nothing of its own, so its registered default is never the answer an
  // unconfigured read gets.
  const defaultsOn = (option) => catalogEntry(option)?.default === true;

  /* Whether a per-controller legacy value composes a controller-scoped entry. Configured-ness is asked through scope() rather than exists(), because the compose
   * target is a controller-scoped entry and ANY entry that already answers this controller's read outranks the property at runtime - the same expression the
   * plugin's own MQTT resolution consults, so this module's question and the runtime's stay the same question.
   *
   * A value byte-equal to the option's registered default composes nothing, but only for an option that is on by default: that is the only kind whose unconfigured
   * read already answers the registered default, so an entry restating it would manufacture configuration out of nothing. The MQTT topic prefix is such an
   * option, and reading the default off the catalog rather than naming it keeps that comparison honest if the plugin ever changes what it publishes under.
   */
  const composesScoped = ({ engine, mac, option, value }) => {

    if((typeof value !== "string") || !value.length || (engine.scope(option, undefined, mac) !== "none")) {

      return false;
    }

    return !defaultsOn(option) || (value !== registeredDefault(option));
  };

  /* Move a 1.x configuration's retired per-member booleans onto the lists that supersede them, writing each list through the served engine and dropping every raw
   * entry the retired names claim. Answers whether anything moved.
   *
   * A retired boolean was one member's own switch and the list is the whole family's, so a scope's list has to be composed from what EVERY member of that family
   * resolves to there rather than translated entry by entry. The composition reads through a legacy engine over the legacy catalog, which is the framework's own
   * grammar applied to names the served catalog does not declare, so a lower-cased spelling, a legacy dotted form, and a bare enable are each read exactly as the
   * 1.x runtime read them.
   *
   * A scope emits only where its composition differs from what it would inherit - the global scope against every member, a named scope against the global
   * composition - which is what keeps a configuration that has already been through this from composing anything at the next open, and keeps a 1.x file that merely
   * restates the defaults from gaining entries it never had.
   *
   * A device-scoped composition inherits from the GLOBAL scope and never from its controller's, because the configuration carries no topology: which controller a
   * device belongs to is unknowable without probing every one of them, and making every page open do that to serve a one-time move is a trade nobody would take.
   * The reading errs for a family carrying entries both at a controller's scope and at the scope of a device beneath it, whether or not the global scope carries
   * one: the device's composition passes over its controller's entries and reads the global answer in their place.
   *
   * @param engine            - The served engine every composed list is written through, and whose entries the retired names are dropped from.
   * @param configuredOptions - The raw configured-options array as the user wrote it, which is what the composition reads.
   *
   * @returns True when a list was composed or a retired entry dropped.
   */
  const composeRetiredFamilies = (engine, configuredOptions) => {

    // One options record serves both, so the index the entries are read through and the engine they are resolved against describe the same catalog by construction.
    const options = legacyOptions();
    const legacyCatalog = buildCatalogIndex(catalog.categories, options);
    const legacyEngine = new FeatureOptions(catalog.categories, options, configuredOptions);

    // Whether a raw entry addresses any retired name, asked through the legacy enumerator over that entry alone rather than by matching text, so every spelling the
    // grammar accepts is caught by the same reading that composed from it. The loop is how a generator is asked whether it yields anything: it answers true on the
    // first entry and false when there is none.
    const retired = (rawEntry) => RETIRED_FAMILIES.some((family) => family.members.some(([ , option ]) => {

      for(const _entry of enumerateConfiguredEntries({ catalog: legacyCatalog, configuredOptions: [rawEntry], option })) {

        return true;
      }

      return false;
    }));

    let composed = false;

    for(const family of RETIRED_FAMILIES) {

      const members = family.members.map(([member]) => member);
      const selectionAt = (scope) => family.members.filter(([ , option ]) => legacyEngine.test(option, scope || undefined)).map(([member]) => member);

      /* The global scope is always composed, because a retired entry there is what every named scope's composition is measured against. Its key in this set is the
       * empty string, which becomes no scope at all wherever it is handed to the engine. Every named scope is collected in lower case: the storage format matches a
       * scope identifier without regard to case, so every spelling of one scope composes once, and the composed entry is written in the folded spelling.
       */
      const scopes = new Set([""]);

      for(const [ , option ] of family.members) {

        for(const entry of enumerateConfiguredEntries({ catalog: legacyCatalog, configuredOptions, option })) {

          scopes.add(entry.id.toLowerCase());
        }
      }

      const globalSelection = selectionAt("");

      for(const scope of scopes) {

        const selection = scope.length ? selectionAt(scope) : globalSelection;
        const inherited = scope.length ? globalSelection : members;

        if((selection.length === inherited.length) && selection.every((member, index) => member === inherited[index])) {

          continue;
        }

        /* Every member selected stores the all-members form the catalog registers as this option's default, read off the entry rather than spelled here so the one
         * place that form is written stays the catalog. Anything narrower stores the members themselves.
         */
        const value = (selection.length === members.length) ? registeredDefault(family.option) : formatValueList(selection);

        engine.setOption({ enabled: true, id: scope || undefined, option: family.option, value });
        composed = true;
      }
    }

    const surviving = engine.configuredOptions.filter((rawEntry) => !retired(rawEntry));

    if(surviving.length !== engine.configuredOptions.length) {

      engine.configuredOptions = surviving;
      composed = true;
    }

    return composed;
  };

  // Whether a rebuilt successor carries exactly what the item it replaces carried. This decides whether the controllers array joins the patch at all, and it is what
  // makes the rewrite converge: once every item is already its own allowlisted shape, no successor differs and a later pass leaves the array alone.
  const unchanged = (item, successor) => {

    const keys = Object.keys(successor);

    return (Object.keys(item ?? {}).length === keys.length) && keys.every((key) => item[key] === successor[key]);
  };

  /* The scope identifier a configured address answers by, or null for an address there is no identity to compose from. A configured item's address is typed
   * unknown because a hand-edited configuration file can carry anything under that name, and the framework's repair throws on a value that is not a string - so
   * the string test runs first and an item with no usable address simply has no address identity. The address is read trimmed, because the plugin composes a
   * controller's identity from its trimmed address and the UI server stamps a token-only controller's row the same way, so the options of an entry padded by hand
   * are written, and moved by a save or by the migration, under the name the runtime reads. An address left empty by the trim names no identity either: the repair
   * answers an empty string empty, the engine reads an empty identifier as addressing nothing, and a scope move refuses one as its destination with a throw, so it
   * is answered null here rather than handed on. Every reader of that identity here asks through this one walk.
   */
  const addressIdentity = (address) => {

    const trimmed = (typeof address === "string") ? address.trim() : "";

    return trimmed.length ? scopeSafeId(trimmed) : null;
  };

  // The scope identifier a controller serial answers by, or null where the page learned none. A serial arrives in the decorated scope form the UI server stamped
  // the controller's row with, so it is read for presence and never repaired; an empty string is the absence a form field hands over, not a name.
  const serialIdentity = (serial) => (((typeof serial === "string") && serial.length) ? serial : null);

  return {

    /* The configured controllers whose per-controller settings still need a MAC address, each carried with the full identity and TLS preference a probe needs in
     * order to reach it. This is what lets the wiring probe exactly the controllers whose settings have somewhere left to go, and skip the network entirely once
     * every one of them has converged.
     *
     * An item is awaiting migration exactly when it carries a complete credential pair AND something that a MAC address would move: a legacy property, or at
     * least one option entry keyed by its address identity. A token-only item is out, because the controller information document a MAC comes from is never
     * served to a token, so such an item would be probed forever and resolve nothing. An item whose identity the plugin cannot connect with at all is out for the
     * same never-converges reason. An item carrying a token BESIDE a complete pair is in, because its credentials resolve a MAC exactly like any other item's -
     * excluding it on the mere presence of a token would strand a controller that was always resolvable. Every excluded item keeps its legacy properties, which
     * the plugin's own MQTT resolution still reads, and its address-keyed entries, which still resolve while the controller answers by that address.
     *
     * The entry probe runs only for an item whose address is a string, on the same reading the migration's own move takes: an item with no usable address has no
     * address identity and answers on its legacy property alone.
     *
     * A controllers field we cannot parse answers the empty array rather than throwing: the caller's next move is a network probe, and there is nothing here worth
     * probing for. An options field we cannot parse is read as carrying no entries, so an item is named on its legacy properties alone, although the migration
     * then declines the whole pass those probes serve.
     *
     * @param config - The platform configuration entry.
     *
     * @returns Each awaiting controller's identity and TLS preference.
     */
    controllersAwaitingMigration: (config) => {

      const configuredOptions = Array.isArray(config?.options) ? config.options : [];
      const properties = Object.keys(PER_CONTROLLER_SETTINGS);

      const hasAddressEntry = (item) => {

        const identity = addressIdentity(item?.address);

        if(identity === null) {

          return false;
        }

        for(const _entry of enumerateScopeEntries({ catalog, configuredOptions, id: identity })) {

          return true;
        }

        return false;
      };

      // The controllers as the page reads them, one entry per listed address, so a repeated address is probed for the entry the plugin uses and for no other.
      return controllers(config)
        .filter((item) => item?.username?.length && item?.password?.length &&
          (properties.some((property) => item?.[property] !== undefined) || hasAddressEntry(item)))
        .map((item) => ({ address: item.address, password: item.password, tokens: item.tokens, username: item.username, verifyTls: item.verifyTls }));
    },

    /* Name the device rows of one configuration as HomeKit carries each device's name: the custom name the user set where HomeKit can carry it, and the name the UI
     * server composed for the device otherwise, through homebridge-plugin-utils' display-name rule. One engine over the configuration names every row, so a page
     * naming a whole list pays for one catalog index rather than one per row. The custom name is read at the row's serialNumber, the decorated serial the framework
     * addresses the row by, which is the scope the plugin reads it at. A row carrying no composed name falls back to the name it carries.
     *
     * The rule is applied here rather than in the UI server's answer, so a custom name being edited shows on the page before anything is saved and without a round
     * trip, and the answer itself carries the composed name alone, so a row the page keeps never carries a custom name it would go on showing once that custom
     * name is cleared.
     *
     * @param config - The platform configuration entry, the edited one when the page names rows under an edit.
     *
     * @returns The namer: a device row in, the name the page shows for it out.
     */
    deviceNamer: (config) => {

      const engine = engineFor(config);

      return (row) => displayedName({ fallback: row?.homeKitName ?? row?.name ?? "", override: engine.value(DEVICE_NAME_OPTION, row?.serialNumber) });
    },

    /* Move the legacy per-controller configuration properties into their feature options, as a patch for the session to stage. This is transitional work with a
     * planned end: once a configuration has been all the way through it, there is nothing left to find and every later pass answers null.
     *
     * A per-controller property leaves by never being carried into the rebuilt item. Whether its value ALSO becomes an option entry follows the compose rules above,
     * and an option the user has already configured outranks the property either way - their own entry is their choice, and the plugin's reads already resolve it
     * ahead of the fallback. The property still leaves in that case, because two homes for one setting is the thing this migration exists to end.
     *
     * A property needs the controller's MAC address, which only a controller that answered this pass can supply, so an item whose address is absent from the map
     * keeps its per-controller keys unchanged and converges at a later open. Everything composes through ONE engine and lands in ONE options array, because each engine
     * answers `configuredOptions` as its own complete snapshot: two writers would each produce a whole array and the shallow-merge commit would keep only the last
     * of them, silently discarding everything the other one composed.
     *
     * Any top-level array field the migration reads declines the whole pass when it is present but not an array: a `controllers` or an `options` field in that
     * shape is one we cannot parse, and we do not guess at it. Absent is not the same thing and is entirely valid.
     *
     * An entry written while the controller answered by its address identity is the same setting a credentialed controller keys by its serial, so it moves onto
     * the MAC through the engine's own scope move before the property step runs. That order is the rule that an option the user configured outranks the property,
     * stated for an entry made under the controller's earlier identity: the moved entry is already in place when the property asks whether it has anywhere to
     * land, so the property composes only where no entry speaks. The engine's own rule settles a collision the other way round - an option the user already keyed
     * by the MAC keeps its place and the address entry is forgotten - because the settings built against the identity in use are the ones they are looking at.
     *
     * The retired families move first, because they need no MAC address and nothing else in the pass reads them. A retired boolean was one member's own switch and
     * the list that supersedes it is the whole family's, so each scope's list is composed from what every member of that family resolves to there, and a scope
     * emits a list only where that composition changes what it would otherwise inherit. A configuration already carrying its lists therefore finds nothing here.
     *
     * @param config       - The platform configuration entry.
     * @param macByAddress - The MAC address resolved for each controller address that answered a probe this pass.
     *
     * @returns The patch to commit, or null when there is nothing to do.
     */
    migrate: (config, macByAddress) => {

      if(!config || ((config.controllers !== undefined) && !Array.isArray(config.controllers)) ||
        ((config.options !== undefined) && !Array.isArray(config.options))) {

        return null;
      }

      const engine = engineFor(config);
      const patch = {};
      const successors = [];

      // The composition reads the entries as the user wrote them, so it is handed the raw array rather than whatever the engine holds once this pass starts writing.
      let composed = composeRetiredFamilies(engine, Array.isArray(config.options) ? config.options : []);
      let rewritten = false;

      /* The items are the controllers as the page reads them, one entry per listed address, so at a repeated address a pass reads, composes, and carries forward the
       * entry the plugin uses and no other, and a rewrite writes the list without the later entries. A pass with nothing to migrate writes nothing, so a repeated
       * entry alone never causes a write.
       */
      for(const item of controllers(config)) {

        const mac = macByAddress?.get(item?.address);
        const successor = {};
        const identity = addressIdentity(item?.address);

        for(const key of CONTROLLER_KEYS) {

          if(item?.[key] !== undefined) {

            successor[key] = item[key];
          }
        }

        // The move runs ahead of the property step, and the flag is set rather than folded through a logical assignment: folding would skip the move entirely
        // once an earlier item had composed, leaving the second controller's entries stranded under an address nothing resolves.
        if((identity !== null) && mac && engine.moveScope({ from: identity, to: mac })) {

          composed = true;
        }

        for(const [ property, option ] of Object.entries(PER_CONTROLLER_SETTINGS)) {

          const value = item?.[property];

          if(value === undefined) {

            continue;
          }

          // With no MAC address there is nowhere for this setting to land, so it stays exactly where it is rather than being dropped on the floor.
          if(!mac) {

            successor[property] = value;

            continue;
          }

          if(composesScoped({ engine, mac, option, value })) {

            engine.setOption({ enabled: true, id: mac, option, value });
            composed = true;
          }
        }

        successors.push(successor);
        rewritten ||= !unchanged(item, successor);
      }

      if(composed) {

        patch.options = engine.configuredOptions;
      }

      if(rewritten) {

        patch.controllers = successors;
      }

      return Object.keys(patch).length ? patch : null;
    },

    /* Produce the patch that removes one controller, with the settings sweep the user chose. The removal composes over the controllers as the page reads them, one
     * entry per listed address, so the entry stored at exactly the removed address leaves, and every later entry repeating its address in any spelling leaves with
     * it, since the list it writes never carried them.
     *
     * The two halves are deliberately separable. Dropping the item is what removal means and always happens; stripping the entries is the user's own follow-on
     * choice, because the settings they configured for those devices are worth keeping when a controller is being re-added under a new address, and worth
     * deleting when it is gone for good. An empty sweep set therefore carries no options array at all, which leaves every configured entry exactly where it was.
     *
     * The engine's scope clear is the one answer to which entries address an identity - it folds case and reads every spelling the resolver reads, the bare
     * enable, the canonical value form, and the legacy dot form alike - so the plugin runs it once per swept identity rather than deciding for itself what an
     * entry addresses. The survivors come back in the engine's canonical spelling, exactly as a save through the engine already leaves them.
     *
     * @param config  - The platform configuration entry.
     * @param removal - The address of the controller to drop, and the scope identities whose entries to strip with it: the decorated serials the UI server
     *                  stamped on the controller's row and on every device it listed.
     *
     * @returns The patch for the session's commit to merge onto the platform entry.
     */
    withControllerRemoved: (config, { address, macs = [] }) => {

      const remaining = controllers(config).filter((item) => item?.address !== address);

      if(!macs.length) {

        return { controllers: remaining };
      }

      const engine = engineFor(config);

      for(const mac of macs) {

        engine.clearScope({ id: String(mac) });
      }

      return { controllers: remaining, options: engine.configuredOptions };
    },

    /* Produce the patch that writes one controller's identity, carrying its feature options onto the name the written item answers by.
     *
     * A controller answers by one name at a time, and the plugin's own controllerIdentity is where that rule lives: the serial of a controller whose credentials
     * have read its own console document, and the configured address in the scope form otherwise. The UI server stamps a controller's row with the same two
     * spellings, which is where the page reads a serial from. Every entry the user builds for a controller is keyed by the name it answered by at the time.
     *
     * A save is the one place all three changes of that name happen - the address is edited, a credential pair is added, a credential pair is cleared - and the
     * one moment the outgoing name is in hand, since a pair that has just been cleared leaves no source on the page or the UI server that knows the serial it
     * answered by. So the entries follow here rather than waiting for the next page open.
     *
     * Onto the written item's name move the entries keyed by the address identity the item carried, which the migration would otherwise carry at the next open,
     * and, only where the written item answers by no serial of its own, the entries keyed by the serial it answered by before. The serial's entries move first,
     * because between two names moving onto a third the one that arrives first is the one the destination keeps, and the destination's own entries outrank both -
     * the engine's rule, read as the migration reads it: the entries under the name the controller will answer by are the ones the page shows.
     *
     * A written item that answers by a serial of its own and carried a different one names different hardware, whose entries stay where they are exactly as a
     * removal leaves them unless the sweep is asked for. A serial the page never learned names nothing to move from, so those entries wait for the migration,
     * exactly as an address edited by hand in the configuration file is outside this rule - the generated MQTT document says so where it names the token-only
     * topic form.
     *
     * The move runs through the engine's own scope verb, the single statement of what addresses a scope, and the options array joins the patch only when that
     * verb actually moved something.
     *
     * The configuration handed in is read and never edited: the engine composes a fresh array for every transform it makes, which is the composer's own term the
     * page's coordinated write states, since the page's store holds that options array by reference.
     *
     * @param config     - The platform configuration entry.
     * @param controller - The identity to write, the address of the item to write it onto, the serial that item's controller answered by when the page last
     *                     reached it, and the serial this save's own validation answered.
     *
     * @returns The patch for the session's commit to merge onto the platform entry, or null when another configured controller already holds the address this
     *          save writes, whether the save appends or moves its item onto it; nothing is composed.
     */
    withControllerSaved: (config, controller) => {

      const items = controllersWithSave(config, controller);

      if(items === null) {

        return null;
      }

      const patch = { controllers: items };
      const serial = serialIdentity(controller.serial);
      const to = serial ?? addressIdentity(controller.address);

      /* The names to carry entries from: the serial the item answered by, only where the written item answers by none of its own, and first so that where both
       * names carry an entry for one option and neither is the destination, the serial's arrives first and the address's is the one forgotten; then the address
       * identity the item carried. Where the destination itself already carries an entry for an option, the engine keeps the destination's and forgets the moved
       * one, so a cleared pair leaves an address-keyed entry in place over the serial's: the entries under the name the controller will answer by are the ones
       * the page shows, the same reading the migration takes in the other direction. A name the written item keeps answering by is left out, and so is one that
       * is absent - an add carries no original address, and a hand-edited value that is not a string names no identity.
       */
      const from = [ (serial === null) ? serialIdentity(controller.originalSerial) : null, addressIdentity(controller.originalAddress) ]
        .filter((name) => (name !== null) && (name !== to));

      if((to === null) || !from.length) {

        return patch;
      }

      const engine = engineFor(config);
      let moved = false;

      // Each move runs on its own rather than folded through a logical assignment, which would skip every move after the first one that changed something.
      for(const name of from) {

        if(engine.moveScope({ from: name, to })) {

          moved = true;
        }
      }

      if(moved) {

        patch.options = engine.configuredOptions;
      }

      return patch;
    }
  };
};
