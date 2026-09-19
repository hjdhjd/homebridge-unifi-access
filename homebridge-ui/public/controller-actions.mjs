/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.mjs: The settings page's kept controller answers, and the controller save and removal that write them.
 */
"use strict";

/* The single home for what the settings page remembers about each configured controller and for the two configuration actions that change it - a controller's save
 * and a controller's removal. The memory is private here and the page reads it through a handle of four operations, so the rule deciding whether an answer is worth
 * keeping is stated once rather than at every site that fills one, and the seed, the delete, and the generation bump each action makes stay out of reach of every
 * reader that has no business making them.
 *
 * The module takes no imports at all and names no browser global. Every reach beyond it - the connection probe, the configuration interpreters, the host's toast,
 * the framework's coordinated write, the status-context send, the device-list decoration, and the sidebar re-select - is handed in, so the whole of it runs under
 * node against recording fakes. That is what puts a swapped toast severity, a put-back that restores the wrong address, and a seed that lands after its write in
 * front of a gate rather than in front of a user.
 */

/**
 * Build the settings page's kept controller answers and the two configuration actions that write them, over the page's own reach into the browser, the host, the
 * framework, and the UI-server bridge.
 *
 * @param injected.commitConfig      - The feature-options page's coordinated write, which takes a composer and answers what became of it.
 * @param injected.interpreters      - The page's holder for the configuration interpreters that need the served catalog.
 * @param injected.probe             - The connection validation, which answers a controller's verdict on either kind of success and null on any failure.
 * @param injected.processDeviceList - The page's decoration of a probe's device list into the shape the framework renders from.
 * @param injected.selectController  - The page's selection of a controller's own sidebar entry, by the address the configuration records.
 * @param injected.sendStatusContext - The page's send of its controller context to the live-status feed.
 * @param injected.toast             - The host's toast surface, which is where a write that landed speaks.
 *
 * @returns The kept answers, the controller removal, and the controller save.
 */
export const makeControllerActions = ({ commitConfig, interpreters, probe, processDeviceList, selectController, sendStatusContext, toast }) => {

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
   * afterwards - the same supersession problem a card's login verdict solves the same way. A retired fill costs one extra fetch at the next selection, where a
   * stale serve would cost the rest of the session. One counter covers every address deliberately: its only failure mode is that extra fetch, and a counter nobody
   * can misindex beats a map of counters somebody can.
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

  /* Validate a card's connection and persist it, which is the whole of what Save means.
   *
   * Validation comes first and a failure writes nothing at all: a controller the plugin cannot connect to is not a configuration worth saving, and the card's own
   * verdict line already says why. The write is then handed to the feature-options page as a composer rather than made through a session of this card's own,
   * because the page's store holds the options array the user loaded and a write made behind it is one the next option edit writes back over. The page drains
   * whatever option edits are in flight, composes against the configuration as it then stands, writes and saves through the one session it owns, and re-establishes
   * itself on what was written.
   *
   * The cache work goes AHEAD of that write rather than after it, because the page re-reads through getControllers and getDevices inside the call and getDevices
   * answers from the map: a seed made afterwards would leave the page showing what the controller answered before the save, a token-only list for a controller that
   * has just been given credentials above all. The seed therefore lands before the write is known to have landed, so what the map held under both addresses is read
   * first and a write that fails puts it back exactly as it stood.
   *
   * Success speaks through the host's toast rather than the card's verdict line. The page re-runs this plugin's status-panel content hook during and after the
   * write - each run re-populates the docked card, and populating blanks its verdict - and a re-entry through show() discards the frame the card sits on
   * altogether, so the toast is the one surface that survives every outcome. A failure still speaks on the card, because a write that changed nothing
   * re-establishes nothing and the card stands.
   *
   * @returns The address that was written, or null when nothing was.
   */
  const saveController = async ({ card, originalAddress }) => {

    const identity = card.values();
    const validation = await probe({ ...identity, verdict: card.verdict });

    if(!validation) {

      return null;
    }

    const replaced = originalAddress && (originalAddress !== identity.address);

    // What the map holds under each address this save touches, read before the seed replaces it so a failed write has something exact to put back.
    const priorAtAddress = byAddress.get(identity.address);
    const priorAtOriginal = replaced ? byAddress.get(originalAddress) : undefined;

    /* Put the map back the way this save found it, restoring each address to the answer read above or deleting it where the map held none, and move the generation
     * again so a fetch issued against the seeded state loses its claim to be kept. A save that wrote nothing then costs the session nothing it knew, and a
     * controller that was token-only before the save still reads that way.
     */
    const restoreCache = () => {

      const restore = (address, prior) => (prior === undefined) ? byAddress.delete(address) : byAddress.set(address, prior);

      restore(identity.address, priorAtAddress);

      if(replaced) {

        restore(originalAddress, priorAtOriginal);
      }

      generation++;
      void sendStatusContext();
    };

    /* What this session remembers about the controllers is now a write behind, so the generation moves and every fetch still in flight loses its claim to be kept.
     * An address change also strands whatever was remembered under the address the user replaced, which names nothing the configuration holds any more; the Add
     * Controller path has no previous address and strands nothing.
     */
    generation++;

    if(replaced) {

      byAddress.delete(originalAddress);
    }

    /* The address that was just written is then re-seeded from this save's own validation, which connected to the controller with exactly this identity moments ago
     * and came back with its answer. That is newer than anything a deletion would have left behind, so the repaint the page makes inside the write labels the entry
     * with the controller's live name rather than falling back to the raw address, and the next selection is served rather than reconnecting.
     */
    byAddress.set(identity.address, { ...validation, devices: processDeviceList({ address: identity.address, devices: validation.devices }) });

    let result;

    try {

      // The holder read sits inside the try, so a catalog read that rejects renders the failure verdict rather than escaping this handler.
      const { withControllerSaved } = await interpreters();

      result = await commitConfig((platform) => withControllerSaved(platform, { ...identity, originalAddress }));
    } catch(err) {

      restoreCache();
      card.verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to save this controller."], tone: "text-danger" });

      return null;
    }

    switch(result.kind) {

      case "committed": {

        // A token-only connection is a successful save with a consequence worth saying out loud, since the controller's own facts stay out of reach until
        // credentials arrive.
        toast.success((validation.kind === "token-only") ? "This controller has been saved. Its API token is valid. Its doors and devices appear in " +
          "HomeKit; adding a local user's username and password lets the plugin read the controller's own document as well." : "This controller has been saved.");

        break;
      }

      case "staged": {

        toast.warning("This controller has been saved, but Homebridge could not write the configuration file. Save the plugin's settings to keep the " +
          "change.");

        break;
      }

      case "failed": {

        restoreCache();
        card.verdict.render({ detail: (result.error instanceof Error) ? result.error.message : String(result.error),
          lines: ["Unable to save this controller."], tone: "text-danger" });

        return null;
      }

      /* A retired copy owns nothing on screen and its map has no reader, since a reopened panel is a fresh module copy with a map of its own, so the seed is left
       * where it is and nothing is rendered. The default shares this arm rather than standing alone: an outcome this page does not recognize is one it cannot claim
       * as a success, and refusing to render is the only honest answer to it.
       */
      case "superseded":
      default: {

        return null;
      }
    }

    // The status feed's registry follows the re-seed, so the saved controller's devices are viewable under the identity that was just validated.
    void sendStatusContext();

    /* An address edit leaves the selection naming a controller the refreshed list no longer holds, and the framework drops such a selection to the global scope - so
     * the entry the save just wrote is selected on the page's own navigation.
     */
    if(replaced) {

      selectController(identity.address);
    }

    return identity.address;
  };

  /* Remove a controller from the configuration, with the settings sweep the user chose.
   *
   * The write is handed to the feature-options page as a composer for the same reason Save's is: the page's store holds the options array the user loaded, and the
   * sweep's deletions written behind it are ones the next option edit writes back over. The page owns the session, answers a retired copy on its own terms, and
   * re-establishes itself on what was written.
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

      card.verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to remove this controller."], tone: "text-danger" });

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

        card.verdict.render({ detail: (result.error instanceof Error) ? result.error.message : String(result.error),
          lines: ["Unable to remove this controller."], tone: "text-danger" });

        return;
      }

      /* A retired copy renders nothing, and the default shares its arm for the same reason the save's does: an outcome this page does not recognize is one it
       * cannot treat as a removal, so the cache below is left holding what it holds.
       */
      case "superseded":
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
