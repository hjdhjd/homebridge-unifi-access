/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.d.mts: Type declarations for the settings page's kept controller answers and the controller save and removal.
 */
import type { AccessConfig, AccessConfigInterpreter, AccessIdentity, AccessProbeSuccess, AccessProbeVerdict, controllerListedElsewhere,
  isControllerListed } from "./access-config.mjs";

/**
 * What became of a coordinated write. This vocabulary belongs to the webUI framework's `commitConfig`, which publishes it as a JSDoc typedef inside a browser
 * module rather than as a type any of its declaration files exports, so there is nothing to import and the union is restated here to be read against. The two
 * outcomes that carry the failure explaining them carry it as `unknown`, because a rejected write answers with whatever the host threw.
 */
export type ControllerWriteResult = { kind: "committed" } | { error: unknown; kind: "staged" } | { error: unknown; kind: "failed" };

/**
 * One action a card has begun, as its verdict line answers it: whether the card presents the action, the paint that lands on the line only while it does and is
 * dropped otherwise, and the signal that aborts once an edit to the card's fields or a newer action on the card retires it. The card presents an action while the
 * card is open, the action has not been retired, the card still shows the population it showed when the action began, and the line is on screen.
 */
export interface ControllerAction {

  presented: () => boolean;
  render: ControllerVerdict["render"];
  signal: AbortSignal;
}

/**
 * The verdict line of the card an action acts for, exactly as the page's connection-card mount builds it: the plain paint a removal's failure lands through, the
 * retirement an edit makes, which retires any action in flight and blanks the line, and the start that blanks the line and begins an action. A save begins its
 * own action and reports through it.
 */
export interface ControllerVerdict {

  render: (options?: { detail?: string; lines?: string[]; tone?: string }) => void;
  retire: () => void;
  start: () => ControllerAction;
}

/** The part of a connection card an action reads: what the user has entered, and the verdict line an action begins on and a failure is painted on. */
export interface ControllerCard {

  values: () => AccessIdentity;
  verdict: ControllerVerdict;
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
 * What the factory answers with: the kept answers the page reads its controllers through, and the two configuration actions that write them. The save resolves to
 * the address that was written, unknown because a card's values are carried through unvalidated, or to null when nothing was written.
 */
export interface ControllerActions {

  answers: ControllerAnswers;
  removeController: (removal: { address: unknown; card: ControllerCard; macs: readonly string[] }) => Promise<void>;
  saveController: (save: { card: ControllerCard; originalAddress?: unknown }) => Promise<unknown>;
}

/** The warning a save speaks, and the first-run submit with it, when the controller refused the API token supplied beside the credentials. */
export declare const TOKEN_REFUSED_WARNING: string;

/**
 * Build the settings page's kept controller answers and the two configuration actions that write them, over the page's own reach into the browser, the host, the
 * framework, and the UI-server bridge.
 *
 * @param injected.commitConfig              - The feature-options page's coordinated write, which takes a composer of the configuration patch and the rename
 *                                             an address change declares as the sidebar keys before and after the write, and answers what became of it.
 * @param injected.controllerListedElsewhere - The rule that answers whether another configured controller already holds the address a save writes.
 * @param injected.controllerListedWarning   - The sentence a save speaks when that rule refuses it.
 * @param injected.controllerSerial          - The page's read of the serial a probe answer's controller row carries, in the spelling the runtime keys
 *                                             controller-scoped entries by.
 * @param injected.interpreters              - The page's holder for the configuration interpreters, narrowed to the two an action reads.
 * @param injected.isControllerListed        - The test that tells the composer's listed-address refusal apart from any other throw.
 * @param injected.platformConfig            - The page's read of the platform configuration it last received, or null before it has received one.
 * @param injected.probe                     - The connection validation, which answers a controller's verdict on either kind of success and null on any failure.
 * @param injected.processDeviceList         - The page's decoration of a probe's device list into the shape the framework renders from.
 * @param injected.sendStatusContext         - The page's send of its controller context to the live-status feed.
 * @param injected.toast                     - The host's toast surface, which is where a write that landed speaks, and where a save's failure or refusal speaks
 *                                             when its card does not present it.
 *
 * @returns The kept answers, the controller removal, and the controller save.
 */
export declare const makeControllerActions: (injected: {
  commitConfig: (compose: (platform: unknown) => unknown, options?: { rename?: { from: string; to: string } }) => Promise<ControllerWriteResult>;
  controllerListedElsewhere: typeof controllerListedElsewhere;
  controllerListedWarning: string;
  controllerSerial: (answer: AccessProbeSuccess) => unknown;
  interpreters: () => Promise<Pick<AccessConfigInterpreter, "withControllerRemoved" | "withControllerSaved">>;
  isControllerListed: typeof isControllerListed;
  platformConfig: () => AccessConfig | null;
  probe: (request: AccessIdentity & { action: Pick<ControllerAction, "render" | "signal"> }) => Promise<AccessProbeSuccess | null>;
  processDeviceList: (list: { address: unknown; devices: Record<string, unknown>[] }) => Record<string, unknown>[];
  sendStatusContext: () => Promise<void>;
  toast: { error: (message: string) => void; success: (message: string) => void; warning: (message: string) => void } }) => ControllerActions;
