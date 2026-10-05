/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.mjs: The settings page's controller connection check, its kept controller answers, and the controller save and removal that write them.
 */
"use strict";

/* The single home for the controller connection check every card and the first-run submit share, for what the settings page remembers about each configured
 * controller, and for the configuration actions that change it - a controller's save and a controller's removal. The memory is private here and the page reads it
 * through a small handle, so the rule deciding whether an answer is worth keeping is stated once rather than at every site that fills one, and the seed, the
 * delete, and the generation bump each action makes stay out of reach of every reader that has no business making them.
 *
 * The module takes no imports at all and names no browser global. Every reach beyond it is handed in: the UI-server bridge's request, the probe classifier, the
 * rejection's reading, and the identity rule the connection check runs over, and the connection check, the configuration interpreters, the listed-address rule and
 * its sentence, the page's read of its configuration, the serial read, the host's toast, the framework's coordinated write, the status-context send, and the
 * device-list decoration the save and the removal run over. A save runs through the save flow its card carries. That is what lets the whole of it run under node
 * against recording doubles and the real save flow, which puts a swapped toast severity, a put-back that restores the wrong address, a seed that lands after its
 * write, and a connection check that drops a failure's sentence in front of a gate rather than in front of a user.
 */

// What a save says when the controller it validated refused the API token beside the credentials. The first-run submit speaks the same sentence, so it is stated
// once, here beside the save that speaks it.
export const TOKEN_REFUSED_WARNING = "This controller has been saved, but it did not accept the API token. The plugin will use the local user's username and " +
  "password alone; webhooks and the doorbell trigger need an API token the controller accepts.";

// The message a thrown value or a failed write's error carries, read the one way this module's failure paints read it: an error's own message, and anything else
// as its text.
const errorMessage = (error) => (error instanceof Error) ? error.message : String(error);

/* The words of one outcome as the single message a toast carries: its sentences, then any failure detail, in the order the line shows them, with an empty part
 * dropped rather than joined. An outcome is composed once and delivered to whichever surface presents it, so the toast says exactly what the line would have said.
 * The host renders the message as text, so a controller-reported detail is never interpreted as markup here either.
 */
const toastMessage = ({ detail = "", lines = [] }) => [ ...lines, detail ].filter((part) => part.length).join(" ");

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
export const makeControllerActions = ({ commitConfig, controllerListedElsewhere, controllerListedWarning, controllerSerial, interpreters, platformConfig,
  processDeviceList, requestControllerProbe, sendStatusContext, toast }) => {

  /* Each controller address's probe answer, as this session last received it and already processed for the framework to render. What is kept is the whole answer -
   * its outcome tag alongside its device list - rather than the list alone, because a healthy controller with nothing to list and a controller that could not be
   * reached both answer an empty list and the page must go on telling them apart on every later re-entry.
   *
   * One answer serves every reader that needs it: the device view returns it on every re-entry, a removal derives from it the MAC addresses a settings sweep would
   * strip, and the sidebar reads the controller's own name from it. A controller connection costs a user real dead air, and almost nothing about a controller
   * changes between one re-entry and the next, so that price is paid once per address per session and the Refresh control is how a user asks to pay it again.
   *
   * Only an answer that actually arrived is ever kept, and the gate is the outcome tag rather than the list's length: a token-only controller's empty answer is a
   * real answer and caches like any other, while a failure writes nothing here so the connection-error view and the framework's own retry cycle always act on a
   * live attempt rather than on a hopeful memory of one. The map lives as long as the actions the page built, which is the page's own lifetime, so a reopened
   * panel connects afresh.
   */
  const byAddress = new Map();

  /* The generation the map above is on, bumped by every event that retires what it holds: a controller saved, a controller removed, and the Refresh control. A
   * fetch captures this value before it calls the bridge and compares it after, writing only when the two still agree.
   *
   * The bridge offers no cancellation, so a fetch issued before an invalidation cannot be recalled and would otherwise be free to land its pre-invalidation answer
   * afterwards - the same supersession problem a card's login verdict meets. A card answers it with a latest-action-wins guard, because each of its validations
   * replaces the last; fetches for different controllers run side by side and none of them may retire another, so here only an invalidation moves the counter. A
   * retired fill costs one extra fetch at the next selection, where a stale serve would cost the rest of the session. One counter covers every address
   * deliberately: its only failure mode is that extra fetch, and a counter nobody can misindex beats a map of counters somebody can.
   */
  let generation = 0;

  /* The whole of what a reader may do with the kept answers: empty them, read the generation a fetch belongs to, read one address's answer, and offer an answer
   * for keeping. The seed, the delete, and the bump each action below makes are deliberately absent, because each is a step inside a write rather than something a
   * reader is ever right to do on its own.
   */
  const answers = {

    // The Refresh control's whole handler: the generation moves so every fetch in flight loses its claim to be kept, and what is held goes.
    clear: () => {

      generation++;
      byAddress.clear();
    },

    // The generation a fetch captures before it calls the bridge, to hand back alongside the answer it receives.
    generation: () => generation,

    // One address's kept answer, or undefined where this session holds none for it.
    get: (address) => byAddress.get(address),

    /* Keep what a fetch answered, where it is still worth keeping, and say whether it was kept so the caller knows whether anything follows from it. A failure is
     * never kept, which is what keeps the connection-error view and its retry acting on live attempts; an answer a save or a removal overtook while it was in
     * flight is dropped for the same reason, at the cost of one more fetch the next time this controller is selected.
     */
    keep: ({ address, answer, generation: mark }) => {

      if((answer.kind === "error") || (mark !== generation)) {

        return false;
      }

      byAddress.set(address, answer);

      return true;
    }
  };

  // Put one address back to the answer it held, or take it out where it held none.
  const putBack = (address, prior) => {

    if(prior === undefined) {

      byAddress.delete(address);

      return;
    }

    byAddress.set(address, prior);
  };

  /* Seed the kept answers for a save about to be written, and answer the restore that undoes the seed where the write does not land.
   *
   * The seed goes AHEAD of the write rather than after it, because the page re-reads through getControllers and getDevices inside the write and getDevices answers
   * from these answers: a seed made afterwards would leave the page showing what the controller answered before the save, a token-only list for a controller that
   * has just been given credentials above all. The generation moves, so every fetch still in flight loses its claim to be kept; an address change strands whatever
   * was remembered under the address the user replaced, which names nothing the configuration will hold; and the written address takes this save's own check
   * answer, which connected to the controller with exactly this identity moments ago, kept whole with its outcome tag over the processed device list. The list is
   * processed before anything here changes, so a list the processing cannot read leaves the answers as they were.
   *
   * What the answers held under each address the seed touches is read first, so the restore puts each one back exactly, or takes it out where there was none, and
   * moves the generation again so a fetch issued against the seeded state loses its claim too. The restore ends with a send of the status context, so the
   * live-status feed's registry follows the put-back as it follows every other write of these answers.
   */
  const seed = ({ address, answer, replacedAddress }) => {

    const processed = { ...answer, devices: processDeviceList({ address, devices: answer.devices }) };
    const priorAtAddress = byAddress.get(address);
    const priorAtReplaced = (replacedAddress === undefined) ? undefined : byAddress.get(replacedAddress);

    generation++;

    if(replacedAddress !== undefined) {

      byAddress.delete(replacedAddress);
    }

    byAddress.set(address, processed);

    return () => {

      putBack(address, priorAtAddress);

      if(replacedAddress !== undefined) {

        putBack(replacedAddress, priorAtReplaced);
      }

      generation++;
      void sendStatusContext();
    };
  };

  /* Check that a card's address is not already listed, validate its connection, and persist it, which is the whole of what Save means.
   *
   * A press runs through the save flow its card carries, which holds every press to the same rules. A press that arrives while a write is in flight starts nothing,
   * and the card's Save control is not pressable for the write's span. A press begins its action through the card's own starter, so only the card's own retiring
   * acts - an edit to its fields, a Validate press, or another Save - cancel it, and only while its check is in flight; once the write has started, nothing cancels
   * it. Closing the card, re-populating it, or taking it off screen is moving on rather than cancelling, so a pressed Save goes on to write if its check passes.
   *
   * The check starts nothing of its own, because a second action on the card would retire the press it belongs to. A save whose address another configured
   * controller already holds is refused before its connection check, asked of the configuration the page last received: the answer needs no controller, and a user
   * should not wait on a connection whose result would be thrown away. The connection check comes next and a failure writes nothing at all: a controller the plugin
   * cannot connect to is not a configuration worth saving. A check that passes then reads what the composer needs and cannot read for itself: the serials the
   * controller's feature options move between, and the served catalog, whose read is asynchronous where the composer is not.
   *
   * The write is handed to the feature-options page as a composer rather than made through a session of the card's own, because the page's store holds the options
   * array the user loaded and a write made behind it is one the next option edit writes back over. The page drains whatever option edits are in flight, composes
   * against the configuration as it then stands, writes and saves through the one session it owns, and re-establishes itself on what was written. The composer asks
   * the listed-address rule again of that configuration, which is how a save queued behind another that changed it is still refused, and only a patch it composes
   * seeds the kept answers.
   *
   * Success speaks through the host's toast rather than the card's line, because the page's re-establishment re-populates the docked card, which blanks its line,
   * and a re-entry discards the frame the card sits on altogether. A refusal speaks in the warning tone and a failure in the error tone, each through the press's own
   * delivery: on the card while the card still presents the press, and on the host's toast otherwise. A write that reached the host's memory but not its disk is a
   * save the user's own Save completes, so it warns and counts as saved.
   *
   * A press whose write did not land puts back what its seed replaced. Where another write seeded the same address in the meantime, that put-back can restore an
   * older answer than the one the configuration now holds; the cost is a stale sidebar label until the next Refresh.
   *
   * An address change replaces the controller's sidebar key, which is its configured address, so the write declares the change as a rename from the address the
   * card started from to the one it wrote, and the page's framework carries the selection. It does so once the controller lists from before and after the write
   * prove the rename, and only while the selection still names the controller's previous key, so a user who moved to another controller while the save was in
   * flight stays where they went.
   *
   * @returns The address that was written, or null when nothing was.
   */
  const saveController = async ({ card, originalAddress }) => {

    const { address, password, tokens, username, verifyTls } = card.values();
    const replaced = Boolean(originalAddress) && (originalAddress !== address);

    // This press's delivery, kept from its check so a press the write rejects still speaks under the press's own rule, and the restore its composer answers once
    // it seeds. Each belongs to this press alone, so a later press on the same card can neither speak through this one's delivery nor undo this one's seed.
    let deliver = null;
    let restore = null;

    // Speak one outcome through a press's delivery: painted on the card in the outcome's tone while the card presents the press, and raised on the named toast
    // otherwise.
    const speak = (delivery, { channel, outcome, tone }) => delivery({ channel, paint: () => card.verdict.render({ ...outcome, tone }), text: toastMessage(outcome) });

    // The refusal of an address another controller already holds, which is guidance rather than failure, and a save's failure, which carries what went wrong.
    const listed = { channel: "warning", outcome: { lines: [controllerListedWarning] }, tone: "text-warning" };
    const failure = (error) => ({ channel: "error", outcome: { detail: errorMessage(error), lines: ["Unable to save this controller."] }, tone: "text-danger" });

    let result;

    try {

      result = await card.flow.save({

        check: async (context) => {

          deliver = context.deliver;

          if(controllerListedElsewhere(platformConfig(), { address, originalAddress })) {

            return { kind: "declined", reason: { kind: "listed" } };
          }

          // A check that answers retired belongs to a press a newer act on the card has already retired, and the flow answers that press superseded before it
          // reads what the check returned.
          const probe = await requestControllerProbe({ address, password, signal: context.signal, tokens, username, verifyTls });

          if(probe.kind !== "passed") {

            return { kind: "declined", reason: probe };
          }

          /* The serial the controller being edited answered by when this session last reached it, and the serial this save's own check answered. The composer
           * carries the controller's feature options from the first onto the second, which is why the outgoing one is read here, ahead of the seed that replaces
           * the answer it comes from: a credential pair being cleared is exactly the case where that serial exists nowhere else, because the token-only check that
           * follows reads no console document to name it, and a Refresh while the page's write queue waits empties the kept answers it is read from. Each read is
           * gated on the answer's kind because a token-only answer's controller row carries the address identity the UI server spelled for it rather than a
           * serial, and the composer derives that identity from the address itself.
           */
          const serialOf = (answer) => ((answer?.kind === "connected") ? controllerSerial(answer) : undefined);
          const originalSerial = serialOf(byAddress.get(replaced ? originalAddress : address));
          const serial = serialOf(probe.answer);

          // The flow's composer runs synchronously inside the write and the catalog read does not, so the read belongs to the check, and a read that fails
          // declines the press with nothing seeded.
          let withControllerSaved;

          try {

            ({ withControllerSaved } = await interpreters());
          } catch(error) {

            return { kind: "declined", reason: { kind: "failed", outcome: failure(error).outcome } };
          }

          return { kind: "passed", value: { answer: probe.answer, originalSerial, serial, withControllerSaved } };
        },
        compose: (platform, { answer, originalSerial, serial, withControllerSaved }) => {

          const patch = withControllerSaved(platform, { address, originalAddress, originalSerial, password, serial, tokens, username, verifyTls });

          if(patch === null) {

            return null;
          }

          restore = seed({ address, answer, replacedAddress: replaced ? originalAddress : undefined });

          return patch;
        },

        // The framework refuses a rename whose keys are not strings, so an original address a hand edit left as anything else declares none rather than turning a
        // save that would write into a failure.
        rename: (replaced && (typeof originalAddress === "string") && (typeof address === "string")) ? { from: originalAddress, to: address } : undefined
      });
    } catch(error) {

      // A rejected press is a bug in code the press ran, and whatever its composer seeded goes back. It speaks through the delivery its check kept, under the
      // press's own rule, or through the host's error toast where the press rejected before any check ran.
      restore?.();

      if(deliver) {

        speak(deliver, failure(error));

        return null;
      }

      toast.error(toastMessage(failure(error).outcome));

      return null;
    }

    switch(result.kind) {

      case "declined": {

        speak(result.deliver, (result.reason.kind === "listed") ? listed : { channel: "error", outcome: result.reason.outcome, tone: "text-danger" });

        return null;
      }

      // The composer answered null, which it does only for an address another controller holds in the configuration the write composed over. Nothing was written
      // and nothing was seeded.
      case "unchanged": {

        speak(result.deliver, listed);

        return null;
      }

      case "failed": {

        restore?.();
        speak(result.deliver, failure(result.error));

        return null;
      }

      case "committed": {

        /* A token-only connection is a successful save with a consequence worth saying out loud, since the controller's own facts stay out of reach until
         * credentials arrive. A connection whose token the controller refused is a successful save as well, and it warns, since the plugin runs on the credentials
         * alone and what only an accepted token reaches stays off until the configuration carries one.
         */
        if(result.value.answer.kind === "token-only") {

          toast.success("This controller has been saved. Its API token is valid. Its doors and devices appear in HomeKit; adding a local user's username and " +
            "password lets the plugin read the controller's own document as well.");
        } else if(result.value.answer.tokenRefused) {

          toast.warning(TOKEN_REFUSED_WARNING);
        } else {

          toast.success("This controller has been saved.");
        }

        // The status feed's registry follows the seed, so the saved controller's devices are viewable under the identity that was just checked.
        void sendStatusContext();

        return address;
      }

      case "staged": {

        toast.warning("This controller has been saved, but Homebridge could not write the configuration file. Save the plugin's settings to keep the " +
          "change.");

        // A staged save counts as saved, so the status feed's registry follows its seed as it follows a committed one's.
        void sendStatusContext();

        return address;
      }

      // A busy press started nothing and a superseded one was retired before its write, so neither wrote anything or is owed anything. An outcome this page does
      // not recognize is one it cannot claim as a success, so it says nothing and leaves the seed where it is.
      case "busy":
      case "superseded":
      default: {

        return null;
      }
    }
  };

  /* Remove a controller from the configuration, with the settings sweep the user chose.
   *
   * The write is handed to the feature-options page as a composer for the same reason Save's is: the page's store holds the options array the user loaded, and the
   * sweep's deletions written behind it are ones the next option edit writes back over. The page owns the session and re-establishes itself on what was written.
   *
   * Where the page comes to rest is the framework's own reconciliation rather than a click of ours: a selection naming a controller the refreshed list no longer
   * holds falls back to the global scope, and a removal that leaves no controller at all re-enters the page through a fresh show() cycle whose boot owns the
   * no-controllers surface. A successful removal therefore says nothing, because the page arriving at the global view is the visible outcome; a removal the host
   * could not save to disk speaks through the toast, since the card it would otherwise speak through has left the page with the controller.
   *
   * The cache work stays after the write, where it sits for a save's own reasons reversed: nothing the page re-reads inside the call consults the removed address,
   * so clearing afterwards costs a failed write nothing.
   */
  const removeController = async ({ address, card, macs }) => {

    let result;

    try {

      const { withControllerRemoved } = await interpreters();

      result = await commitConfig((platform) => withControllerRemoved(platform, { address, macs }));
    } catch(err) {

      card.verdict.render({ detail: errorMessage(err), lines: ["Unable to remove this controller."], tone: "text-danger" });

      return;
    }

    switch(result.kind) {

      // A removal that landed says nothing: the page coming to rest on the global view, or on the no-controllers surface where this was the last controller, is
      // the visible outcome and it needs no sentence beside it.
      case "committed": {

        break;
      }

      case "staged": {

        toast.warning("This controller has been removed, but Homebridge could not write the configuration file. Save the plugin's settings to keep the " +
          "change.");

        break;
      }

      case "failed": {

        card.verdict.render({ detail: errorMessage(result.error), lines: ["Unable to remove this controller."], tone: "text-danger" });

        return;
      }

      // An outcome this page does not recognize is one it cannot treat as a removal, so nothing renders and the cache below is left holding what it holds.
      default: {

        return;
      }
    }

    // The controller is gone from the configuration, so what this session remembered about it goes with it, and the generation moves so a fetch that was already in
    // flight for that address cannot put it back. The settings sweep read its MAC addresses long before this, when the card was populated.
    generation++;
    byAddress.delete(address);

    // The status feed's registry follows the delete, so a removed controller's serials leave it rather than lingering as viewable ghosts.
    void sendStatusContext();
  };

  return { answers, removeController, saveController };
};

/**
 * Build the controller connection check over the page's own reach into the UI-server bridge. The check validates a controller identity against the UI server and
 * answers what came of it, and every card's validate control, every card's Save, and the first-run submit share it so none of them can drift apart. The browser
 * cannot reach the Access controller directly, so the request bridges through the plugin's UI server.
 *
 * It answers an outcome and reports nothing itself: passed with the classified success, failed with the sentences and the detail that a missing address, an
 * identity the plugin would refuse, a refused connection, or a request that threw calls for, or retired when the signal it was handed aborted before the answer
 * arrived. Each caller delivers the outcome under its own rule: the validate control and the first-run submit through the action they started, which paints while
 * the card presents it and drops it otherwise, and a Save through its press's delivery, which still reaches the user through the host's toast once the card no longer
 * presents the press.
 *
 * The signal is the caller's action's own, so an edit to the card's fields or a newer act on the card retires the request. Starting that action is the caller's
 * act: the caller speaks through it once this answers, so a page holding several cards speaks each answer on the card it belongs to; starting blanks the line
 * before the request rather than after it, so a check that never answers cannot leave an older verdict beside newer input; and a Save and the first-run submit
 * each ask whether the address is already listed before this check begins. The bridge offers no cancellation, so a retired request still runs to its answer at
 * the host, where that answer is dropped.
 *
 * @param injected.classifyProbeResponse - The one reading of the UI server's probe answer, which a fulfilled request's outcome is composed from.
 * @param injected.hasValidIdentity      - The rule that answers whether an identity is one the plugin can connect with.
 * @param injected.readProbeRejection    - The one reading of a rejected request, which a rejection's detail is composed from.
 * @param injected.request               - The UI-server bridge's request, taking a path and a payload.
 *
 * @returns The connection check.
 */
export const makeControllerProbe = ({ classifyProbeResponse, hasValidIdentity, readProbeRejection, request }) => async ({ address, password, signal, tokens,
  username, verifyTls }) => {

  if(!address?.length) {

    return { kind: "failed", outcome: { lines: ["Please enter your UniFi Access controller's address."] } };
  }

  // The identity gate is the browser's statement of the plugin's own composition rule, asked here so a user learns their sign-in is incomplete without waiting on a
  // round trip that would be refused at the far end anyway.
  if(!hasValidIdentity({ password, tokens, username })) {

    return { kind: "failed", outcome: { lines: [ "Please enter a way to sign in to this UniFi Access controller.",
      "That is a local user's username and password, an Access console API token, or both." ] } };
  }

  const [settled] = await Promise.allSettled([request("/getDevices", { address, password, tokens, username, verifyTls })]);

  // An edit to this card's fields, or a newer validation or Save on it, retires this one. A retired request answers nothing to show, whether the bridge answered
  // or failed, so it never paints over what the newer input or action is showing, and a Save waiting on it writes nothing. Closing, re-populating, or hiding the
  // card retires nothing: the caller's own delivery decides where an answer that outlives what the card presents goes.
  if(signal.aborted) {

    return { kind: "retired" };
  }

  // The UI server failing to start or respond lands here. Answering the specific failure keeps it on the card for a user still looking at it, while the framework's
  // toast stays the generic net for consumers without their own handling.
  if(settled.status === "rejected") {

    return { kind: "failed", outcome: { detail: readProbeRejection(settled.reason), lines: ["Unable to validate your controller connection."] } };
  }

  const verdict = classifyProbeResponse(settled.value);

  // Couldn't reach the Access controller. The verdict names which failure this was in its own headline, and the second line is its own guidance where it has one
  // and the card's own sentence where it does not; the controller-sourced detail arrives on the verdict too, and every surface renders it as text so it is never
  // interpreted as markup.
  if(verdict.kind === "error") {

    return { kind: "failed", outcome: { detail: verdict.message, lines: [ verdict.headline,
      verdict.guidance ?? "Please check your controller address and sign-in details." ] } };
  }

  return { answer: verdict, kind: "passed" };
};
