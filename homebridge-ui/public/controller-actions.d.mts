/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.d.mts: Type declarations for the settings page's controller connection check, its kept controller answers, and the controller save and removal.
 */
import type { AccessConfig, AccessConfigInterpreter, AccessControllerList, AccessIdentity, AccessProbeSuccess, AccessProbeVerdict, classifyProbeResponse,
  hasValidIdentity, readProbeRejection } from "./access-config.mjs";
import type { CommitConfig, SaveFlow } from "homebridge-plugin-utils";

/** The host's toast surface, one function per severity a delivery can name. */
export interface HostToast {

  error: (message: string) => void;
  info: (message: string) => void;
  success: (message: string) => void;
  warning: (message: string) => void;
}

/** The sentences and the detail one connection check outcome shows, in the shape a card's line and a toast each read. */
export interface ProbeOutcome {

  detail?: string;
  lines: string[];
}

/**
 * What the connection check answers: the classified success when the controller accepted the identity, the outcome to show when it did not, or retired when the
 * action the check ran under was retired before it answered.
 */
export type ControllerProbe = { answer: AccessProbeSuccess; kind: "passed" } | { kind: "failed"; outcome: ProbeOutcome } | { kind: "retired" };

/**
 * The controller connection check: given a card's identity and the signal of the action it runs under, it answers what came of validating that identity. The page
 * builds one with makeControllerProbe and hands it to every surface that checks a connection, the controller save among them.
 */
export type ControllerProbeRequest = (request: AccessIdentity & { signal: AbortSignal }) => Promise<ControllerProbe>;

/** The part of a connection card an action reads: its save flow, what the user has entered, and the verdict line a save's outcome and a removal's failure paint on. */
export interface ControllerCard {

  flow: SaveFlow<AccessConfig>;
  values: () => AccessIdentity;
  verdict: { render: (options?: { detail?: string; lines?: string[]; tone?: string }) => void };
}

/**
 * The kept controller answers as a reader may use them. Each is declared as a property carrying a function rather than as a method, which is what the module
 * actually builds - an object of arrow functions closed over the private map and its generation - so a consumer is free to read one off the handle and call it on
 * its own. `keep` takes the whole verdict union rather than a success, because the site that fills an answer hands over whatever the probe classification answered,
 * a failure included, and the rule that refuses one lives behind this member.
 */
export interface ControllerAnswers {

  clear: () => void;
  generation: () => number;
  get: (address: unknown) => AccessProbeSuccess | undefined;
  keep: (fill: { address: unknown; answer: AccessProbeVerdict; generation: number }) => boolean;
}

/**
 * What the factory answers with: the kept answers the page reads its controllers through, and the controller save and the controller removal that write them. The save
 * resolves to the address that was written, unknown because a card's values are carried through unvalidated, or to null when nothing was written.
 */
export interface ControllerActions {

  answers: ControllerAnswers;
  removeController: (removal: { address: unknown; card: ControllerCard; macs: readonly string[] }) => Promise<void>;
  saveController: (save: { card: ControllerCard; originalAddress?: unknown }) => Promise<unknown>;
}

/** The warning a save speaks, and the first-run submit with it, when the controller refused the API token supplied beside the credentials. */
export declare const TOKEN_REFUSED_WARNING: string;

/**
 * Build the settings page's kept controller answers and the controller save and the controller removal that write them, over the page's own reach into the browser, the
 * host, the framework, and the UI-server bridge.
 *
 * @param injected.commitConfig              - The feature-options page's coordinated write, which takes a composer and answers what became of it. A removal
 *                                             writes through it; a save writes through the save flow its card carries, which the page builds over the same write
 *                                             and which hands it the rename an address change declares.
 * @param injected.controllerListedElsewhere - The rule that answers whether another configured controller already holds the address a save writes.
 * @param injected.controllerListedWarning   - The sentence a save speaks when that rule, or the composer asking it again, refuses the save.
 * @param injected.controllerSerial          - The page's read of the serial a probe answer's controller row carries, in the spelling the runtime keys
 *                                             controller-scoped entries by.
 * @param injected.errorMessage              - homebridge-plugin-utils' reading of the message a thrown value or a failed write's error carries.
 * @param injected.interpreters              - The page's holder for the configuration interpreters that need the served catalog.
 * @param injected.platformConfig            - The page's read of the platform configuration it last received, which the listed-address check is asked of.
 * @param injected.processDeviceList         - The page's decoration of a probe's device list into the shape the framework renders from.
 * @param injected.requestControllerProbe    - The connection check, which answers whether the controller accepted an identity and reports nothing itself.
 * @param injected.sendStatusContext         - The page's send of its controller context to the live-status feed.
 * @param injected.toast                     - The host's toast surface, which is where a write that landed speaks, and where a save's failure speaks when no
 *                                             press delivery is left to carry it.
 *
 * @returns The kept answers, the controller removal, and the controller save.
 */
export declare const makeControllerActions: (injected: {
  commitConfig: CommitConfig<AccessConfig>;
  controllerListedElsewhere: AccessControllerList["controllerListedElsewhere"];
  controllerListedWarning: string;
  controllerSerial: (answer: AccessProbeSuccess) => unknown;
  errorMessage: (err: unknown) => string;
  interpreters: () => Promise<Pick<AccessConfigInterpreter, "withControllerRemoved" | "withControllerSaved">>;
  platformConfig: () => AccessConfig | null;
  processDeviceList: (list: { address: unknown; devices: Record<string, unknown>[] }) => Record<string, unknown>[];
  requestControllerProbe: ControllerProbeRequest;
  sendStatusContext: () => Promise<void>;
  toast: Pick<HostToast, "error" | "success" | "warning">; }) => ControllerActions;

/**
 * Build the controller connection check over the UI-server bridge's request, the framework's deadline, the probe classifier, the rejection's reading, and the
 * identity rule. A check that outlasts the deadline answers as a request that threw, with the deadline's own sentence as its detail, and a check whose signal
 * aborts settles at once.
 *
 * @param injected.classifyProbeResponse - The one reading of the UI server's probe answer, which a fulfilled request's outcome is composed from.
 * @param injected.deadline              - The bound on one check, in seconds.
 * @param injected.hasValidIdentity      - The rule that answers whether an identity is one the plugin can connect with.
 * @param injected.readProbeRejection    - The one reading of a rejected request, which a rejection's detail is composed from.
 * @param injected.request               - The UI-server bridge's request, taking a path and a payload.
 * @param injected.withDeadline          - The framework's deadline, which races an await against the bound and the caller's signal.
 *
 * @returns The connection check.
 */
export declare const makeControllerProbe: (injected: {
  classifyProbeResponse: typeof classifyProbeResponse;
  deadline: number;
  hasValidIdentity: typeof hasValidIdentity;
  readProbeRejection: typeof readProbeRejection;
  request: (path: string, payload: unknown) => Promise<unknown>;
  withDeadline: (options: { promise: Promise<unknown>; seconds: number; signal?: AbortSignal }) => Promise<unknown>; }) => ControllerProbeRequest;
