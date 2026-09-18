/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-config.mjs: Pure interpreters over the injected Access platform configuration.
 */
"use strict";

/* The single home for our plugin-config shape. Every function here is a pure interpreter of the primary platform-config entry the webUI framework injects into our
 * hooks - no I/O, no global reach. The framework owns reading and writing the persisted config through its session; this module owns the Access-specific knowledge
 * of what a controller is, what counts as an identity it can connect with, and what the UI server's probe answered. Keeping that knowledge in one place means a
 * config-shape change is a single edit, and it keeps every hook in ui.mjs a declarative one-liner over these helpers.
 *
 * Two settings substrates meet here. A feature option is where a setting lives, and a set of per-controller configuration properties are a second home the plugin
 * honors so that a configuration nobody has opened the webUI on keeps working. Reconciling the two is the migration's whole job: it moves each property's value into
 * the option that supersedes it and rebuilds the item without it. The module takes no imports at all - the engine class, the served catalog index, the scope
 * enumerator, and the identifier repair are handed in - so the whole of it is exercisable under node against the real engine and the real catalog, with no network
 * and no DOM.
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

// The plain string identity fields an editor writes onto a controller item. Each one deletes by omission when the user leaves it empty, which is what makes clearing
// a field in the editor mean the same thing as never having filled it in. The tokens object and the TLS preference are written by arms of their own below, since
// neither is a string this presence test could read.
const IDENTITY_KEYS = [ "address", "password", "username" ];

// The configured controllers, normalized so callers never branch on undefined. On a fresh configuration the controllers array is absent; this yields an empty array.
export const controllers = (config) => (Array.isArray(config?.controllers) ? config.controllers : []);

// The primary controller entry (the first), or undefined on a fresh configuration.
export const primaryController = (config) => controllers(config)[0];

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

// What to do about a UI server answering in a shape it never writes, rendered beneath the headline above on the card and in the error view.
export const SERVER_FAILURE_GUIDANCE = "Reload this page. If it keeps happening, restart Homebridge and check its log for the reason.";

// The headline for a sidebar entry whose controller left the configuration, rendered as the framework's error-view headline.
const STALE_SELECTION_HEADLINE = "This controller is no longer in the plugin configuration.";

// Why a sidebar entry cannot be listed, rendered as the error view's detail beneath the headline above.
const STALE_SELECTION_MESSAGE = "Its entry left the configuration after the sidebar was built.";

// What to do about a sidebar entry whose controller left the configuration, rendered as the error view's guidance.
const STALE_SELECTION_GUIDANCE = "Refresh the controller list to take it off the sidebar.";

/* Read the UI server's device probe, which is the ONE place the three-state response protocol is interpreted.
 *
 * The server answers a kind-tagged union rather than a device list the browser has to interpret, because the two successful outcomes differ in what a user can do
 * with them rather than in what they look like. Both list devices: a credentialed connect reads the topology document and leads with the controller itself, while a
 * token-only connect reads the official API's adopted inventory and has no console identity to lead with. Telling them apart is what lets the page explain that
 * door-level accessories still need credentials, without ever reporting a working controller as broken.
 *
 * The verdict carries the device list, the outcome tag, and the failure text together, so each consumer reads the one field it needs without re-deriving the
 * outcome: the connection editor treats anything but a failure as a valid login, while the device view hands the list and the text straight to the framework. A
 * response in a shape the server never writes reads as a failure, because guessing at it is how a malformed answer becomes a silently empty page. A failure
 * verdict also carries the headline its surfaces render it under, and a guidance line only where each surface's own standing guidance would send the user after the
 * wrong thing.
 */
export const classifyProbeResponse = (response) => {

  switch(response?.kind) {

    // Both successes carry a device list, so one arm validates the shape for each and the tag is carried through to tell the two apart downstream.
    case "connected":
    case "token-only":

      return Array.isArray(response.devices) ? { devices: response.devices, kind: response.kind, message: "" } :
        { devices: [], guidance: SERVER_FAILURE_GUIDANCE, headline: SERVER_FAILURE_HEADLINE, kind: "error",
          message: "The plugin's UI server answered a connection without a device list." };

    case "error":

      return { devices: [], headline: CONNECTION_FAILURE_HEADLINE, kind: "error", message: (typeof response.message === "string") ? response.message : "" };

    default:

      return { devices: [], guidance: SERVER_FAILURE_GUIDANCE, headline: SERVER_FAILURE_HEADLINE, kind: "error",
        message: "The plugin's UI server answered in an unrecognized shape." };
  }
};

/* The verdict of a sidebar entry whose controller left the configuration after the sidebar was built. It is composed here beside the probe verdicts because it is
 * one: every device-list outcome the page hands the framework goes through the one result composition below, so the copy for this failure lives with the copy for
 * every other. Fresh per call, so no two results share a device array.
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

/* Compose one controller item from a base item and the identity an editor is writing onto it. Every key the base holds carries through, which is what keeps a
 * credential edit from discarding a token, a TLS preference, or a per-controller setting the migration has not retired yet. Each identity field the user left empty
 * is deleted rather than stored as an empty string, so a cleared field reads exactly as an absent one everywhere the configuration is consulted.
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

/* Compose the controllers array that writes one controller's identity, either onto the item it already has or as a new item at the end.
 *
 * The item the write lands on is found by the address the caller started from, not by the address being written, so an edit that changes a controller's address
 * replaces that controller rather than adding a second one beside it. An `originalAddress` that names no configured item - and the absent one an add passes -
 * appends instead, which is the whole of what distinguishes adding a controller from editing one.
 */
const controllersWithSave = (config, { address, originalAddress, password, tokens, username, verifyTls }) => {

  const identity = { address, password, tokens, username, verifyTls };
  const items = controllers(config);
  const index = (originalAddress === undefined) ? -1 : items.findIndex((item) => item?.address === originalAddress);

  if(index === -1) {

    return [ ...items, withIdentityApplied({}, identity) ];
  }

  const next = [...items];

  next[index] = withIdentityApplied(items[index], identity);

  return next;
};

/* Produce the patch that writes an identity onto the primary controller, preserving any additional controllers and the primary's other fields. This is the first-run
 * save, and it composes nothing at all for an identity the plugin could not connect with: a configuration written from an incomplete form would leave the user with
 * a controller entry the platform's own gate skips and no first run to walk them back through it.
 *
 * On a true first run controllers[0] is undefined; the successor is composed from the identity alone, so no separate initialization is needed.
 *
 * @param config   - The platform configuration entry.
 * @param identity - The identity to write onto the primary controller.
 *
 * @returns The `{ controllers }` patch, or null when the identity is not one the plugin can connect with.
 */
export const withPrimaryIdentity = (config, identity) => {

  if(!identity?.address?.length || !hasValidIdentity(identity)) {

    return null;
  }

  const next = [...controllers(config)];

  next[0] = withIdentityApplied(next[0] ?? {}, identity);

  return { controllers: next };
};

/* Build the configuration interpreters that need the served catalog: the legacy-settings migration, the controller save, the controller removal, and the predicate
 * naming which controllers still have settings to migrate. Injecting the engine class, the catalog index, the scope enumerator, and the identifier repair is what
 * keeps this module import-free and exercisable under node against the real engine and the real catalog, rather than against a stand-in that could drift from either.
 *
 * @param injected.FeatureOptions        - The feature-option engine class.
 * @param injected.catalog               - The catalog index built from the served categories and options, which carries both alongside its derived indices.
 * @param injected.enumerateScopeEntries - The framework's own enumerator over the configured entries reading at one scope identifier.
 * @param injected.scopeSafeId           - The framework's repair of an arbitrary string into a scope identifier.
 *
 * @returns The interpreters: the migration, the awaiting-migration predicate, the controller save, and the controller removal.
 */
export const makeAccessConfig = ({ FeatureOptions, catalog, enumerateScopeEntries, scopeSafeId }) => {

  // A feature-option engine over the served catalog and the config's own entries. The array is handed in directly rather than copied: the engine's set-option path is
  // a pure transform that composes a fresh array and reassigns its own field, so the array it was given is never written to.
  const engineFor = (config) => new FeatureOptions(catalog.categories, catalog.options, Array.isArray(config?.options) ? config.options : []);

  /* The served catalog's own entry for an option name, or undefined when the catalog declares no such option. Every question the migration asks of the catalog
   * resolves through this one walk, so no two readings of it can disagree.
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

  // The value the catalog registers as an option's default, read from the served entry's own defaultValue field. The engine exposes a same-named method that answers
  // a different question - the boolean enabled-state default - so this reads the catalog data instead.
  const registeredDefault = (option) => catalogEntry(option)?.defaultValue;

  // Whether an option is enabled by default, which is what decides whether its registered default is already the answer the user gets. A default-on value option
  // resolves to that default when nothing is configured; a default-off one resolves to nothing at all, and the plugin falls back to a constant of its own.
  const defaultsOn = (option) => catalogEntry(option)?.default === true;

  /* Whether a per-controller legacy value composes a controller-scoped entry. Configured-ness is asked through scope() rather than exists(), because the compose
   * target is a controller-scoped entry and ANY entry that already answers this controller's read outranks the property at runtime - the same expression the
   * plugin's own MQTT resolution consults, so this module's question and the runtime's stay the same question.
   *
   * A value byte-equal to the option's registered default composes nothing, but only for an option that is on by default: that is the only kind whose unconfigured
   * read already answers the registered default, so an entry restating it would manufacture configuration out of nothing. The MQTT topic prefix is the one such
   * option here, and reading the default off the catalog rather than naming it keeps that comparison honest if the plugin ever changes what it publishes under.
   */
  const composesScoped = ({ engine, mac, option, value }) => {

    if((typeof value !== "string") || !value.length || (engine.scope(option, undefined, mac) !== "none")) {

      return false;
    }

    return !defaultsOn(option) || (value !== registeredDefault(option));
  };

  // Whether a rebuilt successor carries exactly what the item it replaces carried. This decides whether the controllers array joins the patch at all, and it is what
  // makes the rewrite converge: once every item is already its own allowlisted shape, no successor differs and a later pass leaves the array alone.
  const unchanged = (item, successor) => {

    const keys = Object.keys(successor);

    return (Object.keys(item ?? {}).length === keys.length) && keys.every((key) => item[key] === successor[key]);
  };

  /* The scope identifier a configured address answers by, or null for an address there is no identity to compose from. A configured item's address is typed
   * unknown because a hand-edited configuration file can carry anything under that name, and the framework's repair throws on a value that is not a string - so
   * the string test runs first and an item with no usable address simply has no address identity. Every reader of that identity here asks through this one walk.
   */
  const addressIdentity = (address) => ((typeof address === "string") ? scopeSafeId(address) : null);

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
     * A configuration we cannot parse answers the empty array rather than throwing, on the same terms the migration declines one: the caller's next move is a
     * network probe, and there is nothing here worth probing for.
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

      return controllers(config)
        .filter((item) => item?.username?.length && item?.password?.length &&
          (properties.some((property) => item?.[property] !== undefined) || hasAddressEntry(item)))
        .map((item) => ({ address: item.address, password: item.password, tokens: item.tokens, username: item.username, verifyTls: item.verifyTls }));
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

      let composed = false;
      let rewritten = false;

      for(const item of config.controllers ?? []) {

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

    /* Produce the patch that removes one controller, with the settings sweep the user chose.
     *
     * The two halves are deliberately separable. Dropping the item is what removal means and always happens; stripping the entries is the user's own follow-on
     * choice, because the settings they configured for those devices are worth keeping when a controller is being re-added under a new address, and worth
     * deleting when it is gone for good. An empty MAC set therefore carries no options array at all, which leaves every configured entry exactly where it was.
     *
     * The engine's scope clear is the one answer to which entries address an identity - it folds case and reads every spelling the resolver reads, the bare
     * enable, the canonical value form, and the legacy dot form alike - so the plugin runs it once per swept identity rather than deciding for itself what an
     * entry addresses. The survivors come back in the engine's canonical spelling, exactly as a save through the engine already leaves them.
     *
     * @param config  - The platform configuration entry.
     * @param removal - The address of the controller to drop, and the MAC addresses whose entries to strip with it.
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

    /* Produce the patch that writes one controller's identity, carrying its feature options across when the address itself changed.
     *
     * The connection editor is the one place a controller's address is edited, so it is the one place those settings can follow it. A controller reached with an
     * API token alone is addressed by its configured address, so the entries the user built for it are keyed by that address and would be stranded under a name
     * nothing resolves the moment the address moves. The move runs through the engine's own scope verb, the single statement of what addresses a scope, and the
     * options array joins the patch only when that verb actually moved something - a credentialed controller has no entry under its address, so the rule runs for
     * every changed address and costs one reference comparison for the controllers that carry nothing.
     *
     * An address edited by hand in the configuration file is outside this rule, and the generated MQTT document says so where it names the token-only topic form.
     *
     * The configuration handed in is read and never edited: the engine composes a fresh array for every transform it makes, which is the composer's own term the
     * page's coordinated write states, since the page's store holds that options array by reference.
     *
     * @param config     - The platform configuration entry.
     * @param controller - The identity to write, and the address of the item to write it onto.
     *
     * @returns The patch for the session's commit to merge onto the platform entry.
     */
    withControllerSaved: (config, controller) => {

      const patch = { controllers: controllersWithSave(config, controller) };
      const from = addressIdentity(controller.originalAddress);
      const to = addressIdentity(controller.address);

      /* An add names no address to move from, and a hand-edited value that is not a string names no identity at all - neither has anything to carry across. The
       * unchanged-address test beside them is a cost short-circuit rather than a correctness one: the engine refuses a move onto the same scope on its own and
       * answers false for it, so what this saves is building an engine over the whole options array on every save that only edited a credential.
       */
      if((from === null) || (to === null) || (from === to)) {

        return patch;
      }

      const engine = engineFor(config);

      if(engine.moveScope({ from, to })) {

        patch.options = engine.configuredOptions;
      }

      return patch;
    }
  };
};
