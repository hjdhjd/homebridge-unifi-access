/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.d.mts: Type declarations for the settings page's kept controller answers and the controller save and removal.
 */
import type { AccessConfigInterpreter, AccessIdentity, AccessProbeSuccess, AccessProbeVerdict } from "./access-config.mjs";

/**
 * What became of a coordinated write. This vocabulary belongs to the webUI framework's `commitConfig`, which publishes it as a JSDoc typedef inside a browser
 * module rather than as a type any of its declaration files exports, so there is nothing to import and the union is restated here to be read against. The two
 * outcomes that carry the failure explaining them carry it as `unknown`, because a rejected write answers with whatever the host threw.
 */
export type ControllerWriteResult = { kind: "committed" } | { error: unknown; kind: "staged" } | { error: unknown; kind: "failed" } | { kind: "superseded" };

/**
 * The verdict line of the card an action acts for, exactly as the page's connection-card mount builds it: the retirement that blanks the line and answers the
 * generation the card is on, the test of whether a validation is still the newest one that card issued, and the paint itself. An action hands the whole surface to
 * the probe and paints a failure on it.
 */
export interface ControllerVerdict {

  invalidate: () => number;
  isCurrent: (mark: number) => boolean;
  render: (options?: { detail?: string; lines?: string[]; tone?: string }) => void;
}

/** The part of a connection card an action reads: what the user has entered, and the verdict line a failure is painted on. */
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

/**
 * Build the settings page's kept controller answers and the two configuration actions that write them, over the page's own reach into the browser, the host, the
 * framework, and the UI-server bridge.
 *
 * @param injected.commitConfig      - The feature-options page's coordinated write, which takes a composer of the configuration patch and answers what became of it.
 * @param injected.interpreters      - The page's holder for the configuration interpreters, narrowed to the two an action reads.
 * @param injected.probe             - The connection validation, which answers a controller's verdict on either kind of success and null on any failure.
 * @param injected.processDeviceList - The page's decoration of a probe's device list into the shape the framework renders from.
 * @param injected.selectController  - The page's selection of a controller's own sidebar entry, by the address the configuration records.
 * @param injected.sendStatusContext - The page's send of its controller context to the live-status feed.
 * @param injected.toast             - The host's toast surface, which is where a write that landed speaks.
 *
 * @returns The kept answers, the controller removal, and the controller save.
 */
export declare const makeControllerActions: (injected: { commitConfig: (compose: (platform: unknown) => unknown) => Promise<ControllerWriteResult>;
  interpreters: () => Promise<Pick<AccessConfigInterpreter, "withControllerRemoved" | "withControllerSaved">>;
  probe: (request: AccessIdentity & { verdict: ControllerVerdict }) => Promise<AccessProbeSuccess | null>;
  processDeviceList: (list: { address: unknown; devices: Record<string, unknown>[] }) => Record<string, unknown>[]; selectController: (address: unknown) => void;
  sendStatusContext: () => Promise<void>;
  toast: { success: (message: string) => void; warning: (message: string) => void } }) => ControllerActions;
