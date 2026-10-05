/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.test.ts: The settings page's controller connection check, its kept controller answers, and the controller save and removal that write them,
 * driven through recording fakes for every reach the module makes outside itself.
 *
 * What these arms prove is the part of a save and a removal no type can state: that each write outcome speaks in exactly the sentence and exactly the severity it
 * is supposed to, that the seed a save makes lands BEFORE the write rather than after it, that a write which failed puts both addresses back exactly as it found
 * them, and that a send follows every write that keeps or drops an answer and follows nothing else. A swapped toast severity, a put-back that restores the wrong
 * address, a dropped generation bump, a rename declared on a save that changed no address, or missing from one that did, and a listed-address refusal painted as
 * a failure, or a failure painted as that refusal, each redden an arm here.
 *
 * Every arm asserts the exact toast list, the exact verdict list, the exact send count, and the exact rename list, so an arm proves the absence of the other
 * outcomes as precisely as the presence of its own. The two addresses differ, their device serials differ, and the answer already held under an address differs
 * from the one the probe returns, so a restore that puts back the wrong thing cannot coincide with one that puts back the right thing.
 *
 * The write fake refuses a declared rename whose keys are not strings, as the framework refuses one ahead of its queue, so a rename built from a value that is
 * no sidebar key fails the save it reaches rather than recording as though the page had accepted it.
 *
 * The connection check's rows run the real probe classifier, identity rule, and rejection reading behind a request double, so each failure's sentences and detail
 * are read where the check composes them.
 */
import type { AccessConfigPatch, AccessIdentity, AccessProbeSuccess, AccessProbeVerdict } from "../homebridge-ui/public/access-config.mjs";
import type { ControllerAction, ControllerActions, ControllerCard, ControllerProbe, ControllerWriteResult } from "../homebridge-ui/public/controller-actions.mjs";
import { ControllerListedError, classifyProbeResponse, hasValidIdentity, isControllerListed, readProbeRejection } from "../homebridge-ui/public/access-config.mjs";
import { makeControllerActions, makeControllerProbe } from "../homebridge-ui/public/controller-actions.mjs";
import assert from "node:assert/strict";
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

// The MAC addresses a swept removal offers to strip settings for.
const MACS = [ "AABBCCDDEEFF", "112233445566" ];

// The platform entry the write fake hands the composer, and the patches each interpreter composes from it. Each is a sentinel: what matters is that exactly this
// object reached the interpreter and exactly that patch came back out of the composer.
const PLATFORM = { theConfigurationTheWriteComposesAgainst: true };
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

// What the composer's refusal carries as its message when an arm has it throw one, worded unlike the sentence a save speaks, so a catch that read the sentence
// off the error rather than speaking the one the page handed in could not pass for one that did.
const COMPOSER_REFUSAL_MESSAGE = "the composer refused an address another controller holds";

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

// One toast, by the severity it was spoken at and the sentence it carried.
interface Toast {

  kind: "error" | "success" | "warning";
  message: string;
}

// What the kept answers looked like at the moment the write ran, which is where the seed's placement and the generation bump's placement are read from.
interface WriteObservation {

  atAddress: AccessProbeSuccess | undefined;
  atOriginal: AccessProbeSuccess | undefined;
  generation: number;
}

// A stood-up set of actions and everything the fakes beneath them recorded.
interface Stand {

  actions: ControllerActions;
  card: ControllerCard;
  composed: unknown[];
  interpreterCalls: InterpreterCall[];
  listedChecks: ListedCheck[];
  probeCalls: ProbeRequest[];
  renames: unknown[];
  renders: RenderedVerdict[];
  seenDuringWrite: WriteObservation[];
  sends: () => number;
  serialReads: AccessProbeSuccess[];
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

/* Stand up the actions over recording fakes for every reach they make outside themselves.
 *
 * @param options.composerThrows    - What the save interpreter throws rather than composing, which reaches the save the way the real write rejects with it.
 * @param options.duringCheck       - What befalls the card while the check is in flight, ahead of anything the check answers.
 * @param options.duringListedCheck - What befalls the card while the listed-address rule is asked, ahead of the connection test.
 * @param options.duringWrite       - What befalls the card while the write is in flight, after the check has passed.
 * @param options.interpretersThrow - Whether the interpreter holder rejects rather than answering.
 * @param options.listed            - Whether the listed-address rule answers that another configured controller already holds the written address.
 * @param options.probe             - What the connection check answers, which an arm that never reaches the check leaves out.
 * @param options.write             - The result the coordinated write resolves with, or the error it throws.
 *
 * @returns The actions and every recorder beneath them.
 */
function stand({ composerThrows, duringCheck, duringListedCheck, duringWrite, interpretersThrow = false, listed = false, probe, write }: {
  composerThrows?: Error; duringCheck?: CardEvent; duringListedCheck?: CardEvent; duringWrite?: CardEvent; interpretersThrow?: boolean; listed?: boolean;
  probe?: ControllerProbe; write: ControllerWriteResult | Error; }): Stand {

  const composed: unknown[] = [];
  const interpreterCalls: InterpreterCall[] = [];
  const listedChecks: ListedCheck[] = [];
  const probeCalls: ProbeRequest[] = [];
  const renames: unknown[] = [];
  const renders: RenderedVerdict[] = [];
  const seenDuringWrite: WriteObservation[] = [];
  const serialReads: AccessProbeSuccess[] = [];
  const toasts: Toast[] = [];
  let closed = false;
  let current: AbortController | null = null;
  let population = 0;
  let sends = 0;
  let visible = true;

  /* The card an action acts for, holding the page card's rules in miniature: a start retires the action before it, an edit retires whatever is current, a
   * re-population moves the card on without retiring anything, and an action is presented while the card is open, the action stands, the card shows the
   * population the action began under, and the card is on screen. An action's own report records only what the card presents, and the plain paint records all.
   */
  const card: ControllerCard = {

    values: () => ({ ...IDENTITY }),
    verdict: {

      render: (options = {}): void => {

        renders.push(options);
      },
      retire: (): void => {

        current?.abort();
        current = null;
      },
      start: (): ControllerAction => {

        current?.abort();
        current = new AbortController();

        const { signal } = current;
        const startedUnder = population;
        const presented = (): boolean => !closed && !signal.aborted && (population === startedUnder) && visible;

        return {

          presented,
          report: (options = {}): void => {

            if(presented()) {

              renders.push(options);
            }
          },
          signal
        };
      }
    }
  };

  // Each thing that can befall the card, as the page's own card meets it.
  const befall: Record<CardEvent, () => void> = {

    close: () => {

      closed = true;
    },
    edit: () => card.verdict.retire(),
    hide: () => {

      visible = false;
    },
    repopulate: () => {

      population++;
    }
  };

  const actions: ControllerActions = makeControllerActions({

    commitConfig: async (compose, options) => {

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

      // What the answers held, and which generation they were on, at the moment the write ran. This is what places the seed and the bump ahead of the write rather
      // than behind it, which no assertion made after the save resolves could tell apart.
      seenDuringWrite.push({ atAddress: actions.answers.get(ADDRESS), atOriginal: actions.answers.get(ORIGINAL_ADDRESS),
        generation: actions.answers.generation() });
      composed.push(compose(PLATFORM));

      if(duringWrite) {

        befall[duringWrite]();
      }

      if(write instanceof Error) {

        throw write;
      }

      return write;
    },
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
    interpreters: async () => {

      if(interpretersThrow) {

        throw new Error(INTERPRETERS_FAILURE);
      }

      return {

        withControllerRemoved: (config, removal): AccessConfigPatch => {

          interpreterCalls.push({ config, kind: "removed", payload: removal });

          return REMOVE_PATCH;
        },
        withControllerSaved: (config, controller): AccessConfigPatch => {

          interpreterCalls.push({ config, kind: "saved", payload: controller });

          if(composerThrows) {

            throw composerThrows;
          }

          return SAVE_PATCH;
        }
      };
    },
    isControllerListed,
    platformConfig: () => PAGE_CONFIG,
    processDeviceList: ({ address, devices }) => {

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
    toast: {

      error: (message) => {

        toasts.push({ kind: "error", message });
      },
      success: (message) => {

        toasts.push({ kind: "success", message });
      },
      warning: (message) => {

        toasts.push({ kind: "warning", message });
      }
    }
  });

  return { actions, card, composed, interpreterCalls, listedChecks, probeCalls, renames, renders, seenDuringWrite, sends: (): number => sends, serialReads,
    toasts };
}

/* The refusal the composer throws when an arm asks it to: the real error type, so the module's injected test recognizes it exactly as it would on the page, carrying
 * a message unlike the sentence the save speaks.
 *
 * @returns The refusal.
 */
function composerRefusal(): ControllerListedError {

  const refusal = new ControllerListedError();

  refusal.message = COMPOSER_REFUSAL_MESSAGE;

  return refusal;
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

  const stood = stand({ probe: CHECK_FAILED, write: { kind: "committed" } });
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

  const stood = stand({ probe: passed("connected"), write: { kind: "committed" } });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, "the save answers the address it wrote");

  // The card's own retirement, made once the save has answered, aborts the signal the probe was handed. That is what shows the check ran as this card's newest
  // action rather than on a signal of the save's own making.
  stood.card.verdict.retire();

  assert.deepEqual(stood.probeCalls.map(({ signal, ...identity }) => ({ identity, retiredByTheCard: signal.aborted })),
    [{ identity: IDENTITY, retiredByTheCard: true }], "the probe received the card's identity and a check running as the card's own newest action");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
});

test("s3a: a committed save of a token-only controller speaks the sentence that says what credentials would add", async () => {

  const stood = stand({ probe: passed("token-only"), write: { kind: "committed" } });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, "the save answers the address it wrote");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "success", message: SAVED_TOKEN_ONLY }] });
});

test("s3b: a committed save of a controller that refused its API token warns that the plugin runs on the credentials alone", async () => {

  const stood = stand({ probe: passed("connected", true), write: { kind: "committed" } });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, "the save answers the address it wrote");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "warning", message: SAVED_TOKEN_REFUSED }] });
});

test("s4: an address edit drops the original address before the write and declares the rename on the write", async () => {

  const stood = stand({ probe: passed("connected"), write: { kind: "committed" } });

  seed(stood, ORIGINAL_ADDRESS, priorAt(ORIGINAL_ADDRESS));

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), ADDRESS, "the save answers the address it wrote");
  assert.deepEqual(stood.seenDuringWrite.map((seen) => seen.atOriginal), [undefined], "the original address is already empty when the write runs");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), undefined, "and it is still empty once the save has landed");
  assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
});

test("s5: a staged save warns that the file was not written, sends once, and declares an edited address's rename on its write", async () => {

  const stood = stand({ probe: passed("connected"), write: { error: new Error("the host could not write"), kind: "staged" } });

  seed(stood, ORIGINAL_ADDRESS, priorAt(ORIGINAL_ADDRESS));

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), ADDRESS, "the save answers the address it wrote");
  assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], sends: 1, stood, toasts: [{ kind: "warning", message: SAVED_STAGED }] });
});

test("s6a: a failed save restores what each address held and paints an Error's own message", async () => {

  const stood = stand({ probe: passed("connected"), write: { error: new Error("the host refused the write"), kind: "failed" } });
  const priorAtAddress = priorAt(ADDRESS);
  const priorAtOriginal = priorAt(ORIGINAL_ADDRESS);

  seed(stood, ADDRESS, priorAtAddress);
  seed(stood, ORIGINAL_ADDRESS, priorAtOriginal);

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), null, "the save answers null");
  assert.deepEqual(stood.actions.answers.get(ADDRESS), priorAtAddress, "the address the save wrote holds exactly what it held before");
  assert.deepEqual(stood.actions.answers.get(ORIGINAL_ADDRESS), priorAtOriginal, "the original address holds exactly what it held before");
  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: probeAnswer("connected"), generation: stood.seenDuringWrite[0]?.generation ?? -1 }),
    false, "a fetch issued against the seeded state loses its claim to be kept once the put-back has moved the generation");
  assert.deepEqual(stood.actions.answers.get(ADDRESS), priorAtAddress, "so the refused fetch wrote nothing over the restored answer");
  assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], renders: [{ detail: "the host refused the write", lines: [SAVE_FAILURE_LINE],
    tone: "text-danger" }], sends: 1, stood });
});

test("s6b: a failed save leaves both addresses empty where it found them empty, and paints a non-Error through String", async () => {

  const stood = stand({ probe: passed("connected"), write: { error: "the host answered in a shape it never writes", kind: "failed" } });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), null, "the save answers null");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "the address the save wrote is empty again");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), undefined, "the original address is empty too");
  assertSpoke({ renames: [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], renders: [{ detail: "the host answered in a shape it never writes",
    lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood });
});

test("s7a: an interpreter holder that rejects restores the map and paints the failure, without composing anything", async () => {

  const stood = stand({ interpretersThrow: true, probe: passed("connected"), write: { kind: "committed" } });
  const prior = priorAt(ADDRESS);
  const before = stood.actions.answers.generation();

  seed(stood, ADDRESS, prior);

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.deepEqual(stood.actions.answers.get(ADDRESS), prior, "the address holds exactly what it held before");
  assert.deepEqual(stood.composed, [], "the write never ran");

  /* The write never ran here, so there is no during-the-write reading of the generation to check against. The mark one past where the save started is the
   * same place: a save moves the generation once before the write, so a fetch holding that value is the fetch issued against the seeded state, and the
   * put-back is the only thing that can have moved past it.
   */
  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: probeAnswer("connected"), generation: before + 1 }), false,
    "a fetch issued against the seeded state loses its claim to be kept once the put-back has moved the generation");
  assert.deepEqual(stood.actions.answers.get(ADDRESS), prior, "so the refused fetch wrote nothing over the restored answer");
  assertSpoke({ renders: [{ detail: INTERPRETERS_FAILURE, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood });
});

test("s7b: a coordinated write that throws restores the map and paints the failure", async () => {

  const stood = stand({ probe: passed("connected"), write: new Error("the write threw") });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.deepEqual(stood.actions.answers.get(ADDRESS), prior, "the address holds exactly what it held before");
  assertSpoke({ renders: [{ detail: "the write threw", lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood });
});

test("s8: a write this page does not recognize answers null, keeps the seed, and says nothing", async () => {

  const assertIgnored = async (write: ControllerWriteResult): Promise<void> => {

    const label = write.kind + ": ";
    const stood = stand({ probe: passed("connected"), write });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assert.equal(stood.actions.answers.get(ADDRESS)?.devices[0]?.["processed"], PROCESSED, label + "the seed is left exactly where the save put it");
    assertSpoke({ label, sends: 0, stood });
  };

  // The kind sits outside the declared union, which is what the default arm exists for: the cast is this arm's statement that it is reaching a case the type
  // system says cannot arrive.
  await assertIgnored({ kind: "a-kind-this-page-does-not-know" } as unknown as ControllerWriteResult);
});

test("s9: the address a save writes is seeded with its own processed answer before the write runs", async () => {

  const stood = stand({ probe: passed("connected"), write: { kind: "committed" } });

  seed(stood, ADDRESS, priorAt(ADDRESS));

  await stood.actions.saveController({ card: stood.card, originalAddress: undefined });

  assert.equal(stood.seenDuringWrite.length, 1, "the write ran exactly once");

  const atAddress = stood.seenDuringWrite[0]?.atAddress;

  assert.ok(atAddress, "the address must already hold an answer by the time the write runs");
  assert.equal(atAddress.message, PROBE_MESSAGE, "the write saw this save's own answer rather than the one held before it");
  assert.deepEqual(atAddress.devices, [{ processed: PROCESSED, processedAddress: ADDRESS, serialNumber: PROBE_SERIAL }],
    "and saw it with the page's own decoration already applied");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
});

test("s10: a save moves the generation before the write, so a fetch captured earlier is refused afterwards", async () => {

  const stood = stand({ probe: passed("connected"), write: { kind: "committed" } });
  const mark = stood.actions.answers.generation();

  await stood.actions.saveController({ card: stood.card, originalAddress: undefined });

  assert.notEqual(stood.seenDuringWrite[0]?.generation, mark, "the generation had already moved by the time the write ran");
  assert.equal(stood.actions.answers.keep({ address: ORIGINAL_ADDRESS, answer: priorAt(ORIGINAL_ADDRESS), generation: mark }), false,
    "an answer captured before the save is refused after it");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), undefined, "and nothing is written for it");
});

test("s11: a save hands the interpreter the card's identity with the original address, and the write the patch that came back", async () => {

  const stood = stand({ probe: passed("connected"), write: { kind: "committed" } });

  await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS });

  assert.deepEqual(stood.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ORIGINAL_ADDRESS,
    originalSerial: undefined, serial: PROBE_SERIAL } }], "the save interpreter ran once, against the configuration the write composed over");
  assert.deepEqual(stood.composed, [SAVE_PATCH], "and the write received exactly the patch the interpreter composed");
  assert.deepEqual(stood.renames, [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], "beside the rename from the address the card started from to the one it wrote");
});

test("s12: a save that leaves the address alone seeds it before the write and declares no rename", async () => {

  const stood = stand({ probe: passed("connected"), write: { kind: "committed" } });

  seed(stood, ADDRESS, priorAt(ADDRESS));

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ADDRESS }), ADDRESS, "the save answers the address it wrote");
  assert.equal(stood.seenDuringWrite[0]?.atAddress?.message, PROBE_MESSAGE, "the address holds this save's own answer by the time the write runs");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
});

test("s13: a save reads the outgoing serial from the answer held under the address it is writing over, ahead of the seed that replaces it", async () => {

  const replacing = stand({ probe: passed("connected"), write: { kind: "committed" } });

  seed(replacing, ADDRESS, priorAt(ADDRESS));
  seed(replacing, ORIGINAL_ADDRESS, priorAt(ORIGINAL_ADDRESS));

  await replacing.actions.saveController({ card: replacing.card, originalAddress: ORIGINAL_ADDRESS });

  assert.deepEqual(replacing.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ORIGINAL_ADDRESS,
    originalSerial: PRIOR_SERIALS[ORIGINAL_ADDRESS], serial: PROBE_SERIAL } }],
  "an address edit reads the outgoing serial under the address it replaced, and the incoming one from this save's own validation");
  assert.deepEqual(replacing.serialReads.map((answer) => answer.message), [ PRIOR_MESSAGE, PROBE_MESSAGE ],
    "which is read from the answer this session was already holding rather than from the one the seed puts in its place");
  assert.deepEqual(replacing.renames, [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], "and the address edit declares its rename on the write");

  const same = stand({ probe: passed("connected"), write: { kind: "committed" } });

  seed(same, ADDRESS, priorAt(ADDRESS));

  await same.actions.saveController({ card: same.card, originalAddress: ADDRESS });

  assert.deepEqual(same.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ADDRESS,
    originalSerial: PRIOR_SERIALS[ADDRESS], serial: PROBE_SERIAL } }], "a save that leaves the address alone reads the outgoing serial under that same address");
  assert.deepEqual(same.serialReads.map((answer) => answer.message), [ PRIOR_MESSAGE, PROBE_MESSAGE ], "from the held answer there too, ahead of the seed");
});

test("s14: a token-only answer names no serial, on whichever side of the save it sits", async () => {

  const validated = stand({ probe: passed("token-only"), write: { kind: "committed" } });

  seed(validated, ADDRESS, priorAt(ADDRESS));

  await validated.actions.saveController({ card: validated.card, originalAddress: ADDRESS });

  assert.deepEqual(validated.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ADDRESS,
    originalSerial: PRIOR_SERIALS[ADDRESS], serial: undefined } }],
  "a token-only validation hands no serial, because the row it would be read from carries an address identity rather than one");
  assert.deepEqual(validated.serialReads.map((answer) => answer.message), [PRIOR_MESSAGE], "and that row goes unread");

  const held = stand({ probe: passed("connected"), write: { kind: "committed" } });

  seed(held, ADDRESS, { ...priorAt(ADDRESS), kind: "token-only" });

  await held.actions.saveController({ card: held.card, originalAddress: ADDRESS });

  assert.deepEqual(held.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ADDRESS, originalSerial: undefined,
    serial: PROBE_SERIAL } }], "and a token-only answer held under the address hands no outgoing serial either");
  assert.deepEqual(held.serialReads.map((answer) => answer.message), [PROBE_MESSAGE], "its row going unread the same way");
});

test("s15: a save whose card closes, leaves the screen, or is re-populated during its check still writes, and speaks its success through the toast", async () => {

  const assertWritten = async (event: CardEvent): Promise<void> => {

    const label = event + ": ";
    const stood = stand({ duringCheck: event, probe: passed("connected"), write: { kind: "committed" } });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, label + "the save answers the address it wrote");
    assert.deepEqual(stood.composed, [SAVE_PATCH], label + "and the write still received the patch the interpreter composed");
    assertSpoke({ label, sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
  };

  await assertWritten("close");
  await assertWritten("hide");
  await assertWritten("repopulate");
});

test("s16: a save whose check fails once its card has closed, left the screen, or been re-populated toasts the failure and paints nothing", async () => {

  const assertToasted = async (event: CardEvent): Promise<void> => {

    const label = event + ": ";
    const stood = stand({ duringCheck: event, probe: CHECK_FAILED, write: { kind: "committed" } });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assert.deepEqual(stood.composed, [], label + "nothing is composed");
    assertSpoke({ label, sends: 0, stood, toasts: [{ kind: "error", message: CHECK_FAILURE_TOAST }] });
  };

  await assertToasted("close");
  await assertToasted("hide");
  await assertToasted("repopulate");
});

test("s17: a save whose write fails once its card has stopped presenting it toasts the failure and paints nothing", async () => {

  const assertToasted = async ({ event, label, message, write }: { event: CardEvent; label: string; message: string;
    write: ControllerWriteResult | Error; }): Promise<void> => {

    const stood = stand({ duringWrite: event, probe: passed("connected"), write });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assertSpoke({ label, sends: 1, stood, toasts: [{ kind: "error", message }] });
  };

  const refused = (): ControllerWriteResult => ({ error: new Error("the host refused the write"), kind: "failed" });
  const refusedToast = "Unable to save this controller. the host refused the write";

  await assertToasted({ event: "close", label: "close, failed: ", message: refusedToast, write: refused() });
  await assertToasted({ event: "close", label: "close, thrown: ", message: "Unable to save this controller. the write threw", write: new Error("the write threw") });
  await assertToasted({ event: "edit", label: "edit, failed: ", message: refusedToast, write: refused() });
  await assertToasted({ event: "hide", label: "hide, failed: ", message: refusedToast, write: refused() });
  await assertToasted({ event: "repopulate", label: "repopulate, failed: ", message: refusedToast, write: refused() });
});

test("s18: an open card's failures paint on its verdict line and toast nothing", async () => {

  const checked = stand({ probe: CHECK_FAILED, write: { kind: "committed" } });

  assert.equal(await checked.actions.saveController({ card: checked.card, originalAddress: undefined }), null, "a failed check answers null");
  assertSpoke({ label: "check: ", renders: [CHECK_FAILURE], sends: 0, stood: checked });

  const written = stand({ probe: passed("connected"), write: { error: new Error("the host refused the write"), kind: "failed" } });

  assert.equal(await written.actions.saveController({ card: written.card, originalAddress: undefined }), null, "a failed write answers null");
  assertSpoke({ label: "write: ", renders: [{ detail: "the host refused the write", lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1,
    stood: written });
});

test("s19: an edit to the card's fields during a save's check cancels the save, which writes nothing and says nothing", async () => {

  const stood = stand({ duringCheck: "edit", probe: passed("connected"), write: { kind: "committed" } });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.deepEqual(stood.interpreterCalls, [], "no interpreter runs");
  assert.deepEqual(stood.composed, [], "nothing is composed");
  assertSpoke({ sends: 0, stood });
});

test("s20: a save whose original address is not a string declares no rename, and writes and speaks as any other save does", async () => {

  const stood = stand({ probe: passed("connected"), write: { kind: "committed" } });

  // A hand edit is the only way a configured address arrives as something other than a string, and the editors pass it through unconverted. Such a save still
  // replaces an address, but the framework refuses a rename whose keys are not strings, so the save declares none and writes rather than failing.
  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: 42 }), ADDRESS, "the save answers the address it wrote");
  assert.deepEqual(stood.composed, [SAVE_PATCH], "and the write received the patch the interpreter composed");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
});

test("s21: a save at an address another controller holds is refused before its connection test, writing nothing and saying the sentence on the card", async () => {

  const stood = stand({ listed: true, probe: passed("connected"), write: { kind: "committed" } });
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
    const stood = stand({ duringListedCheck: event, listed: true, probe: passed("connected"), write: { kind: "committed" } });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assert.equal(stood.probeCalls.length, 0, label + "the connection test never ran");
    assert.deepEqual(stood.composed, [], label + "nothing was composed or written");
    assertSpoke({ label, sends: 0, stood, toasts: [{ kind: "warning", message: LISTED_REFUSAL }] });
  };

  await assertToasted("close");
  await assertToasted("hide");
  await assertToasted("repopulate");
});

test("s23: a composer that refuses a listed address puts the answers back and says the page's sentence on the card, never the error's own message", async () => {

  const stood = stand({ composerThrows: composerRefusal(), probe: passed("connected"), write: { kind: "committed" } });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.equal(stood.probeCalls.length, 1, "the early check passed, so the connection test ran");
  assert.deepEqual(stood.composed, [], "the composer refused, so no patch reached the write");
  assert.deepEqual(stood.actions.answers.get(ADDRESS), prior, "the address holds exactly what it held before the seed");
  assertSpoke({ renders: [{ lines: [LISTED_REFUSAL], tone: "text-warning" }], sends: 1, stood });
});

test("s24: a composer's refusal met once the card has stopped presenting the save speaks through the warning toast and paints nothing", async () => {

  const assertToasted = async (event: CardEvent): Promise<void> => {

    const label = event + ": ";
    const stood = stand({ composerThrows: composerRefusal(), duringCheck: event, probe: passed("connected"), write: { kind: "committed" } });
    const prior = priorAt(ADDRESS);

    seed(stood, ADDRESS, prior);

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assert.deepEqual(stood.actions.answers.get(ADDRESS), prior, label + "the address holds exactly what it held before the seed");
    assertSpoke({ label, sends: 1, stood, toasts: [{ kind: "warning", message: LISTED_REFUSAL }] });
  };

  await assertToasted("close");
  await assertToasted("hide");
  await assertToasted("repopulate");
});

test("s25: a composer that throws anything else keeps the failure line and its detail, even an error carrying the refusal's sentence", async () => {

  const assertFailed = async (thrown: Error): Promise<void> => {

    const label = thrown.message + ": ";
    const stood = stand({ composerThrows: thrown, probe: passed("connected"), write: { kind: "committed" } });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assertSpoke({ label, renders: [{ detail: thrown.message, lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood });
  };

  await assertFailed(new Error("the composer threw"));

  // The refusal is told apart by its type alone, so an ordinary error whose message happens to be the sentence is still the failure it is.
  await assertFailed(new Error(LISTED_REFUSAL));
});

test("r1: a committed removal drops the answer, sends once, and says nothing at all", async () => {

  const stood = stand({ write: { kind: "committed" } });

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

  const stood = stand({ write: { error: new Error("the host could not write"), kind: "staged" } });

  seed(stood, ADDRESS, priorAt(ADDRESS));

  const mark = stood.actions.answers.generation();

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "what the session remembered goes with the controller");
  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: priorAt(ADDRESS), generation: mark }), false,
    "a fetch already in flight for the removed address cannot put it back");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "so the address is still empty after the refused fetch");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "warning", message: REMOVED_STAGED }] });
});

test("r3: a failed removal paints the failure on the card and keeps the answer", async () => {

  const stood = stand({ write: { error: new Error("the host refused the write"), kind: "failed" } });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the answer is still held under its address");
  assertSpoke({ renders: [{ detail: "the host refused the write", lines: [REMOVE_FAILURE_LINE], tone: "text-danger" }], sends: 0, stood });
});

test("r4: a removal whose write throws paints the failure and keeps the answer", async () => {

  const stood = stand({ write: new Error("the write threw") });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the answer is still held under its address");
  assertSpoke({ renders: [{ detail: "the write threw", lines: [REMOVE_FAILURE_LINE], tone: "text-danger" }], sends: 0, stood });
});

test("r5: a removal this page does not recognize says nothing and keeps the answer", async () => {

  const assertIgnored = async (write: ControllerWriteResult): Promise<void> => {

    const label = write.kind + ": ";
    const stood = stand({ write });
    const prior = priorAt(ADDRESS);

    seed(stood, ADDRESS, prior);

    await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

    assert.equal(stood.actions.answers.get(ADDRESS), prior, label + "the answer is still held under its address");
    assertSpoke({ label, sends: 0, stood });
  };

  // The kind sits outside the declared union, on the same terms the save's own arm states.
  await assertIgnored({ kind: "a-kind-this-page-does-not-know" } as unknown as ControllerWriteResult);
});

test("r6: a removal hands the interpreter the address and the chosen sweep, and the write the patch that came back", async () => {

  const stood = stand({ write: { kind: "committed" } });

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.deepEqual(stood.interpreterCalls, [{ config: PLATFORM, kind: "removed", payload: { address: ADDRESS, macs: MACS } }],
    "the removal interpreter ran once, against the configuration the write composed over");
  assert.deepEqual(stood.composed, [REMOVE_PATCH], "and the write received exactly the patch the interpreter composed");
});

test("a1: an answer that failed is refused, and nothing is written for it", () => {

  const stood = stand({ write: { kind: "committed" } });

  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: failedAnswer(), generation: stood.actions.answers.generation() }), false,
    "a failure is never kept");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "and nothing is held under its address");
});

test("a2: an answer an invalidation overtook is refused, and nothing is written for it", () => {

  const stood = stand({ write: { kind: "committed" } });
  const mark = stood.actions.answers.generation();

  stood.actions.answers.clear();

  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: priorAt(ADDRESS), generation: mark }), false, "an overtaken answer is dropped");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "and nothing is held under its address");
});

test("a3: a success offered at the current generation is kept, and reads back as the same answer", () => {

  const stood = stand({ write: { kind: "committed" } });
  const answer = priorAt(ADDRESS);

  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer, generation: stood.actions.answers.generation() }), true, "the answer is kept");
  assert.equal(stood.actions.answers.get(ADDRESS), answer, "and reads back as the very answer that was offered");
});

test("a4: clearing empties the answers and moves the generation", () => {

  const stood = stand({ write: { kind: "committed" } });

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

// One request the bridge double is handed.
interface BridgeRequest {

  path: string;
  payload: unknown;
}

// A built connection check and every request its bridge double was handed.
interface ProbeStand {

  check: ReturnType<typeof makeControllerProbe>;
  requests: BridgeRequest[];
}

/* Build the connection check over a bridge double and the real probe classifier, identity rule, and rejection reading.
 *
 * The bridge double records each request, runs the row's own step where it has one, and hands back the promise the row's answer makes, so a row decides whether
 * the request fulfills, rejects, or is retired while it is in flight.
 *
 * @param options.answer    - What the bridge settles the request with.
 * @param options.onRequest - What befalls the check while its request is in flight.
 *
 * @returns The check and every request its bridge double was handed.
 */
function standProbe({ answer, onRequest }: { answer: () => Promise<unknown>; onRequest?: () => void }): ProbeStand {

  const requests: BridgeRequest[] = [];
  const check = makeControllerProbe({

    classifyProbeResponse,
    hasValidIdentity,
    readProbeRejection,
    request: (path, payload) => {

      requests.push({ path, payload });
      onRequest?.();

      return answer();
    }
  });

  return { check, requests };
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
