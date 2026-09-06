/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * policy.ts: Pure decision logic for the Access plugin.
 *
 * This module is the home for the plugin's pure decisions - every rule that is a function of its inputs alone - separated from the composition root and the device
 * classes that act on them.
 *
 * They live here, in a dependency-light leaf, rather than inside the composition root, for the same reason the unifi-access library keeps its reducer apart from
 * its client: a decision separated from the effect it drives is independently testable, and the test is the proof the separation is real. AccessController
 * transitively imports the entire device and accessory graph; a five-line set diff should never have to stand that up to be exercised.
 *
 * What this module is allowed to import is deliberately narrow, so it loads and tests in isolation: the library predicates and error type it branches on, the
 * shared constants it reads, pure builtins - the address classifier and the WHATWG URL parser, which the endpoint composition and the path match branch on - and
 * the library's own published vocabulary, which is read through rather than restated anywhere here.
 */
import { ACCESS_AUTHENTICATION_TYPES, ACCESS_DOORBELL_REASON_CODES, AccessAuthError, isEnterpriseHubRecord, isHub, isReader, normalizeActorType,
  normalizeMacAddress, selectAccessPoints } from "unifi-access";
import { ACCESS_CONTROLLER_AUTH_FAILURE_LIMIT, ACCESS_WEBHOOK_PATH_PREFIX } from "./settings.ts";
import type { AccessActorType, AccessDoorStateEntry, AccessLockRule, AccessOfficialAccessMethodValue, AccessOfficialAccessMethods,
  AccessOfficialAccessMethodsUpdate, AccessOfficialDeviceSettingsUpdate, AccessOfficialUser, AccessOfficialWebhookEndpoint, AccessOfficialWebhookEndpointWrite,
  AccessState, AccessStateDevice, AccessStateDoor, AccessWebhookDelivery, AccessWebhookDoorUnlockObject, ConnectIdentity } from "unifi-access";
import type { FeatureOptionChoice, Nullable } from "homebridge-plugin-utils";
import type { ACCESS_WEBHOOK_EVENTS } from "./settings.ts";
import type { AccessControllerTokens } from "./options.ts";
import { AccessReservedNames } from "./types.ts";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

// The device type the controller reports for an Enterprise Access Hub, and the type whose per-port records carry a source_id that participates in accessory identity.
const ENTERPRISE_HUB_DEVICE_TYPE = "UAH-Ent";

// The unlock delivery this plugin consumes. The name comes from the settings vocabulary rather than a retyped literal, so the payload type follows the event name
// the registration asks for.
type AccessUnlockDelivery = AccessWebhookDelivery<typeof ACCESS_WEBHOOK_EVENTS.doorUnlock, AccessWebhookDoorUnlockObject>;

/* Which controller a cached accessory belongs to:
 *
 *   - `current`: this controller, keyed by the identity it answers by now.
 *   - `foreign`: not this controller's, whether it names another controller or names nobody at all.
 *   - `prior`: this controller, keyed by the identity it answered by before it learned its MAC address.
 */
export type AccessAccessoryOwnership = "current" | "foreign" | "prior";

/* The controller's lifecycle phase. The single source of truth for what this controller is doing right now.
 *
 *   - `connecting`: initial setup. Connection errors still surface to the user, since a failure here is something they need to see.
 *   - `running`: connected and in steady-state operation.
 *   - `shuttingDown`: terminal. The plugin or the host process is going away, and no recovery is expected.
 *
 * Access has no plugin-induced reboot domain, so there is no `rebooting` arm. Transitions are owned by the controller's `transition()` chokepoint, and derived
 * predicates project from the phase so that phase remains the lone mutable axis.
 */
export type AccessControllerPhase = "connecting" | "running" | "shuttingDown";

/* The result of composing a connect identity from configuration. Either an identity the client can connect with, or the complete-sentence reason the configuration
 * does not describe one. The never-typed complements are what let a caller narrow on either member and reach the other without a cast, mirroring the library's own
 * ConnectIdentity shape.
 */
export type AccessIdentityResult = { error?: never; identity: ConnectIdentity } | { error: string; identity?: never };

/* What one controller's login settled about its own identity, which is the evidence a cross-controller decision reads:
 *
 *   - `disabled`: it connected and the user has turned it off in HomeKit, so its identity is authoritative and it serves no membership.
 *   - `reporting`: it connected and serves the membership its client projects.
 *   - `unavailable`: it never learned an authoritative identity, so it can say nothing about which accessories are its own.
 */
export type AccessLoginOutcome = "disabled" | "reporting" | "unavailable";

/* What a lock command should carry. A discriminated union rather than a nullable rule, so a caller cannot reach for a rule in a case that produced none:
 *
 *   - `refuse`: nothing can relock this door, because no rule governs it in the first place.
 *   - `unlock`: the plain momentary unlock, which relocks on the door's own default.
 *   - `rule`: the temporary locking rule to establish.
 */
export type LockCommandDecision = { kind: "refuse" } | { kind: "rule"; rule: AccessLockRule } | { kind: "unlock" };

/* What to do about this controller's webhook registration, given what the controller already holds at our path:
 *
 *   - `create`: nothing is registered at our path, so one must be minted.
 *   - `reuse`: a registration already matches what we want in every respect, secret included, so it is taken as it stands.
 *   - `update`: a registration is at our path but describes something else - another host, another name, another event set - so it is rewritten in place.
 *
 * Every case carries the further registrations found at the same path. Those accumulate when an address changes without a clean shutdown in between, and deleting
 * them at the reconcile is what keeps one path from collecting a pile of records nothing will ever deliver to.
 */
export type WebhookRegistrationPlan = { endpoint?: never; kind: "create"; stale: readonly AccessOfficialWebhookEndpoint[] } |
  { endpoint: AccessOfficialWebhookEndpoint; kind: "reuse"; stale: readonly AccessOfficialWebhookEndpoint[] } |
  { endpoint: AccessOfficialWebhookEndpoint; kind: "update"; stale: readonly AccessOfficialWebhookEndpoint[] };

/* Who opened a door and how, as one unlock delivery reports it.
 *
 * The nullable members are the ones the wire carries as an empty string when it has nothing to say. Reading empty as absent is this plugin's own presentation
 * rule rather than the library's: the library carries the wire's values verbatim by its documented stance, and deciding that a blank policy name means no policy
 * is a judgment about how to show it to a person.
 */
export interface AccessUnlockAttribution {

  actor: Nullable<string>;
  actorType: Nullable<AccessActorType>;
  method: string;
  policy: Nullable<string>;
  reader: Nullable<string>;
  result: string;
  time: string;
}

/**
 * Whether a lifecycle phase change is legal. Two changes are refused: a same-phase change, and any change out of `shuttingDown`. That phase is one-way because
 * entering it aborts the terminal shutdown signal and tears the whole observe tree down, so a late-resolving connect or any other deferred wake that tries to move
 * the phase onward is rejected here rather than at each call site. Entering `shuttingDown` from any other phase stays legal.
 *
 * An options object because both arguments share the phase type and a positional swap would silently invert the predicate.
 *
 * @param options - The phase being left and the phase being entered.
 *
 * @returns `true` when the change is legal.
 */
export function canTransition(options: { from: AccessControllerPhase; to: AccessControllerPhase }): boolean {

  const { from, to } = options;

  return (from !== to) && (from !== "shuttingDown");
}

/**
 * The startup-resilient connect retry policy, as a pure stateful predicate factory. Authentication faults get a small consecutive budget so a controller still
 * sorting out its own auth state recovers, but genuinely-wrong credentials fail fast rather than looping forever. Any non-auth fault - network, transient - resets
 * the budget, so a slow-to-appear controller is retried without bound. A pure factory, so the budget logic is testable without standing up a client.
 *
 * @param limit - The consecutive-auth-failure ceiling.
 *
 * @returns A `shouldRetry` predicate suitable for the retry options; it closes over the running consecutive-auth count.
 */
export function createConnectRetryPolicy(limit = ACCESS_CONTROLLER_AUTH_FAILURE_LIMIT): { shouldRetry: (error: unknown) => boolean } {

  let consecutiveAuth = 0;

  return {

    shouldRetry: (error: unknown): boolean => {

      if(error instanceof AccessAuthError) {

        return ++consecutiveAuth < limit;
      }

      consecutiveAuth = 0;

      return true;
    }
  };
}

/**
 * Compose a connect identity from the configured credentials and token, or explain why the configuration describes none. Credentials reach the Access application's
 * own endpoints and are what the device topology comes from; a token reaches the published API; supplying both gives a client everything.
 *
 * The platform's configuration gate and the controller's own constructor gate both consume this one function, so what counts as a valid identity is stated exactly
 * once rather than in two places that can drift.
 *
 * @param options - The configured password, tokens, and username, each optional.
 *
 * @returns The composed identity, or the complete-sentence reason the configuration does not describe one.
 */
export function composeConnectIdentity(options: { password?: string; tokens?: AccessControllerTokens; username?: string }): AccessIdentityResult {

  const { password, tokens, username } = options;

  // The configuration groups its tokens in an object while the library's identity carries a flat one, so this is where the two shapes meet. Reading it once here
  // means a tokens object carrying nothing reads exactly as an absent one, in every arm below.
  const token = tokens?.access;

  // A complete credential pair, optionally alongside a token. Both identities together is the fullest client the library offers.
  if(username && password) {

    return { identity: token ? { password, token, username } : { password, username } };
  }

  // Half a credential pair describes no way of authenticating, so we name the missing half rather than silently falling through to a token-only connect the user
  // did not ask for.
  if(username) {

    return { error: "A username has been configured without a password." };
  }

  if(password) {

    return { error: "A password has been configured without a username." };
  }

  if(token) {

    return { identity: { token } };
  }

  return { error: "No UniFi Access login credentials or API token have been configured." };
}

/**
 * Whether this plugin can project a device into HomeKit - the capability classification, and nothing else. A hub drives a door's lock and a reader presents
 * credentials to one; everything else is hardware this plugin has no accessory for.
 *
 * Managedness deliberately does not live here. Membership owns that gate, so this predicate answers exactly one question - can the plugin project this hardware
 * class - and the two tiers together restate the discovery gate without either restating the other.
 *
 * Both arms delegate to the library's own predicates, so what counts as a hub and what counts as a reader is stated once, where the capabilities are defined, and
 * this function contributes only the union of the two. The totality each predicate needs over a malformed record is likewise the library's guarantee to keep.
 *
 * @param device - The device record to classify.
 *
 * @returns `true` when the device is a hub or a reader.
 */
export function isSupportedAccessDevice(device: AccessStateDevice): boolean {

  return isHub(device) || isReader(device);
}

/**
 * The Enterprise Access Hub port identity suffix - the one statement of the formula that distinguishes one port of a multi-door hub from its siblings. An
 * Enterprise hub drives several doors through one MAC address, so the MAC alone cannot identify the accessory a port becomes.
 *
 * One consumer calls this rather than restating the formula. {@link deviceSerial} appends it to the decorated serial, so the identity every consumer addresses a
 * device by, and the seed its accessory is minted from, carries the port, and one hub's ports are distinct devices and distinct accessories.
 *
 * @param device - The device record whose suffix is wanted.
 *
 * @returns The suffix, or the empty string for any record that is not an identified Enterprise port.
 */
export function entPortSuffix(device: AccessStateDevice): string {

  if((device.device_type !== ENTERPRISE_HUB_DEVICE_TYPE) || (device.source_id === undefined)) {

    return "";
  }

  return "-" + device.source_id.toUpperCase();
}

/* The display model each hub device type presents as. The official API answers a device's hardware type and no display model at all, while the topology document
 * answers both, so this map is what lets a record from either surface be read the same way.
 *
 * Only the hub types are named. A hub's display model is what the feature options scope on, so getting one wrong would silently change which options a user is
 * offered; a reader's is shown to the user and read by nothing, and the roles themselves are classified by the controller's own capability flags rather than by
 * any model name, so a reader needs no entry here to behave correctly.
 */
const HUB_DISPLAY_MODELS: Record<string, string> = {

  "UA-Hub-Door-Mini": "UA Hub Door Mini",
  "UA-ULTRA": "UA Ultra",
  "UAH": "UA Hub",
  "UGT": "UA Gate"
};

/**
 * The display model a device type presents as, for a record that carries a type but no display model of its own - which is every record the official API answers
 * with.
 *
 * An unmapped type answers itself. That is the honest fallback rather than a placeholder: the type string is the model designation the hardware is sold under, so a
 * reader, an Enterprise hub, and a device released after this map was written all read as something a user recognizes instead of as "Unknown".
 *
 * @param deviceType - The device type the record reports.
 *
 * @returns The display model.
 */
export function officialDeviceModel(deviceType: string): string {

  return HUB_DISPLAY_MODELS[deviceType] ?? deviceType;
}

/**
 * The model a device record presents as: its display model where the topology document answered one, its hardware model where that is all the record carries, and
 * the display mapping of its device type otherwise - which is every record the official API answers with, since that surface names a type and no model at all.
 *
 * An empty string reads as absent. The topology document has been observed to answer one, and an empty model is no model...so it falls through to the next arm
 * rather than presenting the user with a blank where a model belongs.
 *
 * @param device - The device record whose model is wanted.
 *
 * @returns The model, which always answers something a user recognizes.
 */
export function deviceModel(device: AccessStateDevice): string {

  if(device.display_model?.length) {

    return device.display_model;
  }

  if(device.model?.length) {

    return device.model;
  }

  return officialDeviceModel(device.device_type);
}

// The brand's carrier symbol. Declared rather than defined because the brand is a compile-time statement alone: nothing at runtime ever reads it, so no symbol
// needs to exist.
declare const decoratedSerialBrand: unique symbol;

/**
 * A hardware identity in the plugin's decorated spelling: colon-free, uppercase, with the Enterprise port suffix where one applies. That is the spelling this
 * family of plugins and libraries shares, and the one unifi-access stores every MAC address it holds in. The brand is a compile-time marker over a plain string -
 * `serialForm` is where a value earns it, and a branded value widens back into `string` freely - so a boundary that requires the decorated spelling can declare it
 * and turn a raw MAC address into a compile error, while raw-JavaScript callers see an ordinary string.
 *
 * @category Identity
 */
export type DecoratedSerial = string & { readonly [decoratedSerialBrand]: true };

/**
 * The one statement of the identity normalization every boundary applies where a hardware identity crosses in: colons out, case up.
 *
 * unifi-access stores every MAC address it holds in exactly this spelling, so on a stored record this is a no-op by construction. What it normalizes is every
 * identity arriving from somewhere else: a scope a user typed into a feature-option entry, a serial the status panel matches a record by, the colon-bearing key a
 * cached accessory context carries, and the official listing's colon-free lowercase id. The plugin's runtime keys every feature-option entry by this single form,
 * and normalizing at the boundary rather than at each use is what lets an option a user edits in the webUI resolve at runtime, whichever surface the device was
 * listed from.
 *
 * It keeps a body of its own rather than deferring to the library's `normalizeMacAddress`, which addresses a MAC address alone: a decorated serial may carry an
 * Enterprise port qualifier, and this accepts one.
 *
 * @param identity - The hardware identity to normalize.
 *
 * @returns The identity in the decorated spelling, carrying the {@link DecoratedSerial} brand.
 */
export function serialForm(identity: string): DecoratedSerial {

  return identity.replace(/:/g, "").toUpperCase() as DecoratedSerial;
}

/**
 * The decorated serial a device record presents as: the normalized hardware identity with the Enterprise port suffix where one applies. This is the device's
 * identity - what the device base carries as its own `id`, what every feature-option read scopes on, what an MQTT topic's tail spells, what the webUI decorates
 * its device list with, and what the status panel matches a record by - so a consumer holding one matches a record by composing this same statement rather than
 * restating the formula.
 *
 * It is total for every record that carries a hardware identity: a plain string composition that never throws. That is what lets it sit unguarded on the
 * membership loop, on the startup discovery walk, and in the status feed, none of which carries a per-device guard to absorb a fault.
 *
 * The port qualifier's spelling is the controller's own port key, uppercased. An identity is addressable by a feature-option entry exactly when that key carries
 * neither a period nor an equals sign - the two characters the option grammar spends elsewhere - and every key the controller has been observed to write is
 * `port<n>`. A key that carried one would leave that single port's entries unmatchable, which is a device nobody can address by name rather than a fault.
 *
 * The parameter demands a record whose hardware identity is established, because there is no serial to compose without one. {@link isManagedRecord} is the
 * narrowing every caller reaches it through, so "no serial without a MAC address" is stated once rather than guarded differently at each site.
 *
 * @param device - The device record whose decorated serial is wanted.
 *
 * @returns The decorated serial, carrying the {@link DecoratedSerial} brand.
 */
export function deviceSerial(device: AccessStateDevice & { mac: string }): DecoratedSerial {

  return (serialForm(device.mac) + entPortSuffix(device)) as DecoratedSerial;
}

/**
 * Which devices this plugin projects into HomeKit, as the one statement of that rule: every managed device record less the building-hosted Enterprise parent -
 * which answers through its ports alone - followed by every managed record in the access-point expansion, where those ports live. Each record is yielded already
 * narrowed to one carrying a hardware identity, so every consumer downstream composes an identity for it without a guard of its own.
 *
 * A generator rather than an array, because the selector below walks this once per dispatch and wants no intermediate allocation, while the webUI's device list
 * and the status feed's view resolution consume the same walk and stop where they like.
 *
 * Capability classification deliberately does not gate membership. A managed-but-unsupported record stays a member so that the adoption path's classification gate
 * and its log-once remain reachable.
 *
 * Which devices this plugin projects into HomeKit is consumer policy, which is why it lives here rather than in the library - while the Enterprise split it must not
 * drift from is consumed through the library's own exported predicate.
 *
 * @param state - The controller state to read membership from.
 *
 * @returns Each device record this plugin projects, in the order the walk reaches it.
 */
export function *membershipRecords(state: AccessState): Iterable<AccessStateDevice & { mac: string }> {

  // The plain device records, less the building-hosted Enterprise parent - it answers only through its ports, which the expansion below contributes.
  for(const device of state.devices.values()) {

    if(isManagedRecord(device) && !isEnterpriseHubRecord(device, state)) {

      yield device;
    }
  }

  // The Enterprise ports. The expansion spreads the hub's own fields onto each port, so the hub's managedness goes through the same read the plain records take.
  for(const port of selectAccessPoints(state)) {

    if(isManagedRecord(port)) {

      yield port;
    }
  }
}

/**
 * The membership records this plugin projects into HomeKit: every record {@link membershipRecords} names, less any whose capabilities this plugin cannot
 * project. Membership admits a managed-but-unsupported record deliberately, so the adoption path's classification gate stays reachable; this is the
 * narrower walk the accessory-identity questions read - which accessory UUIDs membership can account for, and which hardware a cached accessory names -
 * so that a record with no HomeKit presence to justify can never hold on to an accessory, and that filter is stated here once.
 *
 * @param state - The controller state to read membership from.
 *
 * @returns Each projected record, in the order {@link membershipRecords} reaches it.
 */
export function *projectedRecords(state: AccessState): Iterable<AccessStateDevice & { mac: string }> {

  for(const device of membershipRecords(state)) {

    if(isSupportedAccessDevice(device)) {

      yield device;
    }
  }
}

/**
 * Create this controller's HomeKit membership selector - a content-memoized view of which devices the plugin should be tracking.
 *
 * The membership rule itself is {@link membershipRecords}, whose other consumers are the webUI's device list and the status feed's view resolution; what the
 * selector adds is the identity projection and the memo. It returns the PREVIOUS array whenever the recomputed identities are element-wise identical, so the
 * store's observation - which dedups by reference - wakes only on a genuine membership change and never on record churn. An `is_managed` flip moves the list
 * itself, so an unmanaged hub becoming managed can never have its wake suppressed by the memoization.
 *
 * This is a factory rather than a shared selector because the memo is one slot per instance: a single module-level selector would be thrashed by two controllers'
 * interleaved stores, defeating the reference stability for both. Each controller creates its own and threads it to both the seed reconcile and the observe loop.
 *
 * @returns A membership selector instance.
 */
export function createMembershipIdsSelector(): (state: AccessState) => readonly string[] {

  let previous: readonly string[] = [];

  return (state: AccessState): readonly string[] => {

    const ids: string[] = [];

    for(const device of membershipRecords(state)) {

      ids.push(device.unique_id);
    }

    // Hand back the previous array when nothing about membership moved, which is what keeps an observer asleep through the record churn a busy controller produces.
    if((ids.length === previous.length) && ids.every((id, index) => id === previous[index])) {

      return previous;
    }

    previous = ids;

    return ids;
  };
}

/**
 * Resolve a device record by its identity - the plain device records first, then the Enterprise port expansion, which is where a building-hosted hub's per-door
 * records live.
 *
 * Every consumer that turns a membership identity back into the record behind it reads this one statement: the controller's discovery walk, its membership
 * reconcile and its accessory-UUID sweep, and the status feed's liveness read, per-device observation, and row composition. The library memoizes the expansion
 * against the hub record it was built from, so a port's record comes back as the same object across churn that leaves its hub's record untouched.
 *
 * @param id    - The identity to resolve, as membership names it.
 * @param state - The controller state to resolve against.
 *
 * @returns The record, or `undefined` where the state holds none under that identity.
 */
export function deviceRecord(id: string, state: AccessState): AccessStateDevice | undefined {

  return state.devices.get(id) ?? selectAccessPoints(state).find(port => port.unique_id === id);
}

/**
 * Resolve a device record by a MAC address in any spelling. The two sides meet on the decorated serial, so a context carrying the colon-bearing spelling a
 * controller wrote when an accessory was created and a record carrying the library's spelling still name the same hardware, and a record that established no
 * hardware identity matches nothing - the honest answer rather than a name composed from an absent address. The population is the caller's to choose, which
 * is what lets the controller name an orphan from every record the state holds rather than from membership alone.
 *
 * @param mac     - The MAC address to resolve, in any spelling.
 * @param records - The records to resolve it against.
 *
 * @returns The first record naming that hardware, or `undefined` where none does.
 */
export function recordByMac(mac: string, records: Iterable<AccessStateDevice>): AccessStateDevice | undefined {

  const serial = serialForm(mac);

  for(const device of records) {

    if((device.mac !== undefined) && (serialForm(device.mac) === serial)) {

      return device;
    }
  }

  return undefined;
}

/**
 * The HomeKit membership delta between the controller's current identity set and the identities already configured, as a pure set diff. `toAdd` is the current
 * identities not yet configured; `toRemove` is the configured identities that have left. This single diff drives the whole of device sync - one engine for both
 * arrival and departure - and isolating it makes the reconcile read as decision then effect. Order-preserving relative to the inputs.
 *
 * @param currentIds    - The controller's current membership identities.
 * @param configuredIds - The identities already configured.
 *
 * @returns The identities to add and the identities to remove.
 */
export function membershipDelta(currentIds: readonly string[], configuredIds: readonly string[]): { toAdd: string[]; toRemove: string[] } {

  const current = new Set(currentIds);
  const configured = new Set(configuredIds);

  return { toAdd: currentIds.filter(id => !configured.has(id)), toRemove: configuredIds.filter(id => !current.has(id)) };
}

/* What current membership can claim in one pass: the accessory UUIDs it accounts for, and the hardware identities it projects - the decorated serial of each MAC
 * address, port-less, carrying the brand so a raw spelling can never enter the set.
 *
 * Two decisions read it, which is why it is stated here rather than at either of them: a controller's own ownership predicate, asking what its membership accounts
 * for, and the stranded predicate, asking the same question of every configured controller's membership at once.
 */
export interface MembershipClaims {

  readonly serials: ReadonlySet<DecoratedSerial>;
  readonly uuids: ReadonlySet<string>;
}

/* The keys one controller answers by: the key it stamps its accessories with now, and the key it answered by before it learned its MAC address, which exists only
 * once a controller document has been read. The pair is stated once because the two decisions that consume it - one controller's ownership verdict, and the
 * stranded predicate over every configured controller - must read the same two keys or they can disagree about whose an accessory is.
 */
export interface ControllerOwnershipKeys {

  currentKey: string;
  priorKey: string | undefined;
}

/**
 * Which controller an accessory's context says it belongs to, against the key this controller answers by now and the key it answered by before it learned its MAC
 * address.
 *
 * A controller configured with a token alone keys its accessories by its configured address, because the controller document a MAC address comes from is
 * credential surface the published API does not serve. Once credentials are added, the same controller keys by its MAC address, and the accessories it adopted
 * under the address form are still its own...naming that case is what lets a caller keep them rather than reclaim them as orphans.
 *
 * An accessory carrying no key at all is nobody's, and that test comes first so an absent context can never match an absent prior key.
 *
 * Every key folds before it is compared, because a MAC address key is the controller's spelling of the day: the library stores it uppercase and colon-free, while
 * a cached context may carry the colon-bearing spelling the controller wrote when that accessory was created. A MAC address key therefore lands on the library's
 * form first, a hostname is case-insensitive by definition, and an IPv6 literal is not a MAC address at all, so the normalizer leaves its colons in place and only
 * its case folds. Folding compares identities rather than spellings, and it can never conflate two keys that name different things.
 *
 * The verdict classifies and nothing more. No caller rewrites a context from it: every accessory kept as a member is reconstructed at login, and construction
 * writes the context from the key the controller answers by then.
 *
 * An options object because all three arguments are strings of the same shape, and a positional swap would silently invert the verdict.
 *
 * @param options - The key the accessory's context carries, the key this controller answers by now, and the key it answered by before it learned its MAC address.
 *
 * @returns The ownership verdict.
 */
export function accessoryOwnership(options: { contextKey: string | undefined } & ControllerOwnershipKeys): AccessAccessoryOwnership {

  const { contextKey, currentKey, priorKey } = options;

  if(contextKey === undefined) {

    return "foreign";
  }

  const fold = (key: string): string => normalizeMacAddress(key).toLowerCase();
  const context = fold(contextKey);

  if(context === fold(currentKey)) {

    return "current";
  }

  return ((priorKey !== undefined) && (context === fold(priorKey))) ? "prior" : "foreign";
}

/**
 * Whether a cached accessory belongs to nothing this plugin is configured for: no configured controller answers for it by key, in any spelling, and no controller's
 * projected membership claims the device it names.
 *
 * This is the residual an individual controller cannot decide. Each controller's own ownership predicate is deliberately blind to an accessory another controller
 * keyed, which is what keeps two controllers configured in one plugin from reclaiming each other's accessories - so an accessory whose controller was replaced or
 * removed from the configuration is nobody's to act on, and lingers. Deciding it takes every controller's evidence at once, which is why the question is answered
 * here rather than at any one of them.
 *
 * The caller supplies evidence only from controllers whose identity is authoritative this session. A controller that never learned its own identity cannot say
 * which accessories are its own, and reading its silence as a verdict would strand accessories that are perfectly well accounted for.
 *
 * @param options - Every reporting controller's membership claims, the key the accessory's context carries, every configured controller's keys, the hardware
 *                  address the context names, and the accessory's own UUID.
 *
 * @returns `true` when nothing configured answers for the accessory.
 */
export function accessoryStranded(options: { claims: readonly MembershipClaims[]; contextKey: string | undefined;
  keys: readonly ControllerOwnershipKeys[]; mac: string | undefined; uuid: string; }): boolean {

  const { claims, contextKey, keys, mac, uuid } = options;

  // A key any configured controller answers by settles it: the accessory is somebody's, in whatever spelling the context was written.
  if(keys.some((key) => accessoryOwnership({ contextKey, currentKey: key.currentKey, priorKey: key.priorKey }) !== "foreign")) {

    return false;
  }

  const serial = (mac === undefined) ? undefined : serialForm(mac);

  // A device any controller projects settles it the other way: the hardware claim reads the context MAC address, the identity claim reads the UUID.
  return !claims.some((claim) => ((serial !== undefined) && claim.serials.has(serial)) || claim.uuids.has(uuid));
}

/**
 * Whether the evidence in hand is complete enough to reclaim anything: at least one controller is configured, every configured entry produced a controller, and
 * each of those controllers settled an authoritative identity this session.
 *
 * Each condition closes the fence for a reason of its own. With nothing configured there is no evidence at all to weigh an accessory against. A configuration entry
 * the platform skipped is an identity nothing can be attributed to, so the accessories it would have answered for would read as belonging to nobody. A controller
 * that never learned an authoritative identity is that same gap arriving later, and its accessories would be reclaimed for the sole reason that it could not speak.
 *
 * The zero-controllers condition is stated here rather than left to the caller. The plugin's own composition root never launches with nothing configured, so the
 * condition cannot fire there...it is written because a predicate that fails closed on its own is one a later consumer cannot mis-wire.
 *
 * @param options - How many controllers the configuration named, how many of them the platform constructed, and what each one's login settled about its identity.
 *
 * @returns `true` when every configured controller has reported an identity that can be answered for.
 */
export function reclaimFenceOpen(options: { configuredControllers: number; constructedControllers: number; outcomes: readonly AccessLoginOutcome[] }): boolean {

  const { configuredControllers, constructedControllers, outcomes } = options;

  return (configuredControllers > 0) && (configuredControllers === constructedControllers) && !outcomes.includes("unavailable");
}

/**
 * Whether a door's state carries positive evidence that a position sensor is wired to it.
 *
 * This is the accessory-creation evidence read for every hardware family the library derives facts for: an entry exists, it states a position, and that position is
 * not the controller's own report of an unwired sensor. An absent entry, or an entry silent on position, is "not established" - which is the absence of evidence
 * rather than evidence of absence, and creates no sensor.
 *
 * `dps_connected` is deliberately not consulted. The `dps` member is itself the position verdict and the connected flag its always-agreeing qualifier in every
 * observed shape, so keying on both would read one fact twice and invent a disagreement arm that nothing produces. The position vocabulary is likewise left open:
 * an unfamiliar value is the controller reporting something real, which is the library's own documented contract, so no closed-set check belongs here.
 *
 * @param entry - The door's state entry, or `undefined` when nothing has been established about the door.
 *
 * @returns `true` when the hardware positively reports a wired position sensor.
 */
export function hasDpsEvidence(entry: AccessDoorStateEntry | undefined): boolean {

  const position = entry?.dps;

  return (position !== undefined) && (position !== "none");
}

/**
 * The mode a UA Ultra's single terminal input is configured for - the one statement of the multiplex traversal.
 *
 * The Ultra carries one terminal input that is selectable between door-position and request-to-exit duty, and the selection lives in the first extension's target
 * configuration under `rex_button_mode`. Observed as `dps` and `rex`.
 *
 * The answer is that entry's value only when the value is a string. The library types a configuration value as a string, a number, or a boolean, so the narrowing
 * is what makes the declared return type hold...and a non-string value is absent evidence, the same posture the library's own flag reader takes toward a value it
 * has never been observed to write.
 *
 * Both consumers reach the traversal here - the position sensor's eligibility read and the request-to-exit input's wiring proxy - so the two cannot drift apart on
 * which extension or which key carries the mode.
 *
 * @param device - The device record to read.
 *
 * @returns The configured mode, or `undefined` when the record carries no readable one.
 */
export function ultraInputMode(device: AccessStateDevice): string | undefined {

  const mode = device.extensions?.[0]?.target_config.find(entry => entry.config_key === "rex_button_mode")?.config_value;

  return (typeof mode === "string") ? mode : undefined;
}

/**
 * The main and side door locations a UA Gate resolves to, from its device record and the topology's doors collection - the one statement of the gate's
 * door-discovery heuristic.
 *
 * This serves the UA Gate alone: that hardware drives two doors through one device record, and the library derives no per-door topology facts for a device it
 * cannot tell the doors of apart, so the resolution is a heuristic over the record's own bindings and the doors' names. A single-door hub's door is the library's
 * own published resolution and never passes through here.
 *
 * The side arm runs only when the caller says a side door is in scope, because what makes one eligible differs by consumer: the hub gates it on the user's
 * side-door preference, while an evidence-only consumer asks on the hardware class alone.
 *
 * The main-door arms rank two bindings the record itself carries above any reading of a door's name. The embedded door member is a topology snapshot, which the
 * official surface never carries, while the location the record names is the controller's own live binding and both surfaces carry it...so a door the controller
 * itself points at outranks a name that merely looks like a main gate.
 *
 * An options object because a positional boolean beside two structural arguments would read as noise at the call site.
 *
 * @param options - The device record, the topology's doors, and whether the side arm should run.
 *
 * @returns The discovered door location identifiers, each member absent where its door went undiscovered.
 */
export function discoverDoorLocations(options: { device: AccessStateDevice; doors: readonly AccessStateDoor[];
  sideDoorEligible: boolean; }): { mainDoorLocationId?: string; sideDoorLocationId?: string } {

  const { device, doors, sideDoorEligible } = options;

  const discovered: { mainDoorLocationId?: string; sideDoorLocationId?: string } = {};

  // Get the primary door ID from the device record, which may be undefined.
  const primaryDoorId = device.door?.unique_id;

  // Strategy 1: Use the device's bound door as the main door.
  if(primaryDoorId) {

    discovered.mainDoorLocationId = primaryDoorId;
  } else if(doors.some(door => door.unique_id === device.location_id)) {

    // Strategy 2: Use the location the controller binds this device to, where it names one of the doors we were handed.
    discovered.mainDoorLocationId = device.location_id;
  } else if(doors.length >= 1) {

    // Strategy 3: Look for a door named like "main", "gate", "portail" (but not side/pedestrian).
    const mainDoor = doors.find(door => /portail|main|gate|principal|entry|front/i.test(door.name) && !/portillon|side|pedestrian|pieton|wicket|back/i.test(door.name));

    // Strategy 4: Use the first door as the main door.
    discovered.mainDoorLocationId = mainDoor?.unique_id ?? doors[0]?.unique_id;
  }

  // Find the side door, where one is in scope.
  if(sideDoorEligible) {

    // Strategy 1: Check extensions for the oper2 port setting.
    const sideDoorFromExt = device.extensions?.find(ext => (ext.extension_name === "port_setting") && (ext.target_name === "oper2"))?.target_value;

    if(sideDoorFromExt) {

      discovered.sideDoorLocationId = sideDoorFromExt;
    } else {

      // Strategy 2: Look for a door named like "side", "portillon", "pedestrian".
      const sideDoor = doors.find(door => (door.unique_id !== discovered.mainDoorLocationId) &&
        /portillon|side|pedestrian|pieton|wicket|back|secondary/i.test(door.name));

      if(sideDoor) {

        discovered.sideDoorLocationId = sideDoor.unique_id;
      } else if(doors.length === 2) {

        // Strategy 3: If we have exactly two doors, the other one is the side door.
        const otherDoor = doors.find(door => door.unique_id !== discovered.mainDoorLocationId);

        discovered.sideDoorLocationId = otherDoor?.unique_id;
      }
    }
  }

  return discovered;
}

/**
 * Whether a hub's door position sensor is eligible to be modeled, family by family - the one statement of the eligibility switch every consumer of that question
 * reads.
 *
 * Each family answers from what its own hardware establishes. A UA Gate answers no: it drives two doors, the library derives no topology facts for it, and its
 * sensor follows the paths its hardware has always used rather than an evidence read. A UA Ultra answers from its multiplex, because it carries no wiring pair at
 * all and the mode its single input is configured for is the only evidence its record offers - an input serving request-to-exit duty is not a door position
 * sensor, whatever the door's state entry happens to carry - while a record that carries no extensions at all offers no multiplex to read, so it answers from the
 * door-state model like every other family. Every other family answers from that model through {@link hasDpsEvidence}.
 *
 * @param options - The device record and the door's state entry, `undefined` where nothing has been established about the door.
 *
 * @returns `true` when the family's own evidence supports modeling a door position sensor.
 */
export function dpsSensorEligible(options: { device: AccessStateDevice; entry: AccessDoorStateEntry | undefined }): boolean {

  const { device, entry } = options;

  switch(device.device_type) {

    case "UGT":

      return false;

    case "UA-ULTRA":

      return (device.extensions === undefined) ? hasDpsEvidence(entry) : (ultraInputMode(device) === "dps");

    default:

      return hasDpsEvidence(entry);
  }
}

/**
 * What a lock or unlock command should carry, given how the user configured the door's lock delay.
 *
 * The mapping is total over its whole input space, so the safety of a lock command is owned here, where it is tested, rather than resting on a guard somewhere
 * else. A door left on the default has no rule governing it at all: unlocking it is the momentary unlock, and asking to relock it is asking for something no rule
 * can express, which is refused. Once an interval is configured, locking resets the door to its own schedule, an interval of zero is an unlock with no end, and any
 * other interval holds the door unlocked for exactly that many MINUTES.
 *
 * All three verbs this produces - `reset`, `keep_unlock`, and `custom` - are expressible on the Access application's own endpoint, so the mapping needs no official
 * API path and works on a credential-only client.
 *
 * The interval arriving here is the hub's already-normalized configuration reading: a negative configured value is clamped to `undefined` where the option is read,
 * so the domain is a non-negative whole number or nothing at all. That is stated rather than re-validated, so there is one place the normalization lives.
 *
 * An options object because both arguments would otherwise be positional values of unrelated meaning, and a swap would silently invert the command.
 *
 * @param options - The configured delay interval in minutes, or `undefined` for the default, and whether the command is a lock.
 *
 * @returns The decision the caller should act on.
 */
export function lockCommandRule(options: { delayInterval: number | undefined; isLocking: boolean }): LockCommandDecision {

  const { delayInterval, isLocking } = options;

  // A door on the default momentary unlock has no rule to act on, so a relock has nothing it could ask for.
  if(delayInterval === undefined) {

    return isLocking ? { kind: "refuse" } : { kind: "unlock" };
  }

  // Locking under any configured interval puts the door back on its own schedule, which is what locks it now.
  if(isLocking) {

    return { kind: "rule", rule: { type: "reset" } };
  }

  // Zero is an unlock the user wants no end to, which the rule vocabulary spells as a verb of its own rather than as a duration.
  if(delayInterval === 0) {

    return { kind: "rule", rule: { type: "keep_unlock" } };
  }

  return { kind: "rule", rule: { interval: delayInterval, type: "custom" } };
}

/* How a hub's door is presented in HomeKit, as the choices the settings page offers. The service values are the HomeKit services the door is configured as,
 * spelled exactly as the configuring log line spells them, and the automatic choice defers to the hardware: a UA Gate presents as a garage door opener and every
 * other hub as a lock.
 */
export const doorServiceChoices = [

  { label: "Automatic", value: "Automatic" },
  { label: "Lock", value: "Lock" },
  { label: "Garage door opener", value: "GarageDoorOpener" }
] as const satisfies readonly FeatureOptionChoice[];

// The HomeKit service a hub's door is configured as, once the automatic choice has been resolved against the hardware.
export type DoorServiceType = Exclude<typeof doorServiceChoices[number]["value"], "Automatic">;

/**
 * Resolve the configured door service choice against the hardware: an explicit service is taken as chosen, and anything else - the automatic choice, nothing
 * configured, or text the catalog does not offer - defers to the hardware's own default, a garage door opener for the UA Gate and a lock for every other hub.
 *
 * @param options - The configured choice, or `null` or `undefined` where none resolves, and the hub's device type.
 *
 * @returns The service to configure the door as.
 */
export function resolveDoorService(options: { choice: Nullable<string | undefined>; deviceType: string }): DoorServiceType {

  const { choice, deviceType } = options;

  if((choice === "Lock") || (choice === "GarageDoorOpener")) {

    return choice;
  }

  return (deviceType === "UGT") ? "GarageDoorOpener" : "Lock";
}

/* Access methods available to us for readers. The `key` column is the configs vocabulary the access method state model is keyed by, and every switch read answers from
 * that model - the record's configuration rows, the official settings read, and the v2 access method events all feed it in this vocabulary. The `officialKeys` column is
 * the official update map's vocabulary, primary key first, and the switch writes go out under it. The `choice` column is the spelling a user's selection stores, and with
 * `name` it is what the settings page offers. Mobile's one switch spans the Bluetooth family, and writing a key a hardware class does not offer is a documented
 * no-effect, so naming the family carries that intent on every class; TouchPass is the one vocabulary rename between the two surfaces. The `satisfies` clause
 * compile-checks the column against the library's update map while `as const` keeps the literal inference the key union below is derived from.
 *
 * The catalog lives in this leaf rather than beside the switches it drives because two consumers need one definition of it: the hub's access method switches, and
 * the webUI status feed's access methods row. The feed runs inside the Config UI X child process, where the HomeKit device graph cannot be loaded at all, so a
 * catalog that lived beside the switches would have to be restated for the feed - and two catalogs is exactly the divergence a device's switches and its status
 * row must never have between them.
 */
export const accessMethods = [

  { capability: "identity_face_unlock", choice: "Face", key: "face", name: "Face Unlock", officialKeys: ["face"],
    subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_FACE },
  { capability: "hand_wave", choice: "Hand", key: "wave", name: "Hand Wave", officialKeys: ["wave"],
    subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_HAND },
  { capability: [ "mobile_unlock_ver2", "support_mobile_unlock" ], choice: "Mobile", configsApiKeys: [ "bt", "bt_button", "bt_tap" ], key: "bt_button",
    name: "Mobile", officialKeys: [ "bt_button", "bt_tap" ], subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_MOBILE },
  { capability: "nfc_card_easy_provision", choice: "NFC", key: "nfc", name: "NFC", officialKeys: ["nfc"],
    subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_NFC },
  { capability: "pin_code", choice: "PIN", key: "pin_code", name: "PIN", officialKeys: ["pin_code"],
    subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_PIN },
  { capability: "qr_code", choice: "QR", key: "qr_code", name: "QR Code", officialKeys: ["qr_code"],
    subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_QR },
  { capability: "support_apple_pass", choice: "TouchPass", key: "apple_pass", name: "TouchPass", officialKeys: ["touch_pass"],
    subtype: AccessReservedNames.SWITCH_ACCESSMETHOD_TOUCHPASS }
] as const satisfies readonly { capability: string | readonly string[]; choice: string; configsApiKeys?: readonly string[]; key: string; name: string;
  officialKeys: readonly (keyof AccessOfficialAccessMethodsUpdate)[]; subtype: string; }[];

// Extract the key property values from the access methods array to create a union type of all possible keys for our supported access methods.
export type AccessMethodKey = typeof accessMethods[number]["key"];

/**
 * Whether a device's capabilities carry a capability, stated in whichever form a catalog entry uses: a single flag, or a family where any member counts. The
 * hub's own capability reads, the status feed's row, and the settings page's list all answer through it, so what a device offers is never decided three ways.
 *
 * @param device     - The device record.
 * @param capability - The capability flag or family.
 *
 * @returns True when the device carries the capability.
 */
export function deviceHasCapability(device: AccessStateDevice, capability: string | readonly string[]): boolean {

  return Array.isArray(capability) ? capability.some((entry: string) => device.capabilities.includes(entry)) : device.capabilities.includes(capability as string);
}

/**
 * The access methods a reader's switches can be selected from, as the choices the settings page offers: every method the catalog knows, or only the ones a
 * device reports the capability for. The value is the method's own choice spelling and the label its display name, both from the one catalog the switches and
 * the status row read.
 *
 * @param device - The device whose capabilities narrow the list, or `undefined` for the whole catalog.
 *
 * @returns The choices, in the catalog's order.
 */
export function accessMethodChoices(device?: AccessStateDevice): FeatureOptionChoice[] {

  return accessMethods.filter(method => (device === undefined) || deviceHasCapability(device, method.capability))
    .map(method => ({ label: method.name, value: method.choice }));
}

/**
 * Translate a device's configuration rows into the access-method values a caller keys its own state by, in the rows' own vocabulary.
 *
 * The rows are a flat list carrying every configurable property of the device, so the catalog decides what is read out of them rather than the record deciding what
 * the caller holds. A method with no row of its own contributes no entry at all: the census listed the device's configuration and did not mention the method, which
 * says nothing about whether it is on, and a caller that needs the two apart cannot get them from a bare `false`.
 *
 * The catalog's key type flows through to the returned map, so a caller holding a literal union of method keys gets its own union back rather than a widened string.
 *
 * @param options - The catalog of methods to read, and the device's configuration rows.
 *
 * @returns A map holding, for each catalog method the rows mention, whether that row states the method is enabled.
 */
export function accessMethodValuesFromConfigRows<K extends string>(options: { methods: readonly { key: K }[];
  rows: readonly { key: string; value: string }[]; }): Map<K, boolean> {

  const { methods, rows } = options;
  const values = new Map<K, boolean>();

  for(const method of methods) {

    const row = rows.find(entry => entry.key === method.key);

    if(row === undefined) {

      continue;
    }

    values.set(method.key, row.value === "yes");
  }

  return values;
}

// The official keys one access method answers under, primary first. Typing them as a non-empty tuple is what makes "primary" a guarantee the type carries rather
// than a convention every reader has to keep, so the first key can be read without a presence check.
type AccessMethodOfficialKeys = readonly [keyof AccessOfficialAccessMethods, ...(keyof AccessOfficialAccessMethods)[]];

/**
 * Translate a device's official access-method settings into the access-method values a caller keys its own state by, crossing from the official vocabulary into the
 * catalog's own.
 *
 * Each method is read through its primary official key alone - the key its writes are judged on - so the two directions agree on which spelling speaks for a method
 * whose two surfaces name it differently. The settings map is sparse: an absent key means the hardware class does not offer the method rather than that the method
 * is off, so it contributes no entry, exactly as a missing configuration row does above.
 *
 * @param options - The catalog of methods to read, each with its official keys, and the device's official access-method settings.
 *
 * @returns A map holding, for each catalog method the settings offer, whether the settings state the method is enabled.
 */
export function accessMethodValuesFromOfficialSettings<K extends string>(options: { methods: readonly { key: K; officialKeys: AccessMethodOfficialKeys }[];
  settings: AccessOfficialAccessMethods; }): Map<K, boolean> {

  const { methods, settings } = options;
  const values = new Map<K, boolean>();

  for(const method of methods) {

    const reading = settings[method.officialKeys[0]]?.enabled;

    if(reading === undefined) {

      continue;
    }

    values.set(method.key, reading === "yes");
  }

  return values;
}

/**
 * Compose the official-API settings update an access-method write should carry, mapping every named key onto the wire's own "yes"/"no" vocabulary.
 *
 * Every member the update map admits accepts an `enabled` value, so one uniform literal serves the whole key set. The tuning members some methods also carry are
 * deliberately left untouched...a switch speaks to whether a method is on, never to how it is tuned.
 *
 * @param options - The desired state and the update-map keys the write should carry it to.
 *
 * @returns The settings update to send.
 */
export function composeAccessMethodUpdate(options: { enabled: boolean; keys: readonly (keyof AccessOfficialAccessMethodsUpdate)[] }): AccessOfficialDeviceSettingsUpdate {

  const { enabled, keys } = options;

  const update: AccessOfficialAccessMethodsUpdate = {};

  for(const key of keys) {

    update[key] = { enabled: enabled ? "yes" : "no" };
  }

  // eslint-disable-next-line camelcase
  return { access_methods: update };
}

/**
 * The verdict on an official access-method write, judged from the settings read back after it: whether the controller applied the change, silently declined it, or
 * cannot see the method on this device at all.
 *
 * The verdict is judged on the primary key alone - the key the switch's own reads use - because any secondary keys a multi-key method also writes are best-effort
 * riders whose absence or disagreement says nothing about the switch. The read-back map is sparse: an absent key means the official surface does not offer that
 * method on this hardware, not that the method is off, so absence is a verdict of its own and the caller decides which path serves next. A present key disagreeing
 * with the written value means the controller answered success while leaving the setting as it was...the one outcome only a read-back can reveal.
 *
 * @param options - The written value, the primary key to judge on, and the read-back access-method map.
 *
 * @returns `"confirmed"` when the read-back agrees, `"declined"` when it disagrees, and `"absent"` when the method is missing from the map.
 */
export function accessMethodWriteVerdict(options: { enabled: AccessOfficialAccessMethodValue; primaryKey: keyof AccessOfficialAccessMethods;
  readBack: AccessOfficialAccessMethods; }): "absent" | "confirmed" | "declined" {

  const { enabled, primaryKey, readBack } = options;

  // Every read-side member declares `enabled` required, so a present key always carries a comparable value and one optional-chained read answers both questions.
  const reading = readBack[primaryKey]?.enabled;

  if(reading === undefined) {

    return "absent";
  }

  return (reading === enabled) ? "confirmed" : "declined";
}

/**
 * What should follow an official access-method write, given its verdict and whether a credential transport exists to carry the raw fallback.
 *
 * A confirmed write is complete. A decline is final regardless of transport: the controller answered and refused, and repeating the ask on the raw endpoint would
 * second-guess an answer it already gave. An absent method and a thrown failure both fall back to the raw write when a transport can carry one - the raw endpoint
 * can reach methods the official map cannot see, and a thrown official error must not strand a controller the credential path still serves - and revert the switch
 * when none can.
 *
 * @param options - Whether a credential transport exists, and the write's verdict.
 *
 * @returns The action the caller should take.
 */
export function accessMethodWriteFollowup(options: { transport: boolean; verdict: "absent" | "confirmed" | "declined" | "failed" }):
  "complete" | "decline" | "fallback" | "revert" {

  const { transport, verdict } = options;

  switch(verdict) {

    case "confirmed":

      return "complete";

    case "declined":

      return "decline";

    case "absent":
    case "failed":

      return transport ? "fallback" : "revert";
  }
}

/**
 * What the doorbell trigger switch should do with a HomeKit write, given whether an official path exists and whether the doorbell is currently ringing.
 *
 * The switch mirrors ring truth, so a write agreeing with the mirror asks for what is already true and does nothing. With an official path, a disagreeing write is
 * the manual direction: on while quiet rings, off while ringing cancels. Without one, nothing can ring or cancel, so a disagreeing write is unavailable and the
 * caller surfaces why, while an agreeing one stays a quiet no-op rather than an error about something the user never asked to change.
 *
 * @param options - Whether the official API is available, whether the doorbell is ringing, and the value HomeKit wrote.
 *
 * @returns The action the caller should take.
 */
export function doorbellTriggerAction(options: { officialAvailable: boolean; ringing: boolean; value: boolean }): "cancel" | "none" | "ring" | "unavailable" {

  const { officialAvailable, ringing, value } = options;

  // A write that agrees with the mirrored ring state asks for what is already true, whichever paths exist.
  if(value === ringing) {

    return "none";
  }

  if(!officialAvailable) {

    return "unavailable";
  }

  return value ? "ring" : "cancel";
}

/**
 * The door guards a doorbell's ring filter can name, as the choices the settings page offers: one per guard the door lists, labeled by the user's name where the
 * official users census carries it and by the bare identifier otherwise. A door whose guards are unknown - the official listing carries no door guards, so a
 * token-only client knows none - offers every user the census carries instead, since any of them may be the guard a ring will name; a deactivated user is left
 * out there, because the controller no longer calls one, while a guard the door itself lists is offered whatever their status.
 *
 * The value is always the user's identifier, which is what a ring's guard list carries and what the filter matches; the label is only ever what the user reads.
 *
 * @param options - The guard identifiers the door lists, or `undefined` where no census carries them, and the official users census, empty where no token reaches it.
 *
 * @returns The choices, in the door's order where the door named them and by label otherwise.
 */
export function doorGuardChoices(options: { guardIds: readonly string[] | undefined; users: readonly AccessOfficialUser[] }): FeatureOptionChoice[] {

  const { guardIds, users } = options;

  // What a user is called on the settings page: the first name the census carries, falling back to the identifier the ring will name.
  const labelFor = (user: AccessOfficialUser): string => [ user.full_name, user.alias, user.username ].find(name => name.length > 0) ?? user.id;

  if(guardIds === undefined) {

    return users.filter(user => user.status !== "DEACTIVATED").map(user => ({ label: labelFor(user), value: user.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  const byId = new Map(users.map(user => [ user.id, user ]));

  return [...new Set(guardIds)].filter(id => id.length > 0).map(id => {

    const user = byId.get(id);

    return { label: user ? labelFor(user) : id, value: id };
  });
}

/**
 * Whether a doorbell ring should reach HomeKit, given the configured door guard filter and the guard ids the ring carries.
 *
 * True when the filter is empty (no filtering is configured), when any of the ring's guard ids is in the filter, or when the ring carries no guard ids at all.
 * The last arm is deliberately fail-open: a ring the controller did not attribute to any door guard is unclassifiable, and a filter must never turn an
 * unclassifiable ring into a silenced doorbell...a missed visitor costs more than an extra chime, and hardware or topology classes whose rings carry no guard ids
 * would otherwise go permanently silent the moment any filter is configured.
 *
 * @param options - The configured filter ids and the guard ids the ring carries.
 *
 * @returns `true` when the ring should be handled.
 */
export function doorbellRingAllowed(options: { filter: readonly string[]; guardIds: readonly string[] }): boolean {

  const { filter, guardIds } = options;

  return (filter.length === 0) || (guardIds.length === 0) || guardIds.some(id => filter.includes(id));
}

/**
 * The identifier of the doorbell-capable reader attached to a hub, or `null` where the hub has none.
 *
 * The controller's doorbell endpoint addresses the reader that carries the call surface, while the trigger switch projects from the hub that reader hangs off, so
 * ringing means resolving one to the other. The walk reads the same `connected_uah_id` linkage the ring handler reads in the opposite direction, and it settles on
 * `remote_view` because that is the capability the controller's own ring rail is named for...a reader that can be called carries it, and a reader that cannot does
 * not.
 *
 * First match wins. A hub offers one call surface in every observed topology, so ranking candidates would invent a distinction the hardware does not make. There is
 * deliberately no managedness or reachability filter either: a ring that fails loudly against a reader the controller cannot reach tells the user more than a silent
 * verdict that the hub has no doorbell at all.
 *
 * @param options - The device records to search and the hub whose reader is wanted.
 *
 * @returns The reader's identifier, or `null` where no doorbell-capable reader is attached to the hub.
 */
export function doorbellReaderId(options: { devices: Iterable<AccessStateDevice>; hubId: string }): Nullable<string> {

  const { devices, hubId } = options;

  for(const device of devices) {

    if((device.connected_uah_id === hubId) && device.capabilities.includes("remote_view")) {

      return device.unique_id;
    }
  }

  return null;
}

/**
 * Whether a record is one this controller manages and can be addressed by. These are the two conditions discovery has always skipped silently: a device the
 * controller does not manage is not ours to project, and a device with no hardware identity has nothing an accessory identity can be derived from.
 *
 * The hardware identity is optional on a stored record, because the official API's inventory names a device by an identifier that is not always address-shaped and
 * the projection leaves the member absent where it is not. This predicate is therefore the plugin's one narrowing of a record to an addressable one: every site
 * that needs the identity - membership, adoption, the accessory UUID, the decorated serial - establishes it here rather than asserting it for itself.
 *
 * @param device - The device record to test.
 *
 * @returns `true` when the record is managed and carries a hardware identity, narrowing it to a record whose identity can be read.
 */
export function isManagedRecord(device: AccessStateDevice): device is AccessStateDevice & { mac: string } {

  return device.is_managed && Boolean(device.mac);
}

/**
 * The path one controller's webhook endpoint registers under: the shared prefix followed by that controller's configured address, percent-encoded.
 *
 * Keying the path on the configured address rather than on anything the controller reports is what lets a controller find its own registration again on a client
 * that has learned nothing about itself yet, which is every token-only client. Encoding matters for an IPv6 literal, whose colons are not path characters.
 *
 * @param address - The controller's configured address.
 *
 * @returns The path.
 */
export function webhookEndpointPath(address: string): string {

  return ACCESS_WEBHOOK_PATH_PREFIX + encodeURIComponent(address);
}

/**
 * The URL a controller should deliver to: this host as that controller can reach it, the listener's port, and the controller's own path.
 *
 * An IPv6 literal is bracketed, which is what makes the authority parseable at all - without brackets its colons read as the port separator.
 *
 * @param options      - The composition's inputs.
 * @param options.host - The address this plugin is reachable on from the controller.
 * @param options.path - The path this controller's endpoint registers under.
 * @param options.port - The port the listener is bound to.
 *
 * @returns The endpoint URL.
 */
export function webhookEndpointUrl(options: { host: string; path: string; port: number }): string {

  const { host, path, port } = options;

  return "http://" + ((isIP(host) === 6) ? ("[" + host + "]") : host) + ":" + port.toString() + path;
}

/**
 * Every registration the controller already holds at one path.
 *
 * The match is on the path alone and never on the whole URL. This controller's own path is derived from its configured address, which is knowledge the plugin has
 * before it connects...so matching that way finds the registration again even when the host in it has changed since, which is what lets a moved Homebridge host
 * be rewritten in place instead of piling a second record beside the first. A record whose endpoint does not parse as a URL matches nothing, because there is no
 * path in it to compare.
 *
 * @param options          - The search inputs.
 * @param options.existing - Every registration the controller currently holds.
 * @param options.path     - The path to match.
 *
 * @returns The matching registrations, in the order the controller listed them.
 */
export function webhookRegistrations(options: { existing: readonly AccessOfficialWebhookEndpoint[]; path: string }): readonly AccessOfficialWebhookEndpoint[] {

  const { existing, path } = options;

  return existing.filter(endpoint => URL.parse(endpoint.endpoint)?.pathname === path);
}

/**
 * What to do about this controller's registration, decided from what it already holds.
 *
 * The first record at our path is the one acted on and every further record at the same path is stale. A first record that agrees with what we want in endpoint,
 * name, and event set is taken as it stands - which keeps the secret the controller minted, and is what makes a restart cost the controller nothing.
 *
 * The event comparison is order-independent, because the order a controller lists events back in is not a difference worth rewriting a registration over.
 *
 * @param options          - The decision's inputs.
 * @param options.desired  - The registration this plugin wants to hold.
 * @param options.existing - Every registration the controller currently holds.
 * @param options.path     - The path this controller's endpoint registers under.
 *
 * @returns The plan.
 */
export function webhookRegistrationPlan(options: { desired: AccessOfficialWebhookEndpointWrite; existing: readonly AccessOfficialWebhookEndpoint[];
  path: string; }): WebhookRegistrationPlan {

  const { desired, existing, path } = options;
  const [ first, ...stale ] = webhookRegistrations({ existing, path });

  if(first === undefined) {

    return { kind: "create", stale };
  }

  const wanted = new Set(desired.events);
  const sameEvents = (first.events.length === desired.events.length) && first.events.every(event => wanted.has(event));
  const matches = (first.endpoint === desired.endpoint) && (first.name === desired.name) && sameEvents;

  return { endpoint: first, kind: matches ? "reuse" : "update", stale };
}

/**
 * Every registration this plugin left on a controller under an address none of its configured controllers answers for.
 *
 * A controller the user re-addresses leaves its old registration behind, because the reconcile keys on the configured address and so looks only at the new path.
 * Nothing points at the leftover and nothing else will ever clear it. This search is what finds them, and it is deliberately narrow: a record qualifies only when
 * it sits under this plugin's own path prefix, at a path no configured controller claims, and at the authority this plugin's own listener answers on. The
 * authority test is what keeps a second Homebridge install's registrations out of the result - two installs can serve one controller, and theirs carry the same
 * prefix and the same paths at a different host or port.
 *
 * The authority is read back off a URL composed through the same builder every registration is written with, rather than spelled here, so the IPv6 bracketing
 * stays stated in one place. A host that composes nothing parseable yields an authority no record can equal, which selects nothing...the safe answer for a
 * question about deletion. A record whose own endpoint does not parse likewise matches nothing, exactly as the path search treats it.
 *
 * @param options                     - The search inputs.
 * @param options.configuredAddresses - The address of every controller this plugin is configured for.
 * @param options.existing            - Every registration the controller currently holds.
 * @param options.host                - The address this plugin is reachable on from the controller.
 * @param options.port                - The port the listener is bound to.
 *
 * @returns The orphaned registrations, in the order the controller listed them.
 */
export function orphanedWebhookRegistrations(options: { configuredAddresses: readonly string[]; existing: readonly AccessOfficialWebhookEndpoint[]; host: string;
  port: number; }): readonly AccessOfficialWebhookEndpoint[] {

  const { configuredAddresses, existing, host, port } = options;

  const ours = URL.parse(webhookEndpointUrl({ host, path: ACCESS_WEBHOOK_PATH_PREFIX, port }))?.host;
  const claimed = new Set(configuredAddresses.filter(address => address).map(address => webhookEndpointPath(address)));

  return existing.filter(endpoint => {

    const parsed = URL.parse(endpoint.endpoint);

    // A record we cannot parse carries neither a path nor an authority to judge, so it is never ours to remove.
    if(!parsed) {

      return false;
    }

    return parsed.pathname.startsWith(ACCESS_WEBHOOK_PATH_PREFIX) && !claimed.has(parsed.pathname) && (parsed.host === ours);
  });
}

/**
 * The signature a delivery carries, read out of the headers Node parsed for it.
 *
 * Only a string is a signature. Node comma-joins an ordinary header sent more than once into a single string, so a repeated `signature` arrives as one joined
 * value that fails verification downstream rather than reaching anything as two candidates. The array shape belongs to the handful of headers Node collects
 * that way and never carries a signature on a real round trip, and the branch answering `undefined` for it is here because `IncomingHttpHeaders` types every
 * value as a string, an array of strings, or nothing at all...answering that type completely is what this does rather than casting a shape away.
 *
 * @param headers - The delivery's headers as Node parsed them.
 *
 * @returns The signature when the header is a string, and `undefined` when it is absent or arrived in the array shape.
 */
export function webhookSignatureHeader(headers: IncomingHttpHeaders): string | undefined {

  const header = headers["signature"];

  return (typeof header === "string") ? header : undefined;
}

/**
 * Whether a delivery's signed moment is close enough to this host's clock to act on.
 *
 * The comparison is two-sided deliberately. A delivery from the future is as suspect as a stale one, and a controller whose clock runs ahead of the Homebridge
 * host's produces exactly that, so a past-only check would quietly accept anything a forger cared to date forward.
 *
 * @param options                  - The freshness inputs.
 * @param options.nowMs            - This host's clock reading, in milliseconds.
 * @param options.timestampSeconds - The moment the signature established, in unix seconds.
 * @param options.windowMs         - How far apart the two may be.
 *
 * @returns `true` when the delivery is fresh.
 */
export function webhookDeliveryFresh(options: { nowMs: number; timestampSeconds: number; windowMs: number }): boolean {

  const { nowMs, timestampSeconds, windowMs } = options;

  return Math.abs(nowMs - (timestampSeconds * 1000)) <= windowMs;
}

/**
 * Who opened a door and how, read out of one unlock delivery.
 *
 * The actor is read through a single null check, because a delivery either attributes the action to someone or does not, and its name and its kind are two halves
 * of that one answer rather than two independent questions.
 *
 * @param delivery - The unlock delivery.
 *
 * @returns The attribution.
 */
export function unlockAttribution(delivery: AccessUnlockDelivery): AccessUnlockAttribution {

  const { actor, object } = delivery.data;
  const attributed = actor !== null;

  return {

    actor: attributed ? actor.name : null,
    // The webhook channel spells the API-caller actor with a hyphen where the notification socket spells it with an underscore, and the library's own normalizer
    // is what makes the two one spelling here.
    actorType: attributed ? normalizeActorType(actor.type) : null,
    method: object.authentication_type,
    policy: object.policy_name.length ? object.policy_name : null,
    reader: object.reader_id.length ? object.reader_id : null,
    result: object.result,
    time: object.time
  };
}

/**
 * One unlock delivery as a sentence fit to show a person.
 *
 * The result decides the verb and the preposition together: a granted unlock happened "by" someone, while a refused one was attempted "for" them. An unattributed
 * unlock drops the clause entirely rather than naming an empty someone, and the parenthetical carries how the door was addressed - the library's plain-English
 * gloss where its vocabulary has one, the raw wire token otherwise - with the policy that governed it where one did.
 *
 * @param options             - The sentence's inputs.
 * @param options.attribution - What the delivery reported.
 * @param options.door        - The door's name, as the delivery named it.
 *
 * @returns The sentence.
 */
export function describeUnlock(options: { attribution: AccessUnlockAttribution; door: string }): string {

  const { attribution, door } = options;
  const granted = attribution.result === "Access Granted";
  const actor = (attribution.actor === null) ? "" : (" " + (granted ? "by" : "for") + " " + attribution.actor);
  const policy = (attribution.policy === null) ? "" : (", policy: " + attribution.policy);

  return door + " " + (granted ? "unlocked" : "unlock refused") + actor + " (" + (ACCESS_AUTHENTICATION_TYPES[attribution.method] ?? attribution.method) +
    policy + ").";
}

/**
 * How a doorbell call ended, in words fit to show a person.
 *
 * The glosses are the library's own table, read through rather than restated, so a code whose meaning is revised upstream reaches the log without an edit here. A
 * code the table does not carry still says something honest - that the call ended, and what the controller called it - rather than nothing at all.
 *
 * @param reasonCode - The reason code the delivery carried.
 *
 * @returns The outcome sentence.
 */
export function doorbellOutcome(reasonCode: number): string {

  return ACCESS_DOORBELL_REASON_CODES[reasonCode] ?? ("The call ended (reason code " + reasonCode.toString() + ").");
}
