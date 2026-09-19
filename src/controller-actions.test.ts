/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.test.ts: The settings page's kept controller answers and the two configuration actions that write them, driven through recording fakes for
 * every reach the module makes outside itself.
 *
 * What these arms prove is the part of a save and a removal no type can state: that each write outcome speaks in exactly the sentence and exactly the severity it
 * is supposed to, that the seed a save makes lands BEFORE the write rather than after it, that a write which failed puts both addresses back exactly as it found
 * them, and that a send follows every write that keeps or drops an answer and follows nothing else. A swapped toast severity, a put-back that restores the wrong
 * address, a dropped generation bump, and a re-select that fires on the wrong outcome each redden an arm here.
 *
 * Every arm asserts the exact toast list, the exact verdict list, the exact send count, and the exact re-select list, so an arm proves the absence of the other
 * outcomes as precisely as the presence of its own. The two addresses differ, their device serials differ, and the answer already held under an address differs
 * from the one the probe returns, so a restore that puts back the wrong thing cannot coincide with one that puts back the right thing.
 *
 * A re-select records the number of sends that had already been made when it was asked for, which is what makes "the re-select follows the send" a proof rather
 * than an agreement with the order the two happened to be written in.
 */
import type { AccessIdentity, AccessProbeSuccess, AccessProbeVerdict } from "../homebridge-ui/public/access-config.mjs";
import type { ControllerActions, ControllerCard, ControllerWriteResult } from "../homebridge-ui/public/controller-actions.mjs";
import assert from "node:assert/strict";
import { makeControllerActions } from "../homebridge-ui/public/controller-actions.mjs";
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
const SAVED_STAGED = "This controller has been saved, but Homebridge could not write the configuration file. Save the plugin's settings to keep the change.";
const REMOVED_STAGED = "This controller has been removed, but Homebridge could not write the configuration file. Save the plugin's settings to keep the change.";
const SAVE_FAILURE_LINE = "Unable to save this controller.";
const REMOVE_FAILURE_LINE = "Unable to remove this controller.";

// What the interpreter holder throws when an arm asks it to.
const INTERPRETERS_FAILURE = "the served catalog could not be read";

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

// One re-select, carrying the number of sends already made when it was asked for.
interface Selection {

  address: unknown;
  sends: number;
}

// One toast, by the severity it was spoken at and the sentence it carried.
interface Toast {

  kind: "success" | "warning";
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
  probeCalls: unknown[];
  renders: RenderedVerdict[];
  seenDuringWrite: WriteObservation[];
  selections: Selection[];
  sends: () => number;
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
 * @param kind - Whether the controller answered with credentials or with an API token alone.
 *
 * @returns The probe's answer.
 */
function probeAnswer(kind: "connected" | "token-only"): AccessProbeSuccess {

  return { devices: [device(PROBE_SERIAL)], kind, message: PROBE_MESSAGE };
}

/* The answer this session was already holding for an address, deliberately unlike anything a probe here returns.
 *
 * @param address - The address the answer is held under.
 *
 * @returns The answer.
 */
function priorAt(address: string): AccessProbeSuccess {

  return { devices: [device(PRIOR_SERIALS[address] ?? address)], kind: "connected", message: PRIOR_MESSAGE };
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
 * @param options.interpretersThrow - Whether the interpreter holder rejects rather than answering.
 * @param options.probe             - What the connection validation answers, or null for the failure that writes nothing.
 * @param options.write             - The result the coordinated write resolves with, or the error it throws.
 *
 * @returns The actions and every recorder beneath them.
 */
function stand({ interpretersThrow = false, probe, write }: { interpretersThrow?: boolean; probe: AccessProbeSuccess | null;
  write: ControllerWriteResult | Error; }): Stand {

  const composed: unknown[] = [];
  const interpreterCalls: InterpreterCall[] = [];
  const probeCalls: unknown[] = [];
  const renders: RenderedVerdict[] = [];
  const seenDuringWrite: WriteObservation[] = [];
  const selections: Selection[] = [];
  const toasts: Toast[] = [];
  let sends = 0;

  /* The card an action acts for. Only the field read and the verdict paint are ever reached: the probe is a fake here, so the two members it would invalidate and
   * test against are stubs no arm asserts.
   */
  const card: ControllerCard = {

    values: () => ({ ...IDENTITY }),
    verdict: {

      invalidate: (): number => 0,
      isCurrent: (): boolean => true,
      render: (options = {}): void => {

        renders.push(options);
      }
    }
  };

  const actions: ControllerActions = makeControllerActions({

    commitConfig: async (compose) => {

      // What the answers held, and which generation they were on, at the moment the write ran. This is what places the seed and the bump ahead of the write rather
      // than behind it, which no assertion made after the save resolves could tell apart.
      seenDuringWrite.push({ atAddress: actions.answers.get(ADDRESS), atOriginal: actions.answers.get(ORIGINAL_ADDRESS),
        generation: actions.answers.generation() });
      composed.push(compose(PLATFORM));

      if(write instanceof Error) {

        throw write;
      }

      return write;
    },
    interpreters: async () => {

      if(interpretersThrow) {

        throw new Error(INTERPRETERS_FAILURE);
      }

      return {

        withControllerRemoved: (config, removal) => {

          interpreterCalls.push({ config, kind: "removed", payload: removal });

          return REMOVE_PATCH;
        },
        withControllerSaved: (config, controller) => {

          interpreterCalls.push({ config, kind: "saved", payload: controller });

          return SAVE_PATCH;
        }
      };
    },
    probe: async (request) => {

      // The request the save composed, kept because the real probe dereferences the verdict surface on it before anything else it does.
      probeCalls.push(request);

      return probe;
    },
    processDeviceList: ({ address, devices }) => {

      for(const record of devices) {

        record["processed"] = PROCESSED;
        record["processedAddress"] = address;
      }

      return devices;
    },
    selectController: (address) => {

      selections.push({ address, sends });
    },
    sendStatusContext: async () => {

      sends++;
    },
    toast: {

      success: (message) => {

        toasts.push({ kind: "success", message });
      },
      warning: (message) => {

        toasts.push({ kind: "warning", message });
      }
    }
  });

  return { actions, card, composed, interpreterCalls, probeCalls, renders, seenDuringWrite, selections, sends: (): number => sends, toasts };
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
 * @param expected.renders     - The verdicts painted on the card, in order.
 * @param expected.selections  - The re-selects asked for, each with the sends already made when it was.
 * @param expected.sends       - How many times the status context was sent.
 * @param expected.stood       - The stand to read.
 * @param expected.toasts      - The toasts spoken, in order.
 */
function assertSpoke({ label = "", renders = [], selections = [], sends, stood, toasts = [] }: { label?: string; renders?: RenderedVerdict[];
  selections?: Selection[]; sends: number; stood: Stand; toasts?: Toast[]; }): void {

  assert.deepEqual(stood.toasts, toasts, label + "the toasts spoken");
  assert.deepEqual(stood.renders, renders, label + "the verdicts painted on the card");
  assert.equal(stood.sends(), sends, label + "the status-context sends made");
  assert.deepEqual(stood.selections, selections, label + "the sidebar re-selects asked for");
}

test("s1: a save whose validation fails writes nothing, touches no answer, and says nothing", async () => {

  const stood = stand({ probe: null, write: { kind: "committed" } });
  const before = stood.actions.answers.generation();

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "nothing is held for the address the card names");
  assert.equal(stood.actions.answers.generation(), before, "the generation does not move");
  assert.deepEqual(stood.interpreterCalls, [], "no interpreter runs");
  assert.deepEqual(stood.composed, [], "nothing is composed");
  assert.equal(stood.probeCalls.length, 1, "the validation still ran, which is what answered the failure");
  assertSpoke({ sends: 0, stood });
});

test("s2: a committed save of a connected controller speaks its plain sentence, sends once, and answers the address", async () => {

  const stood = stand({ probe: probeAnswer("connected"), write: { kind: "committed" } });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, "the save answers the address it wrote");
  assert.deepEqual(stood.probeCalls, [{ ...IDENTITY, verdict: stood.card.verdict }],
    "the probe received the card's identity and the card's own verdict surface");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
});

test("s3: a committed save of a token-only controller speaks the sentence that says what credentials would add", async () => {

  const stood = stand({ probe: probeAnswer("token-only"), write: { kind: "committed" } });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), ADDRESS, "the save answers the address it wrote");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "success", message: SAVED_TOKEN_ONLY }] });
});

test("s4: an address edit drops the original address before the write and re-selects the new address after the send", async () => {

  const stood = stand({ probe: probeAnswer("connected"), write: { kind: "committed" } });

  seed(stood, ORIGINAL_ADDRESS, priorAt(ORIGINAL_ADDRESS));

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), ADDRESS, "the save answers the address it wrote");
  assert.deepEqual(stood.seenDuringWrite.map((seen) => seen.atOriginal), [undefined], "the original address is already empty when the write runs");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), undefined, "and it is still empty once the save has landed");
  assertSpoke({ selections: [{ address: ADDRESS, sends: 1 }], sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
});

test("s5: a staged save warns that the file was not written, sends once, and re-selects an edited address after the send", async () => {

  const stood = stand({ probe: probeAnswer("connected"), write: { error: new Error("the host could not write"), kind: "staged" } });

  seed(stood, ORIGINAL_ADDRESS, priorAt(ORIGINAL_ADDRESS));

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), ADDRESS, "the save answers the address it wrote");
  assertSpoke({ selections: [{ address: ADDRESS, sends: 1 }], sends: 1, stood, toasts: [{ kind: "warning", message: SAVED_STAGED }] });
});

test("s6a: a failed save restores what each address held and paints an Error's own message", async () => {

  const stood = stand({ probe: probeAnswer("connected"), write: { error: new Error("the host refused the write"), kind: "failed" } });
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
  assertSpoke({ renders: [{ detail: "the host refused the write", lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood });
});

test("s6b: a failed save leaves both addresses empty where it found them empty, and paints a non-Error through String", async () => {

  const stood = stand({ probe: probeAnswer("connected"), write: { error: "the host answered in a shape it never writes", kind: "failed" } });

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS }), null, "the save answers null");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "the address the save wrote is empty again");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), undefined, "the original address is empty too");
  assertSpoke({ renders: [{ detail: "the host answered in a shape it never writes", lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood });
});

test("s7a: an interpreter holder that rejects restores the map and paints the failure, without composing anything", async () => {

  const stood = stand({ interpretersThrow: true, probe: probeAnswer("connected"), write: { kind: "committed" } });
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

  const stood = stand({ probe: probeAnswer("connected"), write: new Error("the write threw") });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, "the save answers null");
  assert.deepEqual(stood.actions.answers.get(ADDRESS), prior, "the address holds exactly what it held before");
  assertSpoke({ renders: [{ detail: "the write threw", lines: [SAVE_FAILURE_LINE], tone: "text-danger" }], sends: 1, stood });
});

test("s8: a superseded write and one this page does not recognize each answer null, keep the seed, and say nothing", async () => {

  // Both outcomes take exactly this path, so the arm states it once and drives it for each.
  const assertIgnored = async (write: ControllerWriteResult): Promise<void> => {

    const label = write.kind + ": ";
    const stood = stand({ probe: probeAnswer("connected"), write });

    assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: undefined }), null, label + "the save answers null");
    assert.equal(stood.actions.answers.get(ADDRESS)?.devices[0]?.["processed"], PROCESSED, label + "the seed is left exactly where the save put it");
    assertSpoke({ label, sends: 0, stood });
  };

  await assertIgnored({ kind: "superseded" });

  // The second kind sits outside the declared union, which is what the default arm exists for: the cast is this arm's statement that it is reaching a case the
  // type system says cannot arrive.
  await assertIgnored({ kind: "a-kind-this-page-does-not-know" } as unknown as ControllerWriteResult);
});

test("s9: the address a save writes is seeded with its own processed answer before the write runs", async () => {

  const stood = stand({ probe: probeAnswer("connected"), write: { kind: "committed" } });

  seed(stood, ADDRESS, priorAt(ADDRESS));

  await stood.actions.saveController({ card: stood.card, originalAddress: undefined });

  assert.equal(stood.seenDuringWrite.length, 1, "the write ran exactly once");
  assert.equal(stood.seenDuringWrite[0]?.atAddress?.message, PROBE_MESSAGE, "the write saw this save's own answer rather than the one held before it");
  assert.deepEqual(stood.seenDuringWrite[0]?.atAddress?.devices, [{ processed: PROCESSED, processedAddress: ADDRESS, serialNumber: PROBE_SERIAL }],
    "and saw it with the page's own decoration already applied");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
});

test("s10: a save moves the generation before the write, so a fetch captured earlier is refused afterwards", async () => {

  const stood = stand({ probe: probeAnswer("connected"), write: { kind: "committed" } });
  const mark = stood.actions.answers.generation();

  await stood.actions.saveController({ card: stood.card, originalAddress: undefined });

  assert.notEqual(stood.seenDuringWrite[0]?.generation, mark, "the generation had already moved by the time the write ran");
  assert.equal(stood.actions.answers.keep({ address: ORIGINAL_ADDRESS, answer: priorAt(ORIGINAL_ADDRESS), generation: mark }), false,
    "an answer captured before the save is refused after it");
  assert.equal(stood.actions.answers.get(ORIGINAL_ADDRESS), undefined, "and nothing is written for it");
});

test("s11: a save hands the interpreter the card's identity with the original address, and the write the patch that came back", async () => {

  const stood = stand({ probe: probeAnswer("connected"), write: { kind: "committed" } });

  await stood.actions.saveController({ card: stood.card, originalAddress: ORIGINAL_ADDRESS });

  assert.deepEqual(stood.interpreterCalls, [{ config: PLATFORM, kind: "saved", payload: { ...IDENTITY, originalAddress: ORIGINAL_ADDRESS } }],
    "the save interpreter ran once, against the configuration the write composed over");
  assert.deepEqual(stood.composed, [SAVE_PATCH], "and the write received exactly the patch the interpreter composed");
});

test("s12: a save that leaves the address alone seeds it before the write and asks for no re-select", async () => {

  const stood = stand({ probe: probeAnswer("connected"), write: { kind: "committed" } });

  seed(stood, ADDRESS, priorAt(ADDRESS));

  assert.equal(await stood.actions.saveController({ card: stood.card, originalAddress: ADDRESS }), ADDRESS, "the save answers the address it wrote");
  assert.equal(stood.seenDuringWrite[0]?.atAddress?.message, PROBE_MESSAGE, "the address holds this save's own answer by the time the write runs");
  assertSpoke({ sends: 1, stood, toasts: [{ kind: "success", message: SAVED_CONNECTED }] });
});

test("r1: a committed removal drops the answer, sends once, and says nothing at all", async () => {

  const stood = stand({ probe: null, write: { kind: "committed" } });

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

  const stood = stand({ probe: null, write: { error: new Error("the host could not write"), kind: "staged" } });

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

  const stood = stand({ probe: null, write: { error: new Error("the host refused the write"), kind: "failed" } });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the answer is still held under its address");
  assertSpoke({ renders: [{ detail: "the host refused the write", lines: [REMOVE_FAILURE_LINE], tone: "text-danger" }], sends: 0, stood });
});

test("r4: a removal whose write throws paints the failure and keeps the answer", async () => {

  const stood = stand({ probe: null, write: new Error("the write threw") });
  const prior = priorAt(ADDRESS);

  seed(stood, ADDRESS, prior);

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.equal(stood.actions.answers.get(ADDRESS), prior, "the answer is still held under its address");
  assertSpoke({ renders: [{ detail: "the write threw", lines: [REMOVE_FAILURE_LINE], tone: "text-danger" }], sends: 0, stood });
});

test("r5: a superseded removal and one this page does not recognize each say nothing and keep the answer", async () => {

  // Both outcomes take exactly this path, so the arm states it once and drives it for each.
  const assertIgnored = async (write: ControllerWriteResult): Promise<void> => {

    const label = write.kind + ": ";
    const stood = stand({ probe: null, write });
    const prior = priorAt(ADDRESS);

    seed(stood, ADDRESS, prior);

    await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

    assert.equal(stood.actions.answers.get(ADDRESS), prior, label + "the answer is still held under its address");
    assertSpoke({ label, sends: 0, stood });
  };

  await assertIgnored({ kind: "superseded" });

  // The second kind sits outside the declared union, on the same terms the save's own arm states.
  await assertIgnored({ kind: "a-kind-this-page-does-not-know" } as unknown as ControllerWriteResult);
});

test("r6: a removal hands the interpreter the address and the chosen sweep, and the write the patch that came back", async () => {

  const stood = stand({ probe: null, write: { kind: "committed" } });

  await stood.actions.removeController({ address: ADDRESS, card: stood.card, macs: MACS });

  assert.deepEqual(stood.interpreterCalls, [{ config: PLATFORM, kind: "removed", payload: { address: ADDRESS, macs: MACS } }],
    "the removal interpreter ran once, against the configuration the write composed over");
  assert.deepEqual(stood.composed, [REMOVE_PATCH], "and the write received exactly the patch the interpreter composed");
});

test("a1: an answer that failed is refused, and nothing is written for it", () => {

  const stood = stand({ probe: null, write: { kind: "committed" } });

  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: failedAnswer(), generation: stood.actions.answers.generation() }), false,
    "a failure is never kept");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "and nothing is held under its address");
});

test("a2: an answer an invalidation overtook is refused, and nothing is written for it", () => {

  const stood = stand({ probe: null, write: { kind: "committed" } });
  const mark = stood.actions.answers.generation();

  stood.actions.answers.clear();

  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer: priorAt(ADDRESS), generation: mark }), false, "an overtaken answer is dropped");
  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "and nothing is held under its address");
});

test("a3: a success offered at the current generation is kept, and reads back as the same answer", () => {

  const stood = stand({ probe: null, write: { kind: "committed" } });
  const answer = priorAt(ADDRESS);

  assert.equal(stood.actions.answers.keep({ address: ADDRESS, answer, generation: stood.actions.answers.generation() }), true, "the answer is kept");
  assert.equal(stood.actions.answers.get(ADDRESS), answer, "and reads back as the very answer that was offered");
});

test("a4: clearing empties the answers and moves the generation", () => {

  const stood = stand({ probe: null, write: { kind: "committed" } });

  seed(stood, ADDRESS, priorAt(ADDRESS));

  const mark = stood.actions.answers.generation();

  stood.actions.answers.clear();

  assert.equal(stood.actions.answers.get(ADDRESS), undefined, "nothing is held any more");
  assert.notEqual(stood.actions.answers.generation(), mark, "and a fetch issued before the clear has lost its claim to be kept");
});
