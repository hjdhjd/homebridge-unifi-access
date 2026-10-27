/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.test.ts: The settings page's controller connection check, its kept controller answers, and the controller save and removal that write them,
 * driven through the real save flow and recording doubles for every other reach the module makes outside itself.
 *
 * What these arms prove is the part of a save and a removal no type can state: that each outcome speaks in exactly its sentence, on exactly its channel, and
 * exactly once; that the seed a save makes lands BEFORE its write and only once its composer has a patch; that a press whose write did not land puts back what
 * its own seed replaced and nothing else; that a send follows every save and removal that lands and every put-back of a seed, and follows nothing else; and that a
 * press during a write starts nothing, because the save writes through its card's flow. A swapped toast severity, a put-back that restores the wrong address, a
 * dropped generation bump, a rename declared on a save that changed no address, or missing from one that did, and a listed-address refusal spoken as a failure,
 * or a failure spoken as that refusal, each redden an arm here.
 *
 * Every arm that judges what a save or a removal says asserts the exact toast list, the exact verdict list, the exact send count, and the exact rename list, so it
 * proves the absence of the other outcomes as precisely as the presence of its own. A press rejected before any check runs is the exception: its toast ends with
 * whatever the press rejected with, which the stand does not word, so that arm reads the toast by the save's own sentence. The arms whose subject is what an
 * interpreter is handed, a serial read, the generation, the kept answers' own rules, or the connection check assert that subject alone. The two addresses differ,
 * their device serials differ, and the answer already held under an address differs from the one the check returns, so a restore that puts back the wrong thing
 * cannot coincide with one that puts back the right thing.
 *
 * The card's save flow is the framework's own, imported from the package root, which is compiled from the same source as the page's browser module, so the rules
 * a press runs under are the ones the page runs under. The arm that reads a control disabled during a write reads the flow's handling of the control the stand
 * built it over, and says nothing about which control the page builds it over. The write double refuses a declared rename whose keys are not strings, as the
 * framework refuses one ahead of its queue, so a rename built from a value that is no sidebar key fails the save it reaches rather than recording as though the
 * page had accepted it.
 *
 * The connection check's rows run the real probe classifier, identity rule, and rejection reading behind a request double, so each failure's sentences and detail
 * are read where the check composes them.
 */
import type { AccessConfig, AccessConfigPatch, AccessIdentity, AccessProbeSuccess, AccessProbeVerdict } from "./access-config.ts";
import type { CommitConfig, CommitConfigResult, SaveAction } from "homebridge-plugin-utils";
import type { ControllerActions, ControllerCard, ControllerProbe } from "./controller-actions.ts";
import { classifyProbeResponse, hasValidIdentity, readProbeRejection } from "./access-config.ts";
import { makeControllerActions, makeControllerProbe } from "./controller-actions.ts";
import assert from "node:assert/strict";
import { createSaveFlow } from "homebridge-plugin-utils";
import test from "node:test";

// The address a save writes and a removal drops, and the address an address-edit save replaces. They differ so a put-back that restores one in place of the other
// reads as the failure it is.
const ADDRESS = "10.0.0.1";
const ORIGINAL_ADDRESS = "10.0.0.2";

// The device serials each address answers with, distinct per address for the same reason the addresses are.
const PROBE_SERIAL = "AABBCCDDEEFF";
const PRIOR_SERIALS: Record<string, string> = { "10.0.0.1": "112233445566", "10.0.0.2": "0123456789AB" };

/* The messages the fixtures carry. A real success answers an empty message, so these strings are a fixture choice rather than a copy of production: telling this
 * save's own answer apart from the answer that was already held is exactly what the seed arm has to do.
 */
const PROBE_MESSAGE = "the answer this save's own validation received";
const PRIOR_MESSAGE = "the answer this session was already holding";

// What the device-list fake stamps onto every record it is handed, so a seed that skipped the processing is told apart from one that did not.
const PROCESSED = "processed-by-the-page";

// The identity the card answers with, in the shape a controllers[] item carries.
const IDENTITY: AccessIdentity = { address: ADDRESS, password: "correct horse battery", tokens: { access: "an-access-console-api-token" },
  username: "access@example.com", verifyTls: true };

// The scoping identities a swept removal offers to strip settings for.
const MACS = [ "AABBCCDDEEFF", "112233445566" ];

// The platform entry the write double hands the composer, and the patches each interpreter composes from it. Each is a sentinel: what matters is that exactly
// this object reached the interpreter and exactly that patch came back out of the composer.
const PLATFORM: AccessConfig = { controllers: [{ name: "the configuration the write composes against" }], options: [] };
const SAVE_PATCH = { controllers: [{ address: ADDRESS }] };
const REMOVE_PATCH = { controllers: [] };

// What a reader is told, transcribed from the module rather than referenced, so a sentence that drifts by a character in either place reddens an arm.
const SAVED_CONNECTED = "This controller has been saved.";
const SAVED_TOKEN_ONLY = "This controller has been saved. Its API token is valid. Its doors and devices appear in HomeKit; adding a local user's username and " +
  "password lets the plugin read the controller's own document as well.";
const SAVED_TOKEN_REFUSED = "This controller has been saved, but it did not accept the API token. The plugin will use the local user's username and password " +
  "alone; webhooks and the doorbell trigger need an API token the controller accepts.";
const SAVED_STAGED = "This controller has been saved, but Homebridge could not write the configuration file. Save the plugin's settings to keep the change.";
const REMOVED_STAGED = "This controller has been removed, but Homebridge could not write the configuration file. Save the plugin's settings to keep the change.";
const SAVE_FAILURE_LINE = "Unable to save this controller.";
const REMOVE_FAILURE_LINE = "Unable to remove this controller.";
const LISTED_REFUSAL = "This controller is already listed.";

// What a refused write carries, worded unlike any sentence the module speaks, so a delivery that dropped the detail or spoke its own cannot pass.
const WRITE_FAILURE = "the host refused the write";

// The configuration the page last received, which the listed-address check is asked of. It is a sentinel distinct from the one the write composes against, so
// an early check asked of the write's configuration rather than the page's reads as the mistake it is.
const PAGE_CONFIG = { controllers: [{ address: ORIGINAL_ADDRESS, name: "the configuration the page last received" }] };

/* A failure the connection check answers for a controller it could not reach, in the headline, guidance, and detail it answers one with; the verdict a save paints
 * for it, in the error tone; and the one message the error toast carries for it when the card does not present the save.
 */
const CHECK_OUTCOME = { detail: "the controller refused this sign-in", lines: [ "Unable to connect to the UniFi Access controller.",
  "Please check your controller address and sign-in details." ] };
const CHECK_FAILED: ControllerProbe = { kind: "failed", outcome: CHECK_OUTCOME };
const CHECK_FAILURE: RenderedVerdict = { ...CHECK_OUTCOME, tone: "text-danger" };
const CHECK_FAILURE_TOAST = "Unable to connect to the UniFi Access controller. Please check your controller address and sign-in details. the controller refused " +
  "this sign-in";

// What the interpreter holder throws when an arm asks it to.
const INTERPRETERS_FAILURE = "the served catalog could not be read";

/* What the interpreter holder rejects with when an arm asks it to stand for the UI server refusing the catalog read: the plain object the bridge rejects with, which
 * carries a message and is no error, and which the catalog read rethrows unchanged.
 */
const CATALOG_REFUSAL = "The plugin's UI server could not read the option catalog.";
const CATALOG_REJECTION: unknown = { message: CATALOG_REFUSAL };

/* homebridge-plugin-utils' errorMessage, which the page hands the actions, restated as the stand's double because Node has no package route to the browser module
 * that ships it: a thrown value's own message wherever it carries one, and its text otherwise.
 *
 * @param err - What was thrown, or what a failed write carried as its error.
 *
 * @returns The message a failure paints.
 */
function errorText(err: unknown): string {

  return String((err as { message?: unknown } | null | undefined)?.message ?? err);
}

// What the device-list decoration throws when an arm asks it to.
const PROCESSING_FAILURE = "the device list could not be processed";

// What befalls the card while a save is in flight: it closes, an edit to its fields retires the action on it, it leaves the screen, or it is re-populated.
type CardEvent = "close" | "edit" | "hide" | "repopulate";

// What a verdict render was handed, which is the whole of what a failure says on the card.
interface RenderedVerdict {

  detail?: string;
  lines?: string[];
  tone?: string;
}

// One interpreter run: the configuration it was handed, which of the two it was, and the payload it was asked to compose from.
interface InterpreterCall {

  config: unknown;
  kind: "removed" | "saved";
  payload: unknown;
}

// One ask of the listed-address rule: the configuration it was asked of and the save it was asked about.
interface ListedCheck {

  config: unknown;
  save: unknown;
}

// One connection check request, as its caller composed it: the card's identity and the signal of the action the check runs under.
interface ProbeRequest extends AccessIdentity {

  signal: AbortSignal;
}

// One toast, by the channel it was raised on and the message it carried.
interface Toast {

  channel: "error" | "info" | "success" | "warning";
  text: string;
}

// What the kept answers looked like at the moment the write ran, which is where the seed's placement and the generation bump's placement are read from.
interface WriteObservation {

  atAddress: AccessProbeSuccess | undefined;
  atOriginal: AccessProbeSuccess | undefined;
  generation: number;
}

/* One step of the write double's script. `natural` answers unchanged when the composer answered null and committed otherwise, which is what the page's write
 * does when the host takes it, and no other step answers unchanged; `unrecognized` answers a kind the page does not know, after calling the composer;
 * `failedWithString` answers failed after calling the composer, carrying a string rather than an error as its error; the others answer the kind they name, after
 * calling the composer unless the name says the step answers before it.
 */
type WriteStep = "committed" | "failed" | "failedBeforeCompose" | "failedWithString" | "natural" | "rejected" | "rejectedBeforeCompose" | "staged" | "unrecognized";

// What an arm stands the module up over. Every member has a default, so an arm names only what it is about.
interface StandOptions {

  catalogRejected?: boolean;
  composerRefuses?: boolean;
  composerThrows?: Error;
  duringCheck?: CardEvent;
  duringListedCheck?: CardEvent;
  duringWrite?: CardEvent;
  hold?: Promise<void>;
  interpretersThrow?: boolean;
  listed?: boolean;
  malformedStarter?: boolean;
  onWrite?: () => void;
  probe?: ControllerProbe;
  processingThrows?: boolean;
  retireDuringCatalogRead?: boolean;
  writes?: WriteStep[];
}

// A stood-up set of actions and everything the doubles beneath them recorded.
interface Stand {

  actions: ControllerActions;
  card: ControllerCard;
  catalogReads: () => number;
  composed: unknown[];
  control: { disabled: boolean };
  // Every value the actions read a failure's message from, in the order they read it, through the error text rule the page hands them.
  errorReads: unknown[];
  interpreterCalls: InterpreterCall[];
  listedChecks: ListedCheck[];
  probeCalls: ProbeRequest[];
  renames: unknown[];
  renders: RenderedVerdict[];
  retire: () => void;
  seenDuringWrite: WriteObservation[];
  sends: () => number;
  serialReads: AccessProbeSuccess[];
  starts: () => number;
  toasts: Toast[];
}

/* One device record as the UI server decorates it, fresh per call so the stamping one arm does cannot reach another arm's fixture.
 *
 * @param serial - The decorated serial this record answers by.
 *
 * @returns The record.
 */
function device(serial: string): Record<string, unknown> {

  return { serialNumber: serial };
}

/* The answer this save's own validation receives.
 *
 * @param kind         - Whether the controller answered with credentials or with an API token alone.
 * @param tokenRefused - Whether the controller refused the API token beside the credentials.
 *
 * @returns The probe's answer.
 */
function probeAnswer(kind: "connected" | "token-only", tokenRefused = false): AccessProbeSuccess {

  return { devices: [device(PROBE_SERIAL)], kind, message: PROBE_MESSAGE, tokenRefused };
}

/* What the connection check answers when the controller accepted this save's identity, carrying the probe's answer.
 *
 * @param kind         - Whether the controller answered with credentials or with an API token alone.
 * @param tokenRefused - Whether the controller refused the API token beside the credentials.
 *
 * @returns The connection check's answer.
 */
function passed(kind: "connected" | "token-only", tokenRefused = false): ControllerProbe {

  return { answer: probeAnswer(kind, tokenRefused), kind: "passed" };
}

/* The answer this session was already holding for an address, deliberately unlike anything a probe here returns.
 *
 * @param address - The address the answer is held under.
 *
 * @returns The answer.
 */
function priorAt(address: string): AccessProbeSuccess {

  return { devices: [device(PRIOR_SERIALS[address] ?? address)], kind: "connected", message: PRIOR_MESSAGE, tokenRefused: false };
}

/* A controller that could not be reached, which is the one answer the keep rule refuses outright.
 *
 * @returns The failure verdict.
 */
function failedAnswer(): AccessProbeVerdict {

  return { devices: [], headline: "Unable to connect", kind: "error", message: "the controller refused this sign-in" };
}

/* Stand up the actions over the real save flow and recording doubles for every other reach they make outside themselves.
 *
 * The card's starter holds the page card's rule in miniature: each start retires the action before it, exactly as the card's guard does, and an action is
 * presented while the card is open, the action stands, the card shows the population the action began under, and the card is on screen. The write double records
 * the rename it was handed, calls the composer against the platform the write composes over, records what the kept answers held once the composer had run, and
 * answers what the arm's script names.
 *
 * @param options.catalogRejected         - Whether the interpreter holder rejects with the plain object the bridge rejects with, which is how the UI server's
 *                                          refusal of the catalog read reaches a save.
 * @param options.composerRefuses         - Whether the save interpreter answers null, which is how it refuses an address another controller holds.
 * @param options.composerThrows          - What the save interpreter throws rather than composing, which rejects the press.
 * @param options.duringCheck             - What befalls the card while the connection check is in flight, ahead of anything the check answers.
 * @param options.duringListedCheck       - What befalls the card while the listed-address rule is asked, ahead of the connection check.
 * @param options.duringWrite             - What befalls the card while the write is in flight, once the composer has run.
 * @param options.hold                    - What the write awaits once it has composed, so an arm can press again while the write is in flight.
 * @param options.interpretersThrow       - Whether the interpreter holder rejects rather than answering.
 * @param options.listed                  - Whether the listed-address rule answers that another configured controller already holds the written address.
 * @param options.malformedStarter        - Whether the card's starter answers without the members the flow reads, which rejects a press before any check runs.
 * @param options.onWrite                 - What runs at the moment of the write, once the composer has run.
 * @param options.probe                   - What the connection check answers, which an arm that never reaches the check leaves out.
 * @param options.processingThrows        - Whether the device-list decoration throws rather than answering, which reaches the save inside its composer's seed.
 * @param options.retireDuringCatalogRead - Whether a newer act on the card retires the press while its catalog read is in flight.
 * @param options.writes                  - The write double's script, one step per write, the natural step answering once the script runs out.
 *
 * @returns The actions and every recorder beneath them.
 */
function stand({ catalogRejected = false, composerRefuses = false, composerThrows, duringCheck, duringListedCheck, duringWrite, hold = Promise.resolve(),
  interpretersThrow = false, listed = false, malformedStarter = false, onWrite, probe, processingThrows = false, retireDuringCatalogRead = false,
  writes = [] }: StandOptions = {}): Stand {

  const composed: unknown[] = [];
  const control = { disabled: false };
  const errorReads: unknown[] = [];
  const interpreterCalls: InterpreterCall[] = [];
  const listedChecks: ListedCheck[] = [];
  const probeCalls: ProbeRequest[] = [];
  const renames: unknown[] = [];
  const renders: RenderedVerdict[] = [];
  const script = [...writes];
  const seenDuringWrite: WriteObservation[] = [];
  const serialReads: AccessProbeSuccess[] = [];
  const toasts: Toast[] = [];
  let catalogReads = 0;
  let closed = false;
  let current: AbortController | null = null;
  let population = 0;
  let sends = 0;
  let starts = 0;
  let visible = true;

  // One recorder serves the flow and the actions alike, so a delivery the flow raises and a toast the actions raise land in the one list an arm asserts whole.
  const toast = {

    error: (text: string): void => {

      toasts.push({ channel: "error", text });
    },
    info: (text: string): void => {

      toasts.push({ channel: "info", text });
    },
    success: (text: string): void => {

      toasts.push({ channel: "success", text });
    },
    warning: (text: string): void => {

      toasts.push({ channel: "warning", text });
    }
  };

  /* The card's starter, holding the page card's rules in miniature: a start retires the action before it, an edit retires whatever is current, a re-population
   * moves the card on without retiring anything, and an action is presented while the card is open, the action stands, the card shows the population the action
   * began under, and the card is on screen.
   */
  const start = (): SaveAction => {

    starts++;
    current?.abort();
    current = new AbortController();

    // A starter that answers without the members the flow reads is how an arm rejects a press before any check runs.
    if(malformedStarter) {

      return {} as SaveAction;
    }

    const { signal } = current;
    const startedUnder = population;

    return { presented: (): boolean => !closed && !signal.aborted && (population === startedUnder) && visible, signal };
  };

  // A newer act on the card retiring the action in flight, which is what an edit to the card's fields does.
  const retire = (): void => {

    current?.abort();
  };

  // Each thing that can befall the card, as the page's own card meets it.
  const befall: Record<CardEvent, () => void> = {

    close: () => {

      closed = true;
    },
    edit: retire,
    hide: () => {

      visible = false;
    },
    repopulate: () => {

      population++;
    }
  };

  const commit: CommitConfig<AccessConfig> = async (compose, options) => {

    // The rename this call declared, read as the framework reads it: absent declares none, and anything present whose from or to is not a string is refused
    // before anything else happens, so nothing is composed or written for it.
    const rename: unknown = options?.rename;

    if(rename !== undefined) {

      if((typeof rename !== "object") || (rename === null) || !("from" in rename) || !("to" in rename) || (typeof rename.from !== "string") ||
        (typeof rename.to !== "string")) {

        throw new TypeError("A declared rename names the controller's previous and current sidebar keys, each a string.");
      }

      renames.push(rename);
    }

    const step = script.shift() ?? "natural";

    if(step === "failedBeforeCompose") {

      return { error: new Error(WRITE_FAILURE), kind: "failed" };
    }

    if(step === "rejectedBeforeCompose") {

      throw new Error(WRITE_FAILURE);
    }

    const patch = compose(PLATFORM);

    // What the answers held, and which generation they were on, at the moment the write ran, read once the composer has run, which is where the page's own write
    // runs it. This is what places the seed and the bump ahead of the write rather than behind it, which no assertion made after the save resolves could tell
    // apart.
    composed.push(patch);
    seenDuringWrite.push({ atAddress: actions.answers.get(ADDRESS), atOriginal: actions.answers.get(ORIGINAL_ADDRESS),
      generation: actions.answers.generation() });
    onWrite?.();

    if(duringWrite) {

      befall[duringWrite]();
    }

    await hold;

    switch(step) {

      case "committed": {

        return { kind: "committed" };
      }

      case "failed": {

        return { error: new Error(WRITE_FAILURE), kind: "failed" };
      }

      case "failedWithString": {

        return { error: "the host answered in a shape it never writes", kind: "failed" };
      }

      case "rejected": {

        throw new Error(WRITE_FAILURE);
      }

      case "staged": {

        return { error: new Error("the disk refused the save"), kind: "staged" };
      }

      // A kind this page does not know, which the real write never answers, cast past the union it stands outside of.
      case "unrecognized": {

        return { kind: "an outcome the page does not know" } as unknown as CommitConfigResult;
      }

      default: {

        return (patch === null) ? { kind: "unchanged" } : { kind: "committed" };
      }
    }
  };

  const card: ControllerCard = {

    flow: createSaveFlow({ commit, control, start, toast }),
    values: () => ({ ...IDENTITY }),
    verdict: {

      render: (options = {}): void => {

        renders.push(options);
      }
    }
  };

  const actions: ControllerActions = makeControllerActions({

    commitConfig: commit,
    controllerListedElsewhere: (config, save) => {

      // Each ask is kept in a list of its own, so the exact interpreter lists other arms assert stay untouched by an ask every save makes.
      listedChecks.push({ config, save });

      if(duringListedCheck) {

        befall[duringListedCheck]();
      }

      return listed;
    },
    controllerListedWarning: LISTED_REFUSAL,
    controllerSerial: (answer) => {

      // Which answers the read was handed is what places it before the seed rather than after it, so each one is kept.
      serialReads.push(answer);

      return answer.devices[0]?.["serialNumber"];
    },
    errorMessage: (err) => {

      errorReads.push(err);

      return errorText(err);
    },
    interpreters: async () => {

      // Every read of the catalog is counted, so an arm can show that a check which answered early never reached the read.
      catalogReads++;

      if(interpretersThrow) {

        throw new Error(INTERPRETERS_FAILURE);
      }

      if(catalogRejected) {

        throw CATALOG_REJECTION;
      }

      // A newer act on the card retiring the press while its catalog read is in flight, which the flow reads once the check answers.
      if(retireDuringCatalogRead) {

        retire();
      }

      return {

        withControllerRemoved: (config, removal): AccessConfigPatch => {

          interpreterCalls.push({ config, kind: "removed", payload: removal });

          return REMOVE_PATCH;
        },
        withControllerSaved: (config, controller): AccessConfigPatch | null => {

          interpreterCalls.push({ config, kind: "saved", payload: controller });

          if(composerThrows) {

            throw composerThrows;
          }

          return composerRefuses ? null : SAVE_PATCH;
        }
      };
    },
    platformConfig: () => PAGE_CONFIG,
    processDeviceList: ({ address, devices }) => {

      // A decoration that cannot read the list it is handed throws, which the save meets inside its composer's seed.
      if(processingThrows) {

        throw new Error(PROCESSING_FAILURE);
      }

      for(const record of devices) {

        record["processed"] = PROCESSED;
        record["processedAddress"] = address;
      }

      return devices;
    },
    requestControllerProbe: async (request) => {

      // The request the save composed, kept so an arm can read the identity it carried and the signal it ran under.
      probeCalls.push(request);

      // What befalls the card lands here, between the request and its answer, which is where the page's own check meets it. The page's check answers retired for
      // a request its card retired before it answers anything else, and so does this one.
      if(duringCheck) {

        befall[duringCheck]();
      }

      if(request.signal.aborted) {

        return { kind: "retired" };
      }

      assert.ok(probe, "an arm that reaches the connection check scripts what it answers");

      return probe;
    },
    sendStatusContext: async () => {

      sends++;
    },
    toast
  });

  return { actions, card, catalogReads: (): number => catalogReads, composed, control, errorReads, interpreterCalls, listedChecks, probeCalls, renames, renders,
    retire, seenDuringWrite, sends: (): number => sends, serialReads, starts: (): number => starts, toasts };
}

/* Put an answer into the kept answers the only way a reader can, which exercises the keep rule on the way in.
 *
 * @param stood   - The stand holding the answers.
 * @param address - The address to hold it under.
 * @param answer  - The answer to hold.
 */
function seed(stood: Stand, address: string, answer: AccessProbeVerdict): void {

  assert.equal(stood.actions.answers.keep({ address, answer, generation: stood.actions.answers.generation() }), true,
    "a fresh answer offered at the current generation should be kept");
}

/* Everything an operation said and did, asserted exactly. The lists default to empty, so an arm that states only its own outcome is also stating that none of the
 * other outcomes occurred.
 *
 * @param expected.label       - A prefix for each assertion message, for arms that run more than one case.
 * @param expected.renames     - The renames the write declared, in order.
 * @param expected.renders     - The verdicts painted on the card, in order.
 * @param expected.sends       - How many times the status context was sent.
 * @param expected.stood       - The stand to read.
 * @param expected.toasts      - The toasts spoken, in order.
 */
function assertSpoke({ label = "", renames = [], renders = [], sends, stood, toasts = [] }: { label?: string; renames?: unknown[];
  renders?: RenderedVerdict[]; sends: number; stood: Stand; toasts?: Toast[]; }): void {

  assert.deepEqual(stood.toasts, toasts, label + "the toasts spoken");
  assert.deepEqual(stood.renders, renders, label + "the verdicts painted on the card");
  assert.equal(stood.sends(), sends, label + "the status-context sends made");
  assert.deepEqual(stood.renames, renames, label + "the renames the write declared");
}

test("s1: a save whose connection check fails writes nothing, touches no answer, and speaks the failure once", async () => {

  const stood = stand({ probe: CHECK_FAILED });
  const before = stood.actions.answers.generation();

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "nothing is held for the address the card names");
  assert.equal(stood.actions.answers.generation(), before, "the generation does not move");
  assert.deepEqual(stood.interpreterCalls, [], "no interpreter runs");
  assert.deepEqual(stood.composed, [], "nothing is composed");
  assert.equal(stood.probeCalls.length, 1, "the check ran once, and its answer is the failure");
  assertSpoke({ renders: [CHECK_FAILURE], sends: 0, stood });
});

test("s2: a committed save of a connected controller speaks its plain sentence, sends once, and answers the address", async () => {

  const stood = stand({ probe: passed("connected") });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, "the save answers the address it wrote");

  // The card's own retirement, made once the save has answered, aborts the signal the check was handed. That is what shows the check ran as this card's newest
  // action rather than on a signal of the save's own making.
  stood.retire();

  assert.deepEqual(stood.probeCalls.map(({ signal, ...identity }) => ({ identity, retiredByTheCard: signal.aborted })),
    [{ identity: IDENTITY, retiredByTheCard: true }], "the probe received the card's identity and a check running as the card's own newest action");
  assertSpoke({ sends: 1, stood, toasts: [{ channel: "success", text: SAVED_CONNECTED }] });
});

test("s3a: a committed save of a token-only controller speaks the sentence that says what credentials would add", async () => {

  const stood = stand({ probe: passed("token-only") });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, "the save answers the address it wrote");
  assertSpoke({ sends: 1, stood, toasts: [{ channel: "success", text: SAVED_TOKEN_ONLY }] });
});

test("s3b: a committed save of a controller that refused its API token warns that the plugin runs on the credentials alone", async () => {

  const stood = stand({ probe: passed("connected", true) });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, "the save answers the address it wrote");
  assertSpoke({ sends: 1, stood, toasts: [{ channel: "warning", text: SAVED_TOKEN_REFUSED }] });
});

test("s4: an address edit drops the original address before the write and declares the rename on the write", async () => {

  const stood = stand({ probe: passed("connected") });

  seed(stood, ORIGINAL_ADDRESS, priorAt(ORIGINAL_ADDRESS));

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), ADDRESS, "the save answers the address it wrote");
  assert.deepEqual(stood.seenDuringWrite.map((seen) => seen.atOriginal), [undefined], "the original address is already empty when the write runs");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), undefined, "and it is still empty once the save has landed");
  assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], sends: 1, stood, toasts: [{ channel: "success", text: SAVED_CONNECTED }] });
});

test("s5: a staged save warns that the file was not written, sends once, and declares an edited address's rename on its write", async () => {

  const stood = stand({ probe: passed("connected"), writes: ["staged"] });

  seed(stood, ORIGINAL_ADDRESS, priorAt(ORIGINAL_ADDRESS));

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), ADDRESS, "the save answers the address it wrote");
  assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], sends: 1, stood, toasts: [{ channel: "warning", text: SAVED_STAGED }] });
});

test("s6a: a failed save restores what each address held and paints an Error's own message", async () => {

  const stood = stand({ probe: passed("connected"), writes: ["failed"] });
  const priorAtAddress = priorAt(ADDRESS);
  const priorAtOriginal = priorAt(ORIGINAL_ADDRESS);

  seed(stood, ADDRESS, priorAtAddress);
  seed(stood, ORIGINAL_ADDRESS, priorAtOriginal);

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), null, "the save answers null");
  assert.equal(stood.actions.answers.get(ADDRESS), priorAtAddress, "the address the save wrote holds the very answer it held before");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), priorAtOriginal, "the original address holds the very answer it held before");
  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: probeAnswer("connected"), generation: stood.seenDuringWrite[0]?.generation ?? -1 }),
    false, "a fetch issued against the seeded state loses its claim to be kept once the put-back has moved the generation");
  assert.equal(stood.actions.answers.get(ADDRESS), priorAtAddress, "so the refused fetch wrote nothing over the restored answer");
  assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], renders: [{ detail: WRITE_FAILURE, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }],
    sends: 1, stood });
});

test("s6b: a failed save leaves both addresses empty where it found them empty, and paints a non-Error through String", async () => {

  const stood = stand({ probe: passed("connected"), writes: ["failedWithString"] });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), null, "the save answers null");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "the address the save wrote is empty again");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), undefined, "the original address is empty too");
  assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], renders: [{ detail: "the host answered in a shape it never writes",
    lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood });
});

test("s7a: an interpreter holder that rejects declines the check with nothing seeded, and paints the failure without composing anything", async () => {

  const stood = stand({ interpretersThrow: true, probe: passed("connected") });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  const before = stood.actions.answers.generation();

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the address holds the very answer it held, because the check declined before anything was seeded");
  assert.deepEqual(stood.serialReads.map((answer) => answer.message), [ PRIOR_MESSAGE, PROBE_MESSAGE ],
    "the outgoing serial was read, then the probe's, before the catalog read that failed");
  assert.deepEqual(stood.composed, [], "the write never ran");
  assert.equal(stood.actions.answers.generation(), before, "and the generation did not move");
  assertSpoke({ renders: [{ detail: INTERPRETERS_FAILURE, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 0, stood });
});

test("s7b: a coordinated write that throws restores the map and paints the failure", async () => {

  const stood = stand({ probe: passed("connected"), writes: ["rejected"] });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the address holds the very answer it held before");
  assertSpoke({ renders: [{ detail: WRITE_FAILURE, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood });
});

test("s8: a write this page does not recognize answers null, keeps the seed, and says nothing", async () => {

  const stood = stand({ probe: passed("connected"), writes: ["unrecognized"] });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.equal(stood.actions.answers.get(ADDRESS)?.devices[0]?.["processed"], PROCESSED, "the seed is left exactly where the save put it");
  assertSpoke({ sends: 0, stood });
});

test("s9: the address a save writes is seeded with its own processed answer before the write runs", async () => {

  const stood = stand({ probe: passed("connected") });

  seed(stood, ADDRESS, priorAt(ADDRESS));

  await stood.actions.saveController({ card: stood.card, originalAddress: undefined });

  assert.equal(stood.seenDuringWrite.length, 1, "the write ran exactly once");

  const atAddress = stood.seenDuringWrite[0]?.atAddress;

  assert.ok(atAddress, "the address must already hold an answer by the time the write runs");
  assert.equal(atAddress.message, PROBE_MESSAGE, "the write saw this save's own answer rather than the one held before it");
  assert.deepEqual(atAddress.devices, [{ processed: PROCESSED, processedAddress: ADDRESS, serialNumber: PROBE_SERIAL }],
    "and saw it with the page's own decoration already applied");
  assertSpoke({ sends: 1, stood, toasts: [{ channel: "success", text: SAVED_CONNECTED }] });
});

test("s10: a save moves the generation before the write, so a fetch captured earlier is refused afterwards", async () => {

  const stood = stand({ probe: passed("connected") });
  const mark = stood.actions.answers.generation();

  await stood.actions.saveController({ card: stood.card, originalAddress: undefined });

  assert.notEqual(stood.seenDuringWrite[0]?.generation, mark, "the generation had already moved by the time the write ran");
  assert.equal(stood.actions.answers.keep({ address: ORIGINAL_ADDRESS, answer: priorAt(ORIGINAL_ADDRESS), generation: mark }), false,
    "an answer captured before the save is refused after it");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), undefined, "and nothing is written for it");
});

test("s11: a save hands the interpreter the card's identity with the original address, and the write the patch that came back", async () => {

  const stood = stand({ probe: passed("connected") });

  await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS });

  assert.deepEqual(stood.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ORIGINAL_ADDRESS,
    originalSerial: undefined, serial: PROBE_SERIAL } }], "the save interpreter ran once, against the configuration the write composed over");
  assert.deepEqual(stood.composed, [SAVE_PATCH], "and the write received exactly the patch the interpreter composed");
  assert.deepEqual(stood.renames, [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], "beside the rename from the address the card started from to the one it wrote");
});

test("s12: a save that leaves the address alone seeds it before the write and declares no rename", async () => {

  const stood = stand({ probe: passed("connected") });

  seed(stood, ADDRESS, priorAt(ADDRESS));

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ADDRESS }), ADDRESS, "the save answers the address it wrote");
  assert.equal(stood.seenDuringWrite[0]?.atAddress?.message, PROBE_MESSAGE, "the address holds this save's own answer by the time the write runs");
  assertSpoke({ sends: 1, stood, toasts: [{ channel: "success", text: SAVED_CONNECTED }] });
});

test("s13: a save reads the outgoing serial from the answer held under the address it is writing over, ahead of the seed that replaces it", async () => {

  const replacing = stand({ probe: passed("connected") });

  seed(replacing, ADDRESS, priorAt(ADDRESS));
  seed(replacing, ORIGINAL_ADDRESS, priorAt(ORIGINAL_ADDRESS));

  await replacing.actions.saveController({ card: replacing.card, originalAddress: ORIGINAL_ADDRESS });

  assert.deepEqual(replacing.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ORIGINAL_ADDRESS,
    originalSerial: PRIOR_SERIALS[ORIGINAL_ADDRESS], serial: PROBE_SERIAL } }],
  "an address edit reads the outgoing serial under the address it replaced, and the incoming one from this save's own validation");
  assert.deepEqual(replacing.serialReads.map((answer) => answer.message), [ PRIOR_MESSAGE, PROBE_MESSAGE ],
    "which is read from the answer this session was already holding rather than from the one the seed puts in its place");
  assert.deepEqual(replacing.renames, [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], "and the address edit declares its rename on the write");

  const same = stand({ probe: passed("connected") });

  seed(same, ADDRESS, priorAt(ADDRESS));

  await same.actions.saveController({ card: same.card, originalAddress: ADDRESS });

  assert.deepEqual(same.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ADDRESS,
    originalSerial: PRIOR_SERIALS[ADDRESS], serial: PROBE_SERIAL } }], "a save that leaves the address alone reads the outgoing serial under that same address");
  assert.deepEqual(same.serialReads.map((answer) => answer.message), [ PRIOR_MESSAGE, PROBE_MESSAGE ], "from the held answer there too, ahead of the seed");
});

test("s14: a token-only answer names no serial, on whichever side of the save it sits", async () => {

  const validated = stand({ probe: passed("token-only") });

  seed(validated, ADDRESS, priorAt(ADDRESS));

  await validated.actions.saveController({ card: validated.card, originalAddress: ADDRESS });

  assert.deepEqual(validated.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ADDRESS,
    originalSerial: PRIOR_SERIALS[ADDRESS], serial: undefined } }],
  "a token-only validation hands no serial, because the row it would be read from carries an address identity rather than one");
  assert.deepEqual(validated.serialReads.map((answer) => answer.message), [PRIOR_MESSAGE], "and that row goes unread");

  const held = stand({ probe: passed("connected") });

  seed(held, ADDRESS, { ...priorAt(ADDRESS), kind: "token-only" });

  await held.actions.saveController({ card: held.card, originalAddress: ADDRESS });

  assert.deepEqual(held.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ADDRESS, originalSerial: undefined,
    serial: PROBE_SERIAL } }], "and a token-only answer held under the address hands no outgoing serial either");
  assert.deepEqual(held.serialReads.map((answer) => answer.message), [PROBE_MESSAGE], "its row going unread the same way");
});

test("s15: a save whose card closes, leaves the screen, or is re-populated during its check still writes, and speaks its success through the toast", async () => {

  const assertWritten = async (event: CardEvent): Promise<void> => {

    const label = event + ": ";
    const stood = stand({ duringCheck: event, probe: passed("connected") });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, label + "the save answers the address it wrote");
    assert.deepEqual(stood.composed, [SAVE_PATCH], label + "and the write still received the patch the interpreter composed");
    assertSpoke({ label, sends: 1, stood, toasts: [{ channel: "success", text: SAVED_CONNECTED }] });
  };

  await assertWritten("close");
  await assertWritten("hide");
  await assertWritten("repopulate");
});

test("s16: a save whose check fails once its card has closed, left the screen, or been re-populated toasts the failure and paints nothing", async () => {

  const assertToasted = async (event: CardEvent): Promise<void> => {

    const label = event + ": ";
    const stood = stand({ duringCheck: event, probe: CHECK_FAILED });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assert.deepEqual(stood.composed, [], label + "nothing is composed");
    assertSpoke({ label, sends: 0, stood, toasts: [{ channel: "error", text: CHECK_FAILURE_TOAST }] });
  };

  await assertToasted("close");
  await assertToasted("hide");
  await assertToasted("repopulate");
});

test("s17: a save whose write fails once its card has stopped presenting it toasts the failure and paints nothing", async () => {

  const assertToasted = async ({ event, label, writes }: { event: CardEvent; label: string; writes: WriteStep[] }): Promise<void> => {

    const stood = stand({ duringWrite: event, probe: passed("connected"), writes });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assertSpoke({ label, sends: 1, stood, toasts: [{ channel: "error", text: SAVE_FAILURE_LINE + " " + WRITE_FAILURE }] });
  };

  await assertToasted({ event: "close", label: "close, failed: ", writes: ["failed"] });
  await assertToasted({ event: "close", label: "close, rejected: ", writes: ["rejected"] });
  await assertToasted({ event: "edit", label: "edit, failed: ", writes: ["failed"] });
  await assertToasted({ event: "hide", label: "hide, failed: ", writes: ["failed"] });
  await assertToasted({ event: "repopulate", label: "repopulate, failed: ", writes: ["failed"] });
});

test("s18: an open card's failures paint on its verdict line and toast nothing", async () => {

  const checked = stand({ probe: CHECK_FAILED });

  assert.equal(await checked.actions.saveController({ card: checked.card, originalAddress: undefined }), null, "a failed check answers null");
  assertSpoke({ label: "check: ", renders: [CHECK_FAILURE], sends: 0, stood: checked });

  const written = stand({ probe: passed("connected"), writes: ["failed"] });

  assert.equal(await written.actions.saveController({ card: written.card, originalAddress: undefined }), null, "a failed write answers null");
  assertSpoke({ label: "write: ", renders: [{ detail: WRITE_FAILURE, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood: written });
});

test("s19: an edit or another retiring act during a save's check, its catalog read included, cancels the save, which writes nothing and says nothing", async () => {

  const assertCancelled = async ({ label, options }: { label: string; options: StandOptions }): Promise<void> => {

    const stood = stand({ ...options, probe: passed("connected") });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assert.deepEqual(stood.interpreterCalls, [], label + "no interpreter runs");
    assert.deepEqual(stood.composed, [], label + "nothing is composed");
    assertSpoke({ label, sends: 0, stood });
  };

  await assertCancelled({ label: "an edit during the connection check: ", options: { duringCheck: "edit" } });

  // A newer act on the card retiring the press while its catalog read is in flight, the last await the check makes before the flow reads the press's signal.
  await assertCancelled({ label: "a retirement during the catalog read: ", options: { retireDuringCatalogRead: true } });
});

test("s20: a save whose original address is not a string declares no rename, and writes and speaks as any other save does", async () => {

  const stood = stand({ probe: passed("connected") });

  // A hand edit is the only way a configured address arrives as something other than a string, and the editors pass it through unconverted. Such a save still
  // replaces an address, but the framework refuses a rename whose keys are not strings, so the save declares none and writes rather than failing.
  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: 42 }), ADDRESS, "the save answers the address it wrote");
  assert.deepEqual(stood.composed, [SAVE_PATCH], "and the write received the patch the interpreter composed");
  assertSpoke({ sends: 1, stood, toasts: [{ channel: "success", text: SAVED_CONNECTED }] });
});

test("s21: a save at an address another controller holds is refused before its connection test, writing nothing and saying the sentence on the card", async () => {

  const stood = stand({ listed: true, probe: passed("connected") });
  const priorAtAddress = priorAt(ADDRESS);
  const priorAtOriginal = priorAt(ORIGINAL_ADDRESS);

  seed(stood, ADDRESS, priorAtAddress);
  seed(stood, ORIGINAL_ADDRESS, priorAtOriginal);

  const before = stood.actions.answers.generation();

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), null, "the save answers null");
  assert.deepEqual(stood.listedChecks, [{ config: PAGE_CONFIG, save: { address: ADDRESS, originalAddress: ORIGINAL_ADDRESS } }],
    "the rule was asked once, of the configuration the page last received, about the address written and the one the save started from");
  assert.equal(stood.probeCalls.length, 0, "the connection test never ran");
  assert.deepEqual(stood.interpreterCalls, [], "no interpreter ran");
  assert.deepEqual(stood.composed, [], "nothing was composed or written");
  assert.equal(stood.actions.answers.get(ADDRESS), priorAtAddress, "the address written still holds the very answer it held");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), priorAtOriginal, "and so does the address the save started from");
  assert.equal(stood.actions.answers.generation(), before, "and the generation did not move, because nothing was seeded");
  assertSpoke({ renders: [{ lines: [LISTED_REFUSAL], tone: "text-warning" }], sends: 0, stood });
});

test("s22: a listed address refused once the card has stopped presenting the save speaks through the warning toast and paints nothing", async () => {

  const assertToasted = async (event: CardEvent): Promise<void> => {

    const label = event + ": ";
    const stood = stand({ duringListedCheck: event, listed: true, probe: passed("connected") });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assert.equal(stood.probeCalls.length, 0, label + "the connection test never ran");
    assert.deepEqual(stood.composed, [], label + "nothing was composed or written");
    assertSpoke({ label, sends: 0, stood, toasts: [{ channel: "warning", text: LISTED_REFUSAL }] });
  };

  await assertToasted("close");
  await assertToasted("hide");
  await assertToasted("repopulate");
});

test("s23: a composer that answers null for a listed address seeds nothing, puts nothing back, and says the page's sentence on the card", async () => {

  const stood = stand({ composerRefuses: true, probe: passed("connected") });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  const before = stood.actions.answers.generation();

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.equal(stood.probeCalls.length, 1, "the early check passed, so the connection check ran");
  assert.deepEqual(stood.composed, [null], "the composer answered null, so the write composed nothing");
  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the address holds the very answer it held, because nothing was seeded");
  assert.equal(stood.actions.answers.generation(), before, "and the generation did not move");
  assertSpoke({ renders: [{ lines: [LISTED_REFUSAL], tone: "text-warning" }], sends: 0, stood });
});

test("s24: a composer's null answer met once the card has stopped presenting the save speaks through the warning toast and paints nothing", async () => {

  const assertToasted = async (event: CardEvent): Promise<void> => {

    const label = event + ": ";
    const stood = stand({ composerRefuses: true, duringCheck: event, probe: passed("connected") });
    const prior = priorAt(ADDRESS);

    seed(stood, ADDRESS, prior);

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assert.equal(stood.actions.answers.get(ADDRESS), prior, label + "the address holds the very answer it held, because nothing was seeded");
    assertSpoke({ label, sends: 0, stood, toasts: [{ channel: "warning", text: LISTED_REFUSAL }] });
  };

  await assertToasted("close");
  await assertToasted("hide");
  await assertToasted("repopulate");
});

test("s25: a composer that throws rejects the press, which speaks the failure with the thrown message, even for an error carrying the listed sentence", async () => {

  const assertFailed = async (thrown: Error): Promise<void> => {

    const label = thrown.message + ": ";
    const stood = stand({ composerThrows: thrown, probe: passed("connected") });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assertSpoke({ label, renders: [{ detail: thrown.message, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 0, stood });
  };

  await assertFailed(new Error("the composer threw"));

  // The composer refuses by answering null and never by a throw, so an ordinary error whose message happens to be the listed sentence is the failure it is, and
  // the press never speaks the listed warning for it.
  await assertFailed(new Error(LISTED_REFUSAL));
});

test("s26: a press during a write starts nothing and says nothing, and the write is the only one, because the save writes through its card's flow", async () => {

  const assertBusy = async (event?: CardEvent): Promise<void> => {

    const label = (event ?? "open") + ": ";
    const { promise: held, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: atWrite, resolve: reached } = Promise.withResolvers<undefined>();
    const stood = stand({ duringWrite: event, hold: held, onWrite: () => reached(undefined), probe: passed("connected") });
    const first = stood.actions.saveController({ card: stood.card, originalAddress: undefined });

    await atWrite;

    assert.equal(stood.control.disabled, true, label + "the flow holds the control it was built over disabled while the write is in flight");
    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "a second press during the write answers null");
    assert.equal(stood.starts(), 1, label + "and starts no action of its own, so it cannot retire the write's");
    assert.equal(stood.probeCalls.length, 1, label + "and runs no connection check of its own");

    release(undefined);

    assert.equal(await first, ADDRESS, label + "the first press goes on to its own result");
    assert.deepEqual(stood.composed, [SAVE_PATCH], label + "two presses on one card make one write");
    assert.equal(stood.control.disabled, false, label + "and the flow gives the control back once the write settles");
    assertSpoke({ label, sends: 1, stood, toasts: [{ channel: "success", text: SAVED_CONNECTED }] });
  };

  await assertBusy();

  // A card re-populated to another controller while the write runs keeps that write's busy state, because the state belongs to the card's flow and not to what
  // the card is showing.
  await assertBusy("repopulate");
});

// The write answering before its composer runs, once as a failed result and once as a rejection, each an arm of its own.
for(const step of [ "failedBeforeCompose", "rejectedBeforeCompose" ] as const) {

  test("s27: a press whose write answers before its composer (" + step + ") seeds nothing, moves nothing, and speaks the write's failure", async () => {

    const stood = stand({ probe: passed("connected"), writes: [step] });
    const priorAtAddress = priorAt(ADDRESS);
    const priorAtOriginal = priorAt(ORIGINAL_ADDRESS);

    seed(stood, ADDRESS, priorAtAddress);
    seed(stood, ORIGINAL_ADDRESS, priorAtOriginal);

    const before = stood.actions.answers.generation();

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), null, "the press answers null");
    assert.deepEqual(stood.composed, [], "its composer never ran");
    assert.equal(stood.actions.answers.get(ADDRESS), priorAtAddress, "the address the save writes still holds the very answer it held");
    assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), priorAtOriginal, "and so does the address the save started from");
    assert.equal(stood.actions.answers.generation(), before, "and the generation did not move, because nothing was seeded");
    assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], renders: [{ detail: WRITE_FAILURE, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }],
      sends: 0, stood });
  });
}

test("s28: a press rejected after its check delivers the save's failure through the check's own delivery, on the card or through the toast", async () => {

  const open = stand({ probe: passed("connected"), writes: ["rejected"] });

  assert.equal(await open.actions.saveController({ card: open.card, originalAddress: undefined }), null, "a rejected press on an open card answers null");
  assertSpoke({ label: "open: ", renders: [{ detail: WRITE_FAILURE, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood: open });

  const closed = stand({ duringCheck: "close", probe: passed("connected"), writes: ["rejected"] });

  assert.equal(await closed.actions.saveController({ card: closed.card, originalAddress: undefined }), null, "a rejected press on a closed card answers null");
  assertSpoke({ label: "closed: ", sends: 1, stood: closed, toasts: [{ channel: "error", text: SAVE_FAILURE_LINE + " " + WRITE_FAILURE }] });
});

test("s29: a press rejected before any check ran raises the save's failure on the error toast alone", async () => {

  const stood = stand({ malformedStarter: true, probe: passed("connected") });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "a rejected press answers null");
  assert.equal(stood.toasts.length, 1, "exactly one toast is raised");

  const [raised] = stood.toasts;

  assert.ok(raised, "and it is read");
  assert.equal(raised.channel, "error", "on the error channel");
  assert.ok(raised.text.startsWith(SAVE_FAILURE_LINE + " "), "carrying the save's failure sentence followed by what the press rejected with");
  assert.deepEqual(stood.renders, [], "and nothing is painted, because no check kept a delivery to paint through");
  assert.equal(stood.probeCalls.length, 0, "no connection check runs");
  assert.deepEqual(stood.composed, [], "nothing is composed");
  assert.equal(stood.sends(), 0, "and nothing is sent");
});

test("s30: a press that seeds and commits, followed by a press that fails before its composer, keeps the first press's seed", async () => {

  const stood = stand({ probe: passed("connected"), writes: [ "committed", "failedBeforeCompose" ] });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, "the first press writes");

  const seeded = stood.actions.answers.get(ADDRESS);

  assert.ok(seeded, "and seeds the written address");
  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the second press fails before its composer runs");
  assert.deepEqual(stood.composed, [SAVE_PATCH], "so only the first press composed");
  assert.equal(stood.actions.answers.get(ADDRESS), seeded, "and the first press's seed stands, because a put-back belongs to the press that seeded");
  assertSpoke({ renders: [{ detail: WRITE_FAILURE, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood,
    toasts: [{ channel: "success", text: SAVED_CONNECTED }] });
});

test("s31: a save at a listed address is refused before its catalog read, so the refusal is what is said even when the catalog cannot be read", async () => {

  const stood = stand({ interpretersThrow: true, listed: true, probe: passed("connected") });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.equal(stood.probeCalls.length, 0, "the connection check never ran, because the listed-address check refused first");
  assert.equal(stood.catalogReads(), 0, "and the catalog was never read");
  assert.deepEqual(stood.composed, [], "nothing was composed or written");
  assertSpoke({ renders: [{ lines: [LISTED_REFUSAL], tone: "text-warning" }], sends: 0, stood });
});

test("s32: a save whose connection check fails never reads the catalog, so the check's failure is what is said even when the catalog cannot be read", async () => {

  const stood = stand({ interpretersThrow: true, probe: CHECK_FAILED });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.equal(stood.probeCalls.length, 1, "the connection check ran once");
  assert.equal(stood.catalogReads(), 0, "and the catalog was never read, because the check declined before the read is reached");
  assert.deepEqual(stood.composed, [], "nothing was composed or written");
  assertSpoke({ renders: [CHECK_FAILURE], sends: 0, stood });
});

test("s33: a device-list processing that throws in the composer's seed rejects the press, which speaks the failure and leaves the kept answers as found", async () => {

  const stood = stand({ probe: passed("connected"), processingThrows: true });
  const priorAtAddress = priorAt(ADDRESS);
  const priorAtOriginal = priorAt(ORIGINAL_ADDRESS);

  seed(stood, ADDRESS, priorAtAddress);
  seed(stood, ORIGINAL_ADDRESS, priorAtOriginal);

  const before = stood.actions.answers.generation();

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), null, "the press answers null");
  assert.equal(stood.interpreterCalls.length, 1, "the composer ran and answered a patch, so the press reached its seed");
  assert.deepEqual(stood.composed, [], "and the write never received the patch, because the seed threw inside the composer");
  assert.equal(stood.actions.answers.get(ADDRESS), priorAtAddress, "the address the save writes still holds the very answer it held");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), priorAtOriginal, "and so does the address the save started from");
  assert.equal(stood.actions.answers.generation(), before, "and the generation did not move, because the processing runs before the seed changes anything");
  assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], renders: [{ detail: PROCESSING_FAILURE, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }],
    sends: 0, stood });
});

test("s34: a catalog read the UI server refuses with a plain object paints that object's own message, read through the error text rule the page hands in", async () => {

  const stood = stand({ catalogRejected: true, probe: passed("connected") });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.deepEqual(stood.composed, [], "nothing was composed or written");
  assert.deepEqual(stood.errorReads, [CATALOG_REJECTION], "the failure's message is read once, through the rule the page handed in, from what the read rejected with");
  assertSpoke({ renders: [{ detail: CATALOG_REFUSAL, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 0, stood });
});

test("r1: a committed removal drops the answer, sends once, and says nothing at all", async () => {

  const stood = stand();

  seed(stood, ADDRESS, priorAt(ADDRESS));

  const mark = stood.actions.answers.generation();

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: [] });

  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "what the session remembered goes with the controller");
  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: priorAt(ADDRESS), generation: mark }), false,
    "a fetch already in flight for the removed address cannot put it back");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "so the address is still empty after the refused fetch");
  assertSpoke({ sends: 1, stood });
});

test("r2: a staged removal warns that the file was not written, and still drops the answer", async () => {

  const stood = stand({ writes: ["staged"] });

  seed(stood, ADDRESS, priorAt(ADDRESS));

  const mark = stood.actions.answers.generation();

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "what the session remembered goes with the controller");
  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: priorAt(ADDRESS), generation: mark }), false,
    "a fetch already in flight for the removed address cannot put it back");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "so the address is still empty after the refused fetch");
  assertSpoke({ sends: 1, stood, toasts: [{ channel: "warning", text: REMOVED_STAGED }] });
});

test("r3: a failed removal paints the failure on the card and keeps the answer", async () => {

  const stood = stand({ writes: ["failed"] });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the answer is still held under its address");
  assertSpoke({ renders: [{ detail: WRITE_FAILURE, lines: [REMOVE_FAILURE_LINE], tone: "text-danger" }], sends: 0, stood });
});

test("r4: a removal whose write throws paints the failure and keeps the answer", async () => {

  const stood = stand({ writes: ["rejected"] });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the answer is still held under its address");
  assertSpoke({ renders: [{ detail: WRITE_FAILURE, lines: [REMOVE_FAILURE_LINE], tone: "text-danger" }], sends: 0, stood });
});

test("r5: a removal this page does not recognize says nothing and keeps the answer", async () => {

  const stood = stand({ writes: ["unrecognized"] });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the answer is still held under its address");
  assertSpoke({ sends: 0, stood });
});

test("r6: a removal hands the interpreter the address and the chosen sweep, and the write the patch that came back", async () => {

  const stood = stand();

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.deepEqual(stood.interpreterCalls, [{ config: PLATFORM, kind: "removed", payload: { address: ADDRESS, macs: MACS } }],
    "the removal interpreter ran once, against the configuration the write composed over");
  assert.deepEqual(stood.composed, [REMOVE_PATCH], "and the write received exactly the patch the interpreter composed");
});

test("a1: an answer that failed is refused, and nothing is written for it", () => {

  const stood = stand();

  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: failedAnswer(), generation: stood.actions.answers.generation() }), false,
    "a failure is never kept");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "and nothing is held under its address");
});

test("a2: an answer an invalidation overtook is refused, and nothing is written for it", () => {

  const stood = stand();
  const mark = stood.actions.answers.generation();

  stood.actions.answers.clear();

  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: priorAt(ADDRESS), generation: mark }), false, "an overtaken answer is dropped");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "and nothing is held under its address");
});

test("a3: a success offered at the current generation is kept, and reads back as the same answer", () => {

  const stood = stand();
  const answer = priorAt(ADDRESS);

  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer, generation: stood.actions.answers.generation() }), true, "the answer is kept");
  assert.equal(stood.actions.answers.get(ADDRESS), answer, "and reads back as the very answer that was offered");
});

test("a4: clearing empties the answers and moves the generation", () => {

  const stood = stand();

  seed(stood, ADDRESS, priorAt(ADDRESS));

  const mark = stood.actions.answers.generation();

  stood.actions.answers.clear();

  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "nothing is held any more");
  assert.notEqual(stood.actions.answers.generation(), mark, "and a fetch issued before the clear has lost its claim to be kept");
});

// What the connection check says for each of its failures, transcribed from the module and the probe classifier rather than referenced, so a sentence that drifts
// by a character reddens a row.
const ADDRESS_MISSING = "Please enter your UniFi Access controller's address.";
const SIGN_IN_MISSING = [ "Please enter a way to sign in to this UniFi Access controller.",
  "That is a local user's username and password, an Access console API token, or both." ];
const CONNECTION_REFUSED = [ "Unable to connect to the UniFi Access controller.", "Please check your controller address and sign-in details." ];
const SERVER_FAILURE = [ "The plugin's UI server did not answer as expected.",
  "Reload this page. If it keeps happening, restart Homebridge and check its log for the reason." ];
const CONNECTION_UNVALIDATED = "Unable to validate your controller connection.";

// The sentence the framework's deadline rejects with on expiry, for a check built with a thirty-second bound.
const DEADLINE_EXPIRED = "The request did not complete within 30 seconds.";

// What the deadline double is handed for one check.
interface DeadlineCall {

  promise: Promise<unknown>;
  seconds: number;
  signal?: AbortSignal;
}

// One request the bridge double is handed.
interface BridgeRequest {

  path: string;
  payload: unknown;
}

// What a row builds the connection check over. The bound has a default, so a row names it only where the row is about it.
interface ProbeStandOptions {

  answer: () => Promise<unknown>;
  expiry?: Error;
  onRequest?: () => void;
  seconds?: number;
}

// A built connection check and everything its doubles recorded.
interface ProbeStand {

  check: ReturnType<typeof makeControllerProbe>;
  deadlines: DeadlineCall[];
  requests: BridgeRequest[];
}

/* Build the connection check over a bridge double, a deadline double, and the real probe classifier, identity rule, and rejection reading.
 *
 * The bridge double records each request, runs the row's own step where it has one, and hands back the very promise the row's answer makes, so a row decides
 * whether the request fulfills, rejects, or is retired while it is in flight, and the deadline can be read for receiving that promise by identity. The deadline
 * double records what it was handed and answers the promise it was handed, unless the row scripts an expiry, which stands for the framework's deadline expiring
 * before the bridge answers.
 *
 * @param options.answer    - What the bridge settles the request with.
 * @param options.expiry    - What the deadline rejects with in place of the bridge's answer, for a row about a check that outlasts its bound.
 * @param options.onRequest - What befalls the check while its request is in flight.
 * @param options.seconds   - The bound the check is built with.
 *
 * @returns The check and every recorder beneath it.
 */
function standProbe({ answer, expiry, onRequest, seconds = 30 }: ProbeStandOptions): ProbeStand {

  const deadlines: DeadlineCall[] = [];
  const requests: BridgeRequest[] = [];
  const check = makeControllerProbe({

    classifyProbeResponse,
    deadline: seconds,
    hasValidIdentity,
    readProbeRejection,
    request: (path, payload) => {

      requests.push({ path, payload });
      onRequest?.();

      return answer();
    },
    withDeadline: async (options) => {

      deadlines.push(options);

      return expiry ? Promise.reject(expiry) : options.promise;
    }
  });

  return { check, deadlines, requests };
}

/* The card's identity and a signal no act retires, each of which a row overrides where the row is about it.
 *
 * @param overrides - The members the row is about.
 *
 * @returns The request.
 */
function probeRequest(overrides: Partial<ProbeRequest> = {}): ProbeRequest {

  return { ...IDENTITY, signal: new AbortController().signal, ...overrides };
}

test("p1: a missing address answers failed with the address sentence and makes no request", async () => {

  const s = standProbe({ answer: async () => ({ devices: [], kind: "connected" }) });

  assert.deepEqual(await s.check(probeRequest({ address: "" })), { kind: "failed", outcome: { lines: [ADDRESS_MISSING] } },
    "a blank address answers the address sentence");
  assert.deepEqual(s.requests, [], "and no request reaches the bridge for it");
});

test("p2: an identity the plugin would refuse answers failed with the sign-in sentences and makes no request", async () => {

  const s = standProbe({ answer: async () => ({ devices: [], kind: "connected" }) });

  assert.deepEqual(await s.check(probeRequest({ password: "" })), { kind: "failed", outcome: { lines: SIGN_IN_MISSING } },
    "half a credential pair answers the sign-in sentences, even with a token beside it");
  assert.deepEqual(await s.check(probeRequest({ password: "", tokens: { access: "" }, username: "" })), { kind: "failed", outcome: { lines: SIGN_IN_MISSING } },
    "and so does an identity carrying no way to sign in at all");
  assert.deepEqual(s.requests, [], "and no request reaches the bridge for either");
});

test("p3: a connected answer passes with the classified success, and the one request carries exactly the card's identity", async () => {

  const devices = [device(PROBE_SERIAL)];
  const s = standProbe({ answer: async () => ({ devices, kind: "connected" }) });

  assert.deepEqual(await s.check(probeRequest()), { answer: { devices, kind: "connected", message: "", tokenRefused: false }, kind: "passed" },
    "a credentialed connect answers passed with the classified success");
  assert.deepEqual(s.requests, [{ path: "/getDevices", payload: IDENTITY }],
    "and the one request asks the UI server for the devices with the address, password, tokens, username, and TLS preference alone");
});

test("p4: a token-only answer passes as token-only, and a connected answer whose token was refused passes saying so", async () => {

  const devices = [device(PROBE_SERIAL)];
  const tokenOnly = standProbe({ answer: async () => ({ devices, kind: "token-only" }) });
  const refused = standProbe({ answer: async () => ({ devices, kind: "connected", tokenRefused: true }) });

  assert.deepEqual(await tokenOnly.check(probeRequest()), { answer: { devices, kind: "token-only", message: "", tokenRefused: false }, kind: "passed" },
    "a token-only connect is a success the callers speak in their token-only sentences");
  assert.deepEqual(await refused.check(probeRequest()), { answer: { devices, kind: "connected", message: "", tokenRefused: true }, kind: "passed" },
    "and a connect whose token the controller refused is a success carrying the refusal");
});

test("p5: a server error answers failed with the connection sentences and the server's message as detail, or an empty detail for one that is no string", async () => {

  const reported = standProbe({ answer: async () => ({ kind: "error", message: "Invalid credentials." }) });
  const unworded = standProbe({ answer: async () => ({ kind: "error", message: 42 }) });

  assert.deepEqual(await reported.check(probeRequest()), { kind: "failed", outcome: { detail: "Invalid credentials.", lines: CONNECTION_REFUSED } },
    "a controller that refused the connection answers the classifier's headline, the card's own guidance line, and the server's own reason");
  assert.deepEqual(await unworded.check(probeRequest()), { kind: "failed", outcome: { detail: "", lines: CONNECTION_REFUSED } },
    "and a reason that is no string is written as an empty detail, which every reader drops");
});

test("p6: a success without a device list and an answer in an unrecognized shape each answer failed with the UI server's failure", async () => {

  const listless = standProbe({ answer: async () => ({ devices: "not a list", kind: "connected" }) });
  const unrecognized = standProbe({ answer: async () => ({ kind: "nonsense" }) });

  assert.deepEqual(await listless.check(probeRequest()),
    { kind: "failed", outcome: { detail: "The plugin's UI server answered a connection without a device list.", lines: SERVER_FAILURE } },
    "a success carrying no device list is the UI server's failure, with the classifier's own detail");
  assert.deepEqual(await unrecognized.check(probeRequest()),
    { kind: "failed", outcome: { detail: "The plugin's UI server answered in an unrecognized shape.", lines: SERVER_FAILURE } },
    "and so is an answer in a shape the server never writes");
});

test("p7: a rejected request answers failed with the validation sentence and the rejection's reason, for an error, the bridge's plain object, and a string", async () => {

  // The plain object the bridge rejects with, which carries a message although it is no error, and a rejection that is a string, which carries no message at all.
  const bridgeRejection: unknown = { message: "The plugin's UI server is not running." };
  const stringRejection: unknown = "the bridge gave up on the request";
  const thrown = standProbe({ answer: async () => Promise.reject(new Error("The UI server did not respond.")) });
  const bridged = standProbe({ answer: async () => {

    throw bridgeRejection;
  } });
  const worded = standProbe({ answer: async () => {

    throw stringRejection;
  } });

  assert.deepEqual(await thrown.check(probeRequest()), { kind: "failed", outcome: { detail: "The UI server did not respond.", lines: [CONNECTION_UNVALIDATED] } },
    "a request rejected with an error carries the error's own message");
  assert.deepEqual(await bridged.check(probeRequest()),
    { kind: "failed", outcome: { detail: "The plugin's UI server is not running.", lines: [CONNECTION_UNVALIDATED] } },
    "and a request rejected with the bridge's plain object carries that object's message");
  assert.deepEqual(await worded.check(probeRequest()),
    { kind: "failed", outcome: { detail: "the bridge gave up on the request", lines: [CONNECTION_UNVALIDATED] } },
    "and a request rejected with a string carries that string, which a read of the rejection's message alone would drop");
});

test("p8: a signal aborted while the request is in flight answers retired, where the request fulfilled and where it rejected", async () => {

  const assertRetired = async ({ answer, settlement }: { answer: () => Promise<unknown>; settlement: string }): Promise<void> => {

    const controller = new AbortController();
    const s = standProbe({ answer, onRequest: () => controller.abort() });

    assert.deepEqual(await s.check(probeRequest({ signal: controller.signal })), { kind: "retired" },
      "a check its card retired while the request was in flight answers retired with nothing to show, where the request " + settlement);
  };

  await assertRetired({ answer: async () => ({ devices: [], kind: "connected" }), settlement: "fulfilled" });
  await assertRetired({ answer: async () => Promise.reject(new Error("The UI server did not respond.")), settlement: "rejected" });
});

test("p9: the deadline is handed the request's own promise, the seconds the check was built with, and the caller's signal itself", async () => {

  const answered = Promise.resolve({ devices: [device(PROBE_SERIAL)], kind: "connected" });
  const s = standProbe({ answer: () => answered, seconds: 17 });
  const request = probeRequest();

  await s.check(request);

  assert.equal(s.deadlines.length, 1, "the check bounds its one request once");

  const [deadline] = s.deadlines;

  assert.ok(deadline, "and that bound is read");
  assert.equal(deadline.promise, answered, "around the very promise the bridge's request answered");
  assert.equal(deadline.seconds, 17, "with the bound the check was built with");
  assert.equal(deadline.signal, request.signal, "and with the caller's own signal, so a retired check settles at once");
});

test("p10: a deadline that expires answers failed with the validation sentence and the deadline's own sentence as detail", async () => {

  const s = standProbe({ answer: async () => new Promise(() => undefined), expiry: new Error(DEADLINE_EXPIRED) });

  assert.deepEqual(await s.check(probeRequest()), { kind: "failed", outcome: { detail: DEADLINE_EXPIRED, lines: [CONNECTION_UNVALIDATED] } },
    "a UI server that never answers fails as a request that threw, with the deadline's sentence saying how long the check waited");
});
