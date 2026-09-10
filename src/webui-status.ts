/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-status.ts: The live device-status adapter for the Config UI X settings panel.
 *
 * This module runs exclusively inside the transient custom-UI child process that Config UI X forks for the plugin's settings modal - never inside Homebridge. It is
 * the Access adapter for the shared status wire contract: the StatusEvent union, the StatusRow shape, and the classified StatusErrorReason live in
 * homebridge-plugin-utils, while this module owns the Access projection - the context registry and its additive route, the connect-on-view lifecycle, the row policy,
 * and the error classification.
 *
 * The lifecycle is connect-on-view rather than a per-device connection pool, because Access devices are reached over a controller connection whose identity lives in the
 * plugin configuration: the browser sends the feed a context - each configured controller's identity beside the decorated serials of the devices it answered for - and a
 * view request connects to the controller serving that serial, holds one live client for the active view, and reuses it across views of the same controller. The feed
 * pushes state over the bridge as the panel's own vocabulary - rows, availability, and classified errors - so nothing Access-internal crosses the wire.
 *
 * The child process dying with the settings modal is the primary disposal: every connection this module holds lives in this process alone, so the modal closing
 * takes it all down. The explicit disposal method exists for tests and for symmetry, not for a server call site.
 */
import type { AccessApiMode, AccessCapabilities, AccessDoorStateEntry, AccessLogging, AccessState, AccessStateDevice, ConnectOptions, ConnectionEvents,
  ConnectionState, StateStore } from "unifi-access";
import { AccessAuthError, AccessAuthorizationError, AccessClient, AccessStallError, AccessTimeoutError, isHub, isReader, isTamperCapable, selectController,
  selectControllerUptime, selectDoorStates, tamperState } from "unifi-access";
import type { Nullable, StatusChoice, StatusChoicesRow, StatusErrorReason, StatusEvent, StatusRow, StatusTextRow } from "homebridge-plugin-utils";
import { accessMethodValuesFromConfigRows, accessMethods, composeConnectIdentity, deviceHasCapability, deviceRecord, deviceSerial, discoverDoorLocations,
  dpsSensorEligible, membershipRecords, serialForm } from "./policy.ts";
import { formatErrorMessage, formatSeconds, sameEntries } from "homebridge-plugin-utils";
import type { DecoratedSerial } from "./policy.ts";

// The onRequest route the context extension registers - the plugin's addition to the shared status protocol. It carries the browser's controller context: each
// configured controller's identity beside the decorated serials of the devices its kept probe answer listed, which is what lets a view request resolve the
// controller serving a serial. server.js and ui.mjs both address the bridge through this constant (ui.mjs mirrors the literal in its own module, because browser
// code cannot import from dist/), so this module is its one owner. The push-event name and the view route are the shared homebridge-plugin-utils contract.
export const ACCESS_STATUS_CONTEXT_ROUTE = "/statusContext";

/**
 * One controller in a status context request: a controller the browser holds a kept probe answer for. The identity members are spelled exactly as a `controllers[]`
 * configuration item spells them - the card-values vocabulary - so the identity composition consumes them unchanged. `serials` carries the decorated serial numbers
 * of that answer's devices, the panel's join key; `controllerSerial` carries the decorated serial of the answer's controller-as-device record when the answer
 * carried one, and is absent for a token-only controller, whose official surface exposes no console identity.
 */
export interface StatusContextController {

  address: string;
  controllerSerial?: string;
  password?: string;
  serials: string[];
  tokens?: { access: string };
  username?: string;
  verifyTls?: boolean;
}

/**
 * The status context request: every controller the browser holds a kept probe answer for. The registry replaces its contents wholesale from each request.
 */
export interface StatusContextRequest {

  controllers: StatusContextController[];
}

/* Narrow one untrusted context entry. A malformed entry rejects individually rather than invalidating the whole request, because one bad controller must not blank
 * the panel for every other one. The optional members are type-validated rather than passed through - a present-but-wrong-typed member rejects the entry - and the
 * result is a fresh object carrying only the declared members, so the identity composition downstream arbitrates identity validity over honestly-typed members
 * rather than receiving a type-level promise no check made.
 */
function narrowStatusContextController(candidate: unknown): Nullable<StatusContextController> {

  if((typeof candidate !== "object") || (candidate === null)) {

    return null;
  }

  const record = candidate as { address?: unknown; controllerSerial?: unknown; password?: unknown; serials?: unknown; tokens?: unknown; username?: unknown;
    verifyTls?: unknown; };

  if((typeof record.address !== "string") || (record.address.length === 0) || !Array.isArray(record.serials)) {

    return null;
  }

  const entry: StatusContextController = { address: record.address, serials: record.serials.filter((serial): serial is string => typeof serial === "string") };

  if(record.controllerSerial !== undefined) {

    if(typeof record.controllerSerial !== "string") {

      return null;
    }

    entry.controllerSerial = record.controllerSerial;
  }

  if(record.password !== undefined) {

    if(typeof record.password !== "string") {

      return null;
    }

    entry.password = record.password;
  }

  if(record.tokens !== undefined) {

    if((typeof record.tokens !== "object") || (record.tokens === null)) {

      return null;
    }

    const access = (record.tokens as { access?: unknown }).access;

    if(typeof access !== "string") {

      return null;
    }

    entry.tokens = { access };
  }

  if(record.username !== undefined) {

    if(typeof record.username !== "string") {

      return null;
    }

    entry.username = record.username;
  }

  if(record.verifyTls !== undefined) {

    if(typeof record.verifyTls !== "boolean") {

      return null;
    }

    entry.verifyTls = record.verifyTls;
  }

  return entry;
}

/**
 * Narrow the untrusted context-request body at the bridge boundary. The body must be an object carrying a `controllers` array or the whole request is null - and an
 * empty array is valid, because it is how the browser says no controller has a kept answer. Each entry narrows individually through the entry rules above, and the
 * narrowed result is never a passthrough of the input. This lives in the tested module rather than the untestable server adapter.
 *
 * @param body - The untrusted bridge request body.
 *
 * @returns The narrowed {@link StatusContextRequest}, or `null` when the body does not match the contract.
 */
export function narrowStatusContextRequest(body: unknown): Nullable<StatusContextRequest> {

  if((typeof body !== "object") || (body === null)) {

    return null;
  }

  const record = body as { controllers?: unknown };

  if(!Array.isArray(record.controllers)) {

    return null;
  }

  const controllers: StatusContextController[] = [];

  for(const candidate of record.controllers) {

    const entry = narrowStatusContextController(candidate);

    if(entry !== null) {

      controllers.push(entry);
    }
  }

  return { controllers };
}

/**
 * Classify a connect failure into the wire contract's error vocabulary. The typed error classes are the library's own: an authentication or authorization fault
 * answers `auth-invalid`, and a timeout or a stalled bootstrap answers `timeout`. Everything else - the library's network and throttle classes among them - answers
 * `unreachable`, the honest default: the panel's unreachable copy names connectivity, which is what an unclassified throw is to a user.
 *
 * The identity-composition rejection deliberately does not route through here: it is a refusal to attempt, not a thrown failure, so the view path answers it with
 * `auth-missing` directly.
 *
 * @param error - The thrown failure to classify.
 *
 * @returns The classified {@link StatusErrorReason}.
 */
export function classifyStatusError(error: unknown): StatusErrorReason {

  if((error instanceof AccessAuthError) || (error instanceof AccessAuthorizationError)) {

    return "auth-invalid";
  }

  if((error instanceof AccessTimeoutError) || (error instanceof AccessStallError)) {

    return "timeout";
  }

  return "unreachable";
}

// The panel's row identities, a closed union used internally to key the label and sizer records exhaustively. The wire carries a row id as a plain string; this
// closed union is the plugin's own, so a new row must extend it here and gains its label and sizer entries at compile time rather than becoming a silently dead row.
export type AccessStatusRowId = "api" | "door" | "lock" | "methods" | "sidedoor" | "sidelock" | "tamper" | "uptime";

/* Which form each row identity composes in. The wire's text row carries a display value, while its choices row carries a list the panel renders as a read-only
 * checkbox group. Splitting the identities into complementary halves is what keeps each table below exhaustive over exactly the rows it serves - every text row
 * must state a width reservation, and a choices row cannot state one, because the rendered list already is its own reservation by the wire's contract.
 */
type AccessChoicesRowId = "methods";
type AccessTextRowId = Exclude<AccessStatusRowId, AccessChoicesRowId>;

// The human-readable label for each row identity, in either form. The door row is the one label with a device-class override: a UA Gate names it "Gate" at
// composition, because that hardware's main door is the gate itself.
const STATUS_ROW_LABELS: Record<AccessStatusRowId, string> = {

  api: "API",
  door: "Door",
  lock: "Lock",
  methods: "Access Methods",
  sidedoor: "Side door",
  sidelock: "Side door lock",
  tamper: "Tamper",
  uptime: "Uptime"
};

/* The widest display value each text row's vocabulary can produce, one entry per text row id. This lives beside the value mappers because they share one
 * vocabulary: a change to a row's value set must update the widest member here in the same edit. The frontend renders each as an invisible width reservation so a
 * column is born at its maximum width and never truncates a value or shifts. The uptime row's vocabulary is open-ended, so its reservation is a generous
 * representative rather than a maximum. Typing the map as a Record over AccessTextRowId makes it fail to compile until every text row id is covered.
 */
const STATUS_ROW_SIZERS: Record<AccessTextRowId, string> = {

  api: "Credentials + API token",
  door: "Closed",
  lock: "Unlocked",
  sidedoor: "Closed",
  sidelock: "Unlocked",
  tamper: "Detected",
  uptime: "999d 23h"
};

// Compose one text row from the closed vocabulary, so a typo'd row id is a compile error. The label defaults from the label table; the one caller with a
// device-class override supplies its own.
function statusRow(id: AccessTextRowId, value: string, label = STATUS_ROW_LABELS[id]): StatusTextRow {

  return { id, label, sizer: STATUS_ROW_SIZERS[id], value };
}

// Compose one choices row from the same closed vocabulary, so both forms answer a typo'd row id the same way. It states no sizer, which is the wire contract's own
// rule for this form, and an empty list is a legitimate composition the panel renders as the placeholder dash.
function statusChoicesRow(id: AccessChoicesRowId, choices: StatusChoice[]): StatusChoicesRow {

  return { choices, id, kind: "choices", label: STATUS_ROW_LABELS[id] };
}

// Whether two choices render identically: the same label carrying the same selection. This is the whole of one entry's diff, because the wire replaces a choices
// list rather than addressing an entry inside it...any difference anywhere is the one replacement.
function sameChoice(choice: StatusChoice, previous: StatusChoice): boolean {

  return (choice.label === previous.label) && (choice.selected === previous.selected);
}

/* Map the connection's API mode onto the row vocabulary. The mode a connected client reports is verified fact rather than a configuration echo: the library proves
 * every identity leg it was handed at connect, and a leg that fails there fails the connect, so the row states which surfaces this connection actually reached.
 *
 * The token arm renders nothing the settings panel can reach today, because a token-only connect answers the device picker with no console identity to lead with -
 * homebridge-ui/server.js, the token-only arm - and a sidebar with no controller entry offers no controller view. The mapping is total anyway: the vocabulary is
 * the library's rather than the panel's, so a mode the library adds is a compile error here rather than a row that silently renders nothing.
 */
const API_ROW_VALUES: Record<AccessApiMode, string> = {

  credential: "Credentials",
  dual: "Credentials + API token",
  token: "API token"
};

// Map a door state entry's lock member onto the row vocabulary. The value set is deliberately open: an unfamiliar value reads as locked, the same safe reading the
// hub's own projection takes, while an absent member is "not established" and renders the placeholder dash through the empty string.
function lockRowValue(lock: string | undefined): string {

  if(lock === undefined) {

    return "";
  }

  return [ "unlock", "unlocked" ].includes(lock) ? "Unlocked" : "Locked";
}

// Map a door state entry's position member onto the row vocabulary. An absent member is "not established" and a "none" is the controller positively reporting an
// unwired sensor - two independent no-evidence readings that both render the placeholder dash - while any other unfamiliar value reads as closed, the same safe
// reading the hub's own projection takes.
function dpsRowValue(dps: string | undefined): string {

  if((dps === undefined) || (dps === "none")) {

    return "";
  }

  return (dps === "open") ? "Open" : "Closed";
}

// Map a tamper reading onto the row vocabulary: the record reporting tampering, reporting none, or never having reported at all - and the third state renders the
// placeholder dash, because a record that has said nothing is distinct from one reporting no tampering.
function tamperRowValue(verdict: boolean | undefined): string {

  if(verdict === undefined) {

    return "";
  }

  return verdict ? "Detected" : "Normal";
}

// Map the controller host's uptime onto the row vocabulary, rendered through the library's duration formatting so a duration reads the same here as it does
// everywhere else in the family. An absent reading - the controller document not yet fetched - renders the placeholder dash through the empty string, the row
// policy's degrade-by-absence rule.
function uptimeRowValue(uptime: Nullable<number>): string {

  return (uptime === null) ? "" : formatSeconds(uptime);
}

/* Compose a reader's access methods row: every catalog method the hardware offers, in the catalog's own order, each stating whether the device's configuration
 * rows say it is enabled. The rows are read through the same shared translation the hub's own fold reads them through, in the same configs vocabulary, so the row
 * and the switches answer from one interpretation rather than two that can drift.
 *
 * A method can be absent from the list for more than one reason, and each is handled differently. A method whose capability the hardware does not carry is not listed
 * at all - the device does not offer it, so there is nothing to report. A method the hardware does carry whose configuration row does not resolve is omitted too,
 * under the degrade-by-absence rule: a census that listed the device's configuration and never mentioned the method has said nothing about it, and an unchecked box
 * would be a reading the controller never made. A reader whose rows resolve nothing therefore composes an empty list, which the panel renders as the placeholder
 * dash.
 *
 * The row states the DEVICE's truth like every other row here, so no feature option gates it: a user who turned a method's HomeKit switch off still sees what the
 * hardware itself reports.
 */
function accessMethodsRow(device: AccessStateDevice): StatusChoicesRow {

  const values = accessMethodValuesFromConfigRows({ methods: accessMethods, rows: device.configs ?? [] });
  const choices: StatusChoice[] = [];

  for(const method of accessMethods) {

    const value = values.get(method.key);

    if((value === undefined) || !deviceHasCapability(device, method.capability)) {

      continue;
    }

    choices.push({ label: method.name, selected: value });
  }

  return statusChoicesRow("methods", choices);
}

/**
 * One resolved door role's state for the row derivation: the role's presence says the door was discovered, and its `entry` member carries what the state
 * establishes about it - absent where the door has never reported.
 */
export interface ResolvedDoorEntry {

  entry?: AccessDoorStateEntry;
}

/**
 * The role-labeled door-state entries a view's resolution supplies to the row derivation. A single-door hub fills `main`, a UA Gate up to both, and a view that
 * resolved no doors supplies neither. The side role's presence is what keys its rows: a discovered side door renders its pair even before it has reported, while an
 * undiscovered one renders nothing.
 */
export interface ResolvedDoorEntries {

  main?: ResolvedDoorEntry;
  side?: ResolvedDoorEntry;
}

/**
 * The row policy's pure derivation: the row set for one view, composed from what the view's kind gives it - a controller view's API mode, or a device view's record
 * and role-labeled resolved door entries - beside the state both arms project. The caller owns the lookups - the resolution layer resolves the door identities at
 * view establishment and the loops look their entries up against the live state - so this function is honestly a pure state projection.
 *
 * The `kind` member splits the options rather than merely selecting an arm: a controller-as-device view carries the connection's API mode and no door entries, a
 * device view carries its record and entries and no mode, and neither arm can be spelled with the other's members. The tag is explicit because a token-only device
 * view carries no record either - overloading absence would put the controller's rows on a device.
 *
 * The rows report the DEVICE's truth, never the HomeKit projection: hardware eligibility gates the door row through the shared eligibility statement, and no user
 * preference is consulted - a user who disabled a HomeKit sensor still sees the door's real position in this admin surface. An empty value is the
 * degrade-by-absence rule: the row renders the placeholder dash, matching the library's absent-member semantics.
 *
 * @param options - The view kind and what that kind carries: the connection's API mode for a controller view, or the viewed device's record (absent for a
 * token-only view or a removal window) and the resolved entries for a device view, beside the state either arm projects.
 *
 * @returns The composed row set.
 */
export function composeStatusRows(options: { kind: "controller"; mode: AccessApiMode; state: AccessState } |
  { device: AccessStateDevice | undefined; entries: ResolvedDoorEntries; kind: "device"; state: AccessState }): StatusRow[] {

  // The controller arm: the console's own view states which API surfaces its connection reached, then its uptime, advancing on the library's refresh cadence.
  if(options.kind === "controller") {

    return [ statusRow("api", API_ROW_VALUES[options.mode]), statusRow("uptime", uptimeRowValue(selectControllerUptime(options.state))) ];
  }

  const { device, entries } = options;

  // A device the state holds no record for has no facts to project: a token-only client derives no device records, and a device inside a removal window has left
  // them. The panel's identity rows and status label carry the view.
  if(device === undefined) {

    return [];
  }

  // A reader carries no door state; availability is shown by the panel's own status label. What it does carry is its access methods, and a device that is neither hub
  // nor reader - hardware this plugin holds no row vocabulary for - still answers with nothing.
  if(!isHub(device)) {

    return isReader(device) ? [accessMethodsRow(device)] : [];
  }

  const gate = device.device_type === "UGT";
  const main = entries.main?.entry;
  const rows: StatusRow[] = [statusRow("lock", lockRowValue(main?.lock))];

  /* The door row. A UA Gate offers it on the strength of the hardware being a gate - the same rule its HomeKit sensor follows - and labels it for what it drives;
   * every other family answers through the shared eligibility statement, with an ineligible family's row degrading to the placeholder dash rather than vanishing.
   */
  if(gate) {

    rows.push(statusRow("door", dpsRowValue(main?.dps), "Gate"));
  } else {

    rows.push(statusRow("door", dpsSensorEligible({ device, entry: main }) ? dpsRowValue(main?.dps) : ""));
  }

  // The side pair, present only where a side door was discovered.
  if(entries.side !== undefined) {

    rows.push(statusRow("sidelock", lockRowValue(entries.side.entry?.lock)), statusRow("sidedoor", dpsRowValue(entries.side.entry?.dps)));
  }

  // The tamper row follows the hardware capability, and the capability and the reading behind it are both the library's own.
  if(isTamperCapable(device)) {

    rows.push(statusRow("tamper", tamperRowValue(tamperState(device))));
  }

  // Hardware that is both hub and reader carries its access methods beneath the rows its door drives, so the door state a hub view is opened for still leads.
  if(isReader(device)) {

    rows.push(accessMethodsRow(device));
  }

  return rows;
}

/**
 * The connection surface the feed consumes: the monitor's purpose-built events and its current state. Structural rather than the client's own class so a test
 * drives the wiring with a hand-rolled stub; the real connection monitor satisfies it as-is.
 */
export interface StatusFeedConnection {

  on<K extends keyof ConnectionEvents>(event: K, handler: (...args: ConnectionEvents[K]) => void): Disposable;
  readonly state: ConnectionState;
}

/**
 * The hub-handle surface the resolution layer consumes: the library's published door-identity resolution and nothing else. Structural for the same reason as
 * {@link StatusFeedConnection}.
 */
export interface StatusFeedHubHandle {

  readonly doorId: string;
}

/**
 * The client surface the feed consumes - the state store, the connection monitor, the connect-established capabilities the controller row reads its API mode from,
 * the two handle lookups the resolution layer reads a record's identity through (a hub's own handle, and one door-serving port of an Enterprise hub by the port's
 * own identity), and disposal. The capabilities member is narrowed to the one fact the row policy renders, so the port stays a statement of what the feed actually
 * consumes. The real client satisfies it as-is; a test supplies a stub wrapped around a real state store.
 */
export interface StatusFeedClient {

  accessPoint(id: string): StatusFeedHubHandle | undefined;
  readonly capabilities: Pick<AccessCapabilities, "mode">;
  readonly connection: StatusFeedConnection;
  hub(id: string): StatusFeedHubHandle | undefined;
  readonly state: StateStore;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * The connect port: how the feed reaches a controller. Defaults to the real client's connect; a test injects a factory answering a stub.
 */
export type StatusFeedConnect = (options: ConnectOptions) => Promise<StatusFeedClient>;

/**
 * Construction options for {@link AccessStatusFeed}.
 *
 * @property connect - The connect port. Defaults to the real `AccessClient.connect`.
 * @property log     - The logging adapter feed-internal and client-internal messages route through.
 * @property push    - The bridge sink that delivers a status event to the iframe. The feed guards every push on session identity internally, so the sink itself is
 * unconditional.
 */
export interface AccessStatusFeedOptions {

  connect?: StatusFeedConnect;
  log: AccessLogging;
  push: (event: StatusEvent) => void;
}

// The default connect port: the real client. Wrapped rather than referenced so the static's own this binding stays with its class.
const defaultConnect: StatusFeedConnect = (options) => AccessClient.connect(options);

/* The feed's internal frame type: every device-scoped wire event with its serialNumber tightened to the DecoratedSerial brand. The wire's own serialNumber is a
 * plain string a brand widens into freely, so the tightening here - on the emit chokepoint's parameter, and therefore on every frame composed against it - is where
 * an unbranded raw MAC address becomes a compile error before the value ever reaches the wire.
 */
type FeedFrame = Extract<StatusEvent, { serialNumber: string }> & { serialNumber: DecoratedSerial };

/* One context registry entry: a controller the browser holds a kept probe answer for, its identity members exactly as a controllers[] configuration item spells
 * them. controllerSerial is re-normalized at the context boundary, so comparing it against a view's normalized serial is exact.
 */
interface RegistryEntry {

  address: string;
  controllerSerial?: DecoratedSerial;
  password?: string;
  tokens?: { access: string };
  username?: string;
  verifyTls?: boolean;
}

/**
 * A view's role-labeled door-location resolution: a single-door hub fills `main`, a UA Gate may fill both, and a view with no door rows carries the empty object.
 * Computed fresh at every view establishment and immutable for the view's life - a device whose door topology changes mid-view picks the fresh resolution up at the
 * next view request, the panel's own re-request cadence.
 */
export interface ResolvedDoors {

  main?: string;
  side?: string;
}

/* What a live view is about: the view kind (the controller-as-device arm or an ordinary device), the viewed device's record identity where the state holds one, and
 * the role-labeled door resolution. This is loop wiring rather than target state - it lives on the view's closures, bounded by the same signal.
 */
interface ViewSubject {

  deviceId?: string;
  kind: "controller" | "device";
  resolvedDoors: ResolvedDoors;
}

/* The one ACTIVE target, a discriminated union over the view lifecycle's phases. The phase split is structural: the establish path holds a session before any
 * client exists, and a flat record with a required client member cannot state that phase without an unsound cast, while a nullable client member would let a stale
 * client persist under a new address - so each phase declares exactly what it holds, and the live phase alone carries the client and the view's door resolution.
 */
type StatusViewTarget =
  { address: string; phase: "connecting"; serial: DecoratedSerial; session: number; signal: AbortSignal } |
  { address: string; client: StatusFeedClient; phase: "live"; resolvedDoors: ResolvedDoors; serial: DecoratedSerial; session: number; signal: AbortSignal };

/**
 * The Access status feed: the connect-on-view adapter between the shared status protocol and a UniFi Access controller. Constructed once per custom-UI child
 * process; the browser supplies the context registry over the plugin's context route and drives views over the shared view route, and every result flows back as
 * push events through the injected sink.
 */
export class AccessStatusFeed {

  readonly #connect: StatusFeedConnect;
  readonly #log: AccessLogging;
  readonly #push: (event: StatusEvent) => void;
  #registry: Map<DecoratedSerial, RegistryEntry>;
  #sessionCounter: number;
  #target: Nullable<StatusViewTarget>;
  #viewTeardown: Nullable<AbortController>;

  constructor(options: AccessStatusFeedOptions) {

    const { connect = defaultConnect, log, push } = options;

    this.#connect = connect;
    this.#log = log;
    this.#push = push;
    this.#registry = new Map();
    this.#sessionCounter = 0;
    this.#target = null;
    this.#viewTeardown = null;
  }

  /**
   * Replace the context registry from a narrowed context request. Synchronous and total, and it never touches the active view: a serial that vanished from the
   * registry surfaces at the next view request, which is the panel's own re-request cadence.
   *
   * @param request - The narrowed context request.
   */
  public context(request: StatusContextRequest): void {

    const registry = new Map<DecoratedSerial, RegistryEntry>();

    // Rebuild wholesale, last write wins. Every incoming serial is re-normalized through serialForm at this boundary, so the registry key is mechanically the
    // hardware-id convention rather than a trust in the sender.
    for(const controller of request.controllers) {

      const entry: RegistryEntry = { address: controller.address,
        controllerSerial: (controller.controllerSerial === undefined) ? undefined : serialForm(controller.controllerSerial), password: controller.password,
        tokens: controller.tokens, username: controller.username, verifyTls: controller.verifyTls };

      for(const serial of controller.serials) {

        registry.set(serialForm(serial), entry);
      }

      // The controller-as-device serial resolves through the same registry, so a view of the console itself answers from its controller's entry.
      if(entry.controllerSerial !== undefined) {

        registry.set(entry.controllerSerial, entry);
      }
    }

    this.#registry = registry;
  }

  /**
   * Switch the live view to one device: the connect-on-view chokepoint, and the one place the target lifecycle turns over.
   *
   * The lifecycle walk, stated in one place: every view() call retires the prior target - this is the one turnover site; a context() call never does (a vanished
   * serial is caught at the next view); a connect failure and an identity rejection null the target; a superseded establish self-disposes at its next session
   * check; and disposal retires everything with no successor. No other writer exists, and the live-phase write happens in exactly one place, at establishment.
   *
   * @param serialNumber - The viewed device's serial number, in any spelling; it is normalized at this boundary.
   */
  public async view(serialNumber: string): Promise<void> {

    // The view request's serialNumber is browser-originated plain string, so it is re-normalized before the registry lookup - the registry's decorated-key rule
    // holds only if both readers enforce it.
    const serial = serialForm(serialNumber);

    // Retire the standing target, whatever branch follows: abort its signal - the observe loops and connection subscriptions die with it - and mint this call's
    // session from the only-growing counter.
    const retired = this.#target;

    this.#viewTeardown?.abort();
    this.#viewTeardown = null;
    this.#target = null;

    const session = ++this.#sessionCounter;
    const entry = this.#registry.get(serial);

    // An unknown serial: release whatever client the retired target held, answer not-found, and leave the target retired.
    if(entry === undefined) {

      if(retired?.phase === "live") {

        void this.#releaseClient(retired.client);
      }

      this.#emit({ kind: "error", reason: "not-found", serialNumber: serial, session });

      return;
    }

    // This view's own teardown: one controller whose signal bounds everything the view starts, aborted at the next turnover.
    const teardown = new AbortController();

    this.#viewTeardown = teardown;

    /* The same-controller reuse: a live client whose address matches the new serial's controller, over a connection that is not lost, is kept - the client is the
     * reuse; the resolution never is, so establishment recomputes the door resolution for the new serial before its snapshot push. A connection reading "lost" is
     * deliberately not reused, so a dead connection surfaces as a fresh connect's honest verdict rather than an eternally reused husk.
     */
    if((retired?.phase === "live") && (retired.address === entry.address) && (retired.client.connection.state !== "lost")) {

      this.#establishView({ client: retired.client, entry, serial, session, teardown });

      return;
    }

    // The fresh connect: the target holds the connecting phase - a session exists before any client does, which is what the union's phase split states.
    this.#target = { address: entry.address, phase: "connecting", serial, session, signal: teardown.signal };
    this.#emit({ kind: "connecting", serialNumber: serial, session });

    // The retired client, where one stood, was not reusable - a different controller, or a lost connection - so it is released here, after the fresh view has
    // announced itself.
    if(retired?.phase === "live") {

      void this.#releaseClient(retired.client);
    }

    // What counts as an identity the client can connect with is the plugin's own policy. A rejection is a refusal to attempt, not a thrown failure, so it answers
    // auth-missing rather than going through the error classifier.
    const identity = composeConnectIdentity({ password: entry.password, tokens: entry.tokens, username: entry.username });

    if(identity.error !== undefined) {

      this.#target = null;
      this.#viewTeardown = null;
      this.#emit({ kind: "error", reason: "auth-missing", serialNumber: serial, session });

      return;
    }

    /* Connect over the composed identity. A live feed takes the library's default refresh cadence - the member is omitted entirely rather than disabled - so the
     * refresh failsafe keeps the panel honest when the notification channel goes quiet. The composed identity is spread first so the connection facts stated here
     * cannot be overwritten by it.
     */
    let client: StatusFeedClient;

    try {

      client = await this.#connect({ ...identity.identity, host: entry.address, log: this.#log, verifyTls: entry.verifyTls === true });
    } catch(error) {

      // A superseded establish's failure is nobody's news - the successor owns the target now.
      if(session !== this.#sessionCounter) {

        return;
      }

      this.#target = null;
      this.#viewTeardown = null;
      this.#emit({ kind: "error", reason: classifyStatusError(error), serialNumber: serial, session });

      return;
    }

    // The one await boundary in the establish path re-checks the session: a superseded establish releases the client it made and emits nothing.
    if(session !== this.#sessionCounter) {

      void this.#releaseClient(client);

      return;
    }

    this.#establishView({ client, entry, serial, session, teardown });
  }

  /**
   * Retire the active view and release its client. The child process dying with the settings modal is the primary disposal - this method exists for tests and for
   * symmetry, not for a server call site. The session counter advances so an establish still in flight self-disposes at its next session check rather than
   * resurrecting a disposed feed.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    const target = this.#target;

    this.#viewTeardown?.abort();
    this.#viewTeardown = null;
    this.#target = null;
    this.#sessionCounter++;

    if(target?.phase === "live") {

      await this.#releaseClient(target.client);
    }
  }

  /* Establish the live view over a connected or kept client: the one site that writes a live-phase target. The resolution layer runs here on EVERY establishment -
   * the fresh-connect promotion and the same-controller reuse alike - so the door resolution is computed fresh for the view's serial and immutable for the view's
   * life. What follows the promotion is the view's whole running machinery: the snapshot and availability truth pushes, the per-role door loops, the device loop,
   * the controller arm, and the connection wiring, every one of it bounded by the view's signal.
   */
  #establishView(options: { client: StatusFeedClient; entry: RegistryEntry; serial: DecoratedSerial; session: number; teardown: AbortController }): void {

    const { client, entry, serial, session, teardown } = options;

    const signal = teardown.signal;
    const subject = this.#resolveView(client, entry, serial);

    this.#target = { address: entry.address, client, phase: "live", resolvedDoors: subject.resolvedDoors, serial, session, signal };

    // The last row list this view pushed, shared by the loops and the connection handlers so every diff and every re-push reads one truth.
    let lastRows = this.#composeViewRows(client, subject);

    /* The viewed device's liveness, as the feed can honestly state it. A record in state answers its own is_online. The controller-as-device and a view with no
     * record - a token-only client derives none, and a removal window has dropped one - answer through the one fact in hand: the serving connection is live at
     * establishment by construction, and the connection wiring below reports its loss.
     */
    const currentOnline = (): boolean => {

      if(subject.deviceId === undefined) {

        return true;
      }

      return deviceRecord(subject.deviceId, client.state.snapshot())?.is_online === true;
    };

    let lastOnline = currentOnline();

    // The snapshot frame speaks the full row set. Its online member is the frame grammar's fixed literal rather than a claim about the device, and encrypted is a
    // transport constant: the Access client connects over TLS exclusively, so there is no unencrypted mode to report.
    const pushSnapshot = (): void => {

      this.#emit({ encrypted: true, kind: "snapshot", online: true, rows: lastRows, serialNumber: serial, session });
    };

    // The availability frame carries the device's actual liveness; the offline arm's encrypted: false is fixed by the wire union itself, because no transport exists.
    const pushAvailability = (online: boolean): void => {

      this.#emit(online ? { encrypted: true, kind: "availability", online: true, serialNumber: serial, session } :
        { encrypted: false, kind: "availability", online: false, serialNumber: serial, session });
    };

    // The initial snapshot is immediately followed by the availability truth frame, so a device that is already offline at selection reads offline at once
    // instead of resting on a Connected label until something changes. Connection recovery repeats the same pairing further below, since state may have moved
    // while the connection was down; the row-set-changed branch coming up next pushes the snapshot alone, because a recomputed row set carries no information
    // about whether liveness itself moved.
    pushSnapshot();
    pushAvailability(lastOnline);

    /* Recompute the row list and push the delta: row frames for values that moved, or a fresh snapshot when the row set itself changed - the wire speaks full rows
     * on snapshot and id-plus-value on updates. One derivation serves the snapshot and every update, so the two speeds cannot drift apart.
     */
    const refreshRows = (): void => {

      const rows = this.#composeViewRows(client, subject);
      const sameSet = sameEntries(rows, lastRows, (row, held) => row.id === held.id);

      if(!sameSet) {

        lastRows = rows;
        pushSnapshot();

        return;
      }

      /* The per-row diff, each form compared and updated in its own vocabulary. The set check above already established that this position holds the same row id
       * as before, and one id composes in one form, so the held row's form matches - the form test on it is what lets the compiler see that too.
       */
      for(const [ index, row ] of rows.entries()) {

        const held = lastRows[index];

        if(row.kind === "choices") {

          if(!sameEntries(row.choices, (held?.kind === "choices") ? held.choices : [], sameChoice)) {

            this.#emit({ kind: "row", row: { choices: row.choices, id: row.id }, serialNumber: serial, session });
          }

          continue;
        }

        if(row.value !== ((held?.kind === "choices") ? undefined : held?.value)) {

          this.#emit({ kind: "row", row: { id: row.id, value: row.value }, serialNumber: serial, session });
        }
      }

      lastRows = rows;
    };

    // Drain one observe loop, funneling every yield through the shared recompute. Loop exit is silent - the signal aborting is the teardown, not an error - and
    // the catch keeps a store fault from escaping a fire-and-forget loop as an unhandled rejection.
    const runLoop = async (loop: AsyncIterable<unknown>): Promise<void> => {

      try {

        for await (const _value of loop) {

          refreshRows();
        }
      } catch(error) {

        this.#log.debug("A status observe loop ended unexpectedly: %s.", error);
      }
    };

    /* The door loops: one per present role, each observing its RESOLVED entry rather than the whole map. The per-entry selector gets per-door granularity for
     * free, because the reducer preserves an unchanged entry's reference while rebuilding the map - an unrelated door's change never wakes these observers. A
     * tuple-shaped selector is deliberately absent: a selector minting a fresh array every call compares unequal every time and wakes on every dispatch.
     */
    for(const role of [ "main", "side" ] as const) {

      const doorId = subject.resolvedDoors[role];

      if(doorId === undefined) {

        continue;
      }

      void runLoop(client.state.observe((state) => selectDoorStates(state).get(doorId), { signal }));
    }

    // The device loop: availability frames on liveness flips, and the row recompute for everything row-visible the record carries - the tamper reading above all.
    if(subject.deviceId !== undefined) {

      const deviceId = subject.deviceId;

      void (async (): Promise<void> => {

        try {

          for await (const record of client.state.observe((state) => deviceRecord(deviceId, state), { signal })) {

            const online = record?.is_online === true;

            if(online !== lastOnline) {

              lastOnline = online;
              pushAvailability(online);
            }

            refreshRows();
          }
        } catch(error) {

          this.#log.debug("A status device loop ended unexpectedly: %s.", error);
        }
      })();
    }

    // The controller arm: the controller document re-dispatches on refresh, so the uptime row advances on the library's refresh cadence rather than freezing at
    // the connect snapshot.
    if(subject.kind === "controller") {

      void runLoop(client.state.observe(selectController, { signal }));
    }

    /* The connection wiring goes through the monitor's purpose-built events rather than a hand-rolled read of generic state transitions. A lost controller makes the
     * device's liveness unknown, so offline is the honest render - and only the availability frame, because a state re-push would claim knowledge the feed does
     * not have. Recovery and a detected reboot both re-push the snapshot plus the truth frame, since state may have moved while the connection was down - and
     * recovered fires specifically on the return to healthy after lost, so a degraded-to-healthy wobble never triggers a spurious re-push. The subscriptions are
     * Disposable and die with the view's signal.
     */
    const repushView = (): void => {

      lastRows = this.#composeViewRows(client, subject);
      lastOnline = currentOnline();

      pushSnapshot();
      pushAvailability(lastOnline);
    };

    /* Every subscription below is wrapped, because a listener body throwing would escape into the library's emit and cost the connection's other subscribers their
     * notification. Row composition runs inside these bodies, so the throw is a real possibility rather than a theoretical one. One wrapper rather than three try
     * blocks keeps all three answering the same way, and a caught fault leaves the feed alive to serve the panel.
     */
    const guarded = (listener: () => void): (() => void) => {

      return (): void => {

        try {

          listener();
        } catch(error) {

          this.#log.error("A status connection listener did not complete: %s.", formatErrorMessage(error));
        }
      };
    };

    const subscriptions = [

      client.connection.on("controllerLost", guarded(() => {

        lastOnline = false;
        pushAvailability(false);
      })),
      client.connection.on("controllerRebooted", guarded(repushView)),
      client.connection.on("controllerRecovered", guarded(repushView))
    ];

    signal.addEventListener("abort", () => {

      for(const subscription of subscriptions) {

        subscription[Symbol.dispose]();
      }
    }, { once: true });
  }

  /* The RESOLUTION layer: resolve the viewed device's door location ids once, at view establishment, where the live client legitimately is. A hub arm resolves
   * through the handle the client answers for the record's identity - a hub's own handle, or one port of an Enterprise hub, whose doorId is that port's own door
   * by the library's construction - and that handle's doorId getter is read inside a try/catch that absorbs a ReferenceError as the removal-window shape, exactly
   * as the plugin's own guarded door-state read does: an absorbed throw resolves to no door ids, and anything else is a real fault that must surface. A UA Gate
   * resolves main and side through the shared discovery heuristic, on the hardware class alone - the panel reports device truth, never the HomeKit projection, so
   * no user preference gates the side arm here. A token-only client derives no projections and no device records, so it resolves no door ids and the door and
   * lock rows degrade to absence.
   */
  #resolveView(client: StatusFeedClient, entry: RegistryEntry, serial: DecoratedSerial): ViewSubject {

    // The controller-as-device goes through its controller's client and the row policy's controller arm serves it - no door resolution applies.
    if(serial === entry.controllerSerial) {

      return { kind: "controller", resolvedDoors: {} };
    }

    const state = client.state.snapshot();
    /* The walk is the membership statement, so a view resolves exactly the devices the plugin projects: a port's decorated serial finds that port's own record,
     * while the building-hosted Enterprise parent - which becomes no device at all - finds nothing and degrades to the recordless view below. A record whose
     * census established no hardware identity is no member either, so nothing here is ever compared against a serial composed from nothing.
     */
    let record: (AccessStateDevice & { mac: string }) | undefined;

    for(const device of membershipRecords(state)) {

      if(deviceSerial(device) === serial) {

        record = device;

        break;
      }
    }

    if(record === undefined) {

      return { kind: "device", resolvedDoors: {} };
    }

    if(record.device_type === "UGT") {

      const discovered = discoverDoorLocations({ device: record, doors: [...state.doors.values()], sideDoorEligible: true });
      const resolvedDoors: ResolvedDoors = {};

      if(discovered.mainDoorLocationId !== undefined) {

        resolvedDoors.main = discovered.mainDoorLocationId;
      }

      if(discovered.sideDoorLocationId !== undefined) {

        resolvedDoors.side = discovered.sideDoorLocationId;
      }

      return { deviceId: record.unique_id, kind: "device", resolvedDoors };
    }

    if(isHub(record)) {

      const handle = client.hub(record.unique_id) ?? client.accessPoint(record.unique_id);

      try {

        const doorId = handle?.doorId;

        return { deviceId: record.unique_id, kind: "device", resolvedDoors: (doorId === undefined) ? {} : { main: doorId } };
      } catch(error) {

        if(error instanceof ReferenceError) {

          return { deviceId: record.unique_id, kind: "device", resolvedDoors: {} };
        }

        throw error;
      }
    }

    // A reader carries no door state.
    return { deviceId: record.unique_id, kind: "device", resolvedDoors: {} };
  }

  // Compose the view's current row list: the resolution's role-labeled entries looked up against the live state, handed to the pure derivation. The two view kinds
  // build their own options literal, because each kind's arm is spelled in members the other arm does not have.
  #composeViewRows(client: StatusFeedClient, subject: ViewSubject): StatusRow[] {

    const state = client.state.snapshot();

    // The controller arm reads the API mode off the client that serves the view, which is the connection's own verified account of the legs it holds. No door
    // resolution applies to a controller view, so none of the entry lookups below run for it.
    if(subject.kind === "controller") {

      return composeStatusRows({ kind: "controller", mode: client.capabilities.mode, state });
    }

    const doorStates = selectDoorStates(state);
    const entries: ResolvedDoorEntries = {};

    if(subject.resolvedDoors.main !== undefined) {

      entries.main = { entry: doorStates.get(subject.resolvedDoors.main) };
    }

    if(subject.resolvedDoors.side !== undefined) {

      entries.side = { entry: doorStates.get(subject.resolvedDoors.side) };
    }

    return composeStatusRows({ device: (subject.deviceId === undefined) ? undefined : deviceRecord(subject.deviceId, state), entries, kind: "device", state });
  }

  /* The one emit chokepoint every frame funnels through. It stamps nothing; it enforces the wire contract's session-identity rule - the current session is the
   * counter's latest value, and the standing target, when one stands, carries that same value, so a frame from a superseded establish or a dying loop is dropped at
   * the source; and it contains the delivery, because the bridge's pushEvent can reject once the modal has closed the channel and an escaped throw here would take
   * the whole child process with it.
   */
  #emit(frame: FeedFrame): void {

    if(frame.session !== this.#sessionCounter) {

      return;
    }

    try {

      this.#push(frame);
    } catch(error) {

      this.#log.debug("A status event could not be delivered to the settings panel: %s.", error);
    }
  }

  // Release a client, containing the disposal: a failure to tear down cleanly is a diagnostic, never a fault that should escape a view switch.
  async #releaseClient(client: StatusFeedClient): Promise<void> {

    try {

      await client[Symbol.asyncDispose]();
    } catch(error) {

      this.#log.debug("A status client could not be released cleanly: %s.", error);
    }
  }
}
