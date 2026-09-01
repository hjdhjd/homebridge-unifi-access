/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge UniFi Access webUI.
 */
"use strict";

import { FeatureOptions, buildCatalogIndex, enumerateConfiguredEntries } from "homebridge-plugin-utils/featureOptions.js";
import { classifyProbeResponse, controllers, controllersAwaitingMigration, hasValidIdentity, makeAccessConfig, primaryController, withControllerSaved,
  withPrimaryIdentity } from "./access-config.mjs";
import { PluginConfigSession } from "homebridge-plugin-utils/pluginConfigSession.mjs";
import { STATUS_VIEW_ROUTE } from "homebridge-plugin-utils/webui-status.js";
import { webUi } from "homebridge-plugin-utils/webUi.mjs";
import { withDeadline } from "homebridge-plugin-utils/webUi-liveness.mjs";

/* The bound in seconds on the option-catalog fetch below. The bound exists so a bridge call that never settles rejects rather than wedging the cached promise for the
 * life of the session. The trade it carries: a fetch that is legitimately slow but would eventually have settled costs a retry cycle rather than resolving, which is
 * cheap beside the permanent wedge the bound prevents, because the cache clears on rejection and a later read refetches fresh. It is deliberately its own constant
 * rather than the wiring bound below, so the inner fetch and the envelope around it cannot expire together.
 */
const CATALOG_DEADLINE = 5;

/* The bound in seconds on each individual controller probe. This is not a worst-case bound and does not pretend to be one: a probe performs a full authentication and
 * then fetches the controller's information and topology documents, so a genuinely worst-case first connection runs past it. Five admits the healthy case. A
 * controller slower than that reads as unreachable for this pass, keeps its per-controller settings, and is probed again at the next open, which is exactly the
 * posture an offline controller already gets.
 */
const PROBE_DEADLINE = 5;

/* The bound in seconds on the whole load-time wiring below. The page's own boot monitor fires its slow-boot notice and hides the spinner at ten seconds, so eight
 * settles the envelope provably inside it and a wiring step that hangs against an unresponsive host can never be what makes the settings panel look broken.
 *
 * The per-probe bounds above are what keep the realistic worst case inside this outer guard; this one exists for what they cannot cover, a catalog fetch or a session
 * open that goes pathological. An outer expiry writes nothing at all and the whole pass retries at the next open. A configuration that has already converged never
 * approaches either bound, because its envelope is the catalog fetch and the session open and nothing else.
 */
const WIRING_DEADLINE = 8;

/* What a device's details panel says when its controller answered a token-only connection. The devices listed for such a controller come from the official API, and
 * every option set on one of them lands in the same keyspace the plugin's runtime resolves - so the settings are real and take effect the moment credentials are
 * added. What credentials unlock is the accessories themselves and the control that goes with them, which is what this line tells the user, with the connection
 * editor sitting directly beneath it.
 */
const TOKEN_ONLY_NOTICE = "These devices are listed through this controller's API token. Add a local user's username and password below to bring them into HomeKit " +
  "as accessories - the options you set here are kept and take effect as soon as you do.";

// The context-route literal, the plugin's addition to the shared status protocol. It must stay in step with ACCESS_STATUS_CONTEXT_ROUTE in src/access-status.ts,
// the route's owner, because browser code cannot import from dist/. The route carries each configured controller's identity beside the decorated serials of the
// devices its kept probe answer listed; the shared push event and view route belong to homebridge-plugin-utils and ride the imported panel component.
const ACCESS_STATUS_CONTEXT_ROUTE = "/statusContext";

/* The option catalog, fetched once per session from the plugin's own UI server (a local request to /getOptions, never a cloud call). The framework fetches the same
 * endpoint for its own catalog on every show cycle; the two reads are independent by design, since the framework exposes no handle to its copy. The cached promise is
 * cleared on failure so a later read retries rather than pinning a transient fault for the session, and the bound above is what makes a call that never answers into
 * a failure the clear can act on.
 *
 * What is cached is the framework's own catalog INDEX rather than the raw response. The index carries the served categories and options verbatim alongside the
 * derived lookups the entry enumerator needs, so one value serves the engine the migration builds and the grammar its settings sweep reads.
 */
let catalogPromise = null;

const getCatalog = () => {

  catalogPromise ??= withDeadline({ promise: homebridge.request("/getOptions"), seconds: CATALOG_DEADLINE }).then((response) => {

    // A response without the catalog shape the server publishes is a failure, not a default. Shaping it into an empty catalog would let the migration read every
    // option as unconfigured and compose entries against a catalog that never described them, so a malformed response throws and the wiring declines instead.
    if(!Array.isArray(response?.categories) || !response.categories.length || !response?.options || (typeof response.options !== "object")) {

      throw new Error("Received a malformed response from the plugin option catalog.");
    }

    return buildCatalogIndex(response.categories, response.options);
  }).catch((error) => {

    catalogPromise = null;

    throw error;
  });

  return catalogPromise;
};

// The configuration interpreters that need the served catalog, built against the catalog this session already fetched. Every caller reaches them through here rather
// than holding an instance, so a removal that happens long after the load-time wiring still builds against the same cached catalog.
const accessConfig = async () => makeAccessConfig({ FeatureOptions, catalog: await getCatalog(), enumerateConfiguredEntries });

/* Execute our first run screen until the primary controller carries both of the things the plugin needs of it. The two are asked separately because the plugin's own
 * configuration gate asks them separately: an address is where to connect, and an identity is how, and a configuration missing either is one the platform skips.
 * The framework injects our primary platform-config entry, so this is a pure predicate over the persisted config rather than a reach into the feature-options page's
 * state.
 */
const firstRunIsRequired = ({ config }) => {

  const controller = primaryController(config);

  return !controller?.address?.length || !hasValidIdentity(controller);
};

// Initialize our first run screen with any information from our existing configuration. The injected config is the primary platform entry; we pre-populate the form
// from its primary controller, if one is already configured. Populating also blanks the card's verdict line, which is what a verdict a prior module copy painted
// wants: the frame and its elements outlive any single copy, so the line opens blank.
const firstRunOnStart = ({ config }) => {

  const controller = primaryController(config);

  firstRunCard.populate({ address: controller?.address ?? "", password: controller?.password ?? "", tokens: controller?.tokens,
    username: controller?.username ?? "", verifyTls: controller?.verifyTls === true });

  return true;
};

/* The classes the login result line wears in every state. The tone rides on top of this base, so the line's blank, failure, and success states are one layout with
 * one color decision between them rather than a separate class string per state, which is what would let the states drift apart.
 */
const LOGIN_RESULT_CLASS = "hbua-result small mt-2";

/* Paint one card's login result line in the tone its outcome calls for - a Bootstrap text color, or an empty string for the blank state. Guidance sentences render
 * as text nodes separated by <br> elements, and the failure detail - when present - renders inside a <code class="text-danger"> via textContent, so a
 * controller-reported string is shown as text rather than interpreted as markup. Assembling DOM nodes here (rather than an innerHTML string) keeps that trust
 * boundary in one place: the discovery boundary is the trust line, and a controller-reported string is data, never markup. The line keeps its height while blank,
 * which is what stops the card from shifting under the user as a validation answers.
 *
 * The row is handed in rather than looked up, because a page can hold several mounted cards at once and each one paints its own line.
 */
const renderVerdict = ({ detail = "", lines = [], row, tone = "" }) => {

  const nodes = [];

  for(const line of lines) {

    nodes.push(document.createTextNode(line), document.createElement("br"));
  }

  if(detail.length) {

    const errorCode = document.createElement("code");

    errorCode.className = "text-danger";
    errorCode.textContent = detail;
    nodes.push(errorCode);
  }

  row.className = tone.length ? (LOGIN_RESULT_CLASS + " " + tone) : LOGIN_RESULT_CLASS;
  row.replaceChildren(...nodes);
};

/* Probe a controller through the UI server and paint the outcome, shared by every card's validate control, every card's Save, and the first-run submit so none of
 * them can drift apart. The browser cannot reach the Access controller directly, so the request bridges through the plugin's UI server. Returns the probe's verdict
 * on either kind of success and null on any failure - a missing field, an identity the plugin would refuse, a rejected connection, or a request that threw - with
 * the result line already painted for every outcome but success, whose message belongs to the caller.
 *
 * The identity gate is the browser's statement of the plugin's own composition rule, asked here so a user learns their sign-in is incomplete without waiting on a
 * round trip that would be rejected at the far end anyway.
 *
 * The verdict surface arrives from the card that asked, so a page holding several cards paints each answer on the card it belongs to and no card's slow response
 * can paint over another's.
 */
const requestControllerProbe = async ({ address, password, tokens, username, verdict, verifyTls }) => {

  // This request is the newest the moment it starts: the bump retires any response still in flight, and the value it answers is what this request's own resolution
  // checks against below. Whatever the last validation said is stale now too, so the line is blanked before the call rather than after it - a call that never
  // resolves must not leave an older verdict standing beside newer input.
  const generation = verdict.invalidate();

  if(!address?.length) {

    verdict.render({ lines: ["Please enter your UniFi Access controller's address."], tone: "text-danger" });

    return null;
  }

  if(!hasValidIdentity({ password, tokens, username })) {

    verdict.render({ lines: [ "Please enter a way to sign in to this UniFi Access controller.",
      "That is a local user's username and password, an Access console API token, or both." ], tone: "text-danger" });

    return null;
  }

  try {

    const probe = classifyProbeResponse(await homebridge.request("/getDevices", { address, password, tokens, username, verifyTls }));

    // A reopened panel mints a successor copy of this module, and an edit or a newer request retires this one within it - either way, a retired request must not
    // paint over what the copy or the request the user is looking at is showing.
    if(ui.epochSignal.aborted || !verdict.isCurrent(generation)) {

      return null;
    }

    // Couldn't reach the Access controller. The two guidance sentences frame the failure and the controller-sourced detail arrives on the probe's own verdict,
    // rendered as text so it is never interpreted as markup.
    if(probe.kind === "error") {

      verdict.render({ detail: probe.message, lines: [ "Unable to connect to the UniFi Access controller.",
        "Please check your controller address and sign-in details." ], tone: "text-danger" });

      return null;
    }

    return probe;
  } catch(err) {

    // A retired request's failure is nobody's news - the epoch and generation rules above govern this paint too.
    if(ui.epochSignal.aborted || !verdict.isCurrent(generation)) {

      return null;
    }

    // The UI server failing to start or respond lands here. Painting into the result line keeps the user on the form with the specific failure, while the
    // framework's toast stays the generic net for consumers without their own handling.
    verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to validate your controller connection."], tone: "text-danger" });

    return null;
  }
};

// Validate our Access sign-in and commit it.
const firstRunOnSubmit = async ({ commit, config }) => {

  const identity = firstRunCard.values();
  const probe = await requestControllerProbe({ ...identity, verdict: firstRunCard.verdict });

  if(!probe) {

    homebridge.hideSpinner();

    return false;
  }

  try {

    // Persist the validated identity through the session's single write hook. We own the shape of the write - the identity lives on the primary controller, which
    // withPrimaryIdentity encodes while preserving any additional controllers - and the session owns persistence and the preservation of sibling platform entries.
    await commit(withPrimaryIdentity(config, identity));

    return true;
  } catch(err) {

    // The config write can reject. Painting into the result line keeps the user on the form with concrete guidance and the specific failure, and this catch resolves
    // first, so the framework's generic toast never fires for this plugin.
    firstRunCard.verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to complete the plugin configuration."],
      tone: "text-danger" });
    homebridge.hideSpinner();

    return false;
  }
};

// The UI server projects the controller itself into the device list as a record whose display model is "controller" - every other model key belongs to a device the
// controller manages.
const isController = (device) => device.display_model === "controller";

/* The platform configuration the framework last injected into one of our hooks, or null before the first of them runs.
 *
 * The framework re-reads the host configuration into its own session immediately before it calls these hooks, so what is held here is the configuration the page
 * itself is working from rather than a snapshot taken at load. The docked editors populate their fields from it, which is a read the framework's render path gives
 * them no other way to make: the info-panel and connection-error bags carry the selection, not the configuration behind it.
 *
 * Nothing WRITES through this copy. Every write opens a session of its own and commits against what that session reads, so a stale copy here can only ever show a
 * stale field value in a collapsed card, never persist one.
 */
let injectedConfig = null;

/* Each controller address's probe answer, as this session last received it and already processed for the framework to render. What is kept is the whole answer - its
 * outcome tag alongside its device list - rather than the list alone, because a healthy controller with nothing to list and a controller that could not be reached
 * both answer an empty list and the page must go on telling them apart on every later re-entry.
 *
 * One answer serves every reader that needs it: the device view returns it on every re-entry, a removal derives from it the MAC addresses a settings sweep would
 * strip, and the sidebar reads the controller's own name from it. A controller connection costs a user real dead air, and almost nothing about a controller changes
 * between one re-entry and the next, so that price is paid once per address per session and the Refresh control is how a user asks to pay it again.
 *
 * Only an answer that actually arrived is ever kept, and the gate is the outcome tag rather than the list's length: a token-only controller's empty answer is a real
 * answer and caches like any other, while a failure writes nothing here so the connection-error view and the framework's own retry cycle always act on a live
 * attempt rather than on a hopeful memory of one. The map lives as long as this module copy, which is the page's own lifetime, so a reopened panel connects afresh.
 */
const devicesByAddress = new Map();

/* The generation the map above is on, bumped by every event that retires what it holds: a controller saved, a controller removed, and the Refresh control. A fetch
 * captures this value before it calls the bridge and compares it after, writing only when the two still agree.
 *
 * The bridge offers no cancellation, so a fetch issued before an invalidation cannot be recalled and would otherwise be free to land its pre-invalidation answer
 * afterwards - the same supersession problem a card's login verdict solves the same way. A retired fill costs one extra fetch at the next selection, where a stale
 * serve would cost the rest of the session. One counter covers every address deliberately: its only failure mode is that extra fetch, and a counter nobody can
 * misindex beats a map of counters somebody can.
 */
let cacheGeneration = 0;

/* Send the live-status feed its controller context: for each configured controller this session holds a kept probe answer for, the identity members exactly as the
 * configuration item spells them, the decorated serials of the answer's devices, and the decorated serial of the answer's controller record where one exists - a
 * token-only answer carries no console identity, so that member is honestly absent. The send rides every devicesByAddress write, the removal delete included, so
 * the feed's registry tracks what this session knows; the feed rebuilds its registry wholesale from each send.
 *
 * The raw request promise feeds the shared panel's link-lost watchdog directly, on the donor discipline the family's status pages share: the watch observes the raw
 * promise so a rejection reaches its two-armed hook as a rejection, the console diagnostic rides a separate chain off the same promise, and the panel handle is read
 * at call time because it is minted per show() and must never be captured. The settle is awaited so the one caller that must sequence behind the send - the hello
 * re-elicitation - can; every other call site voids the promise, and the swallow keeps a failure from surfacing twice.
 */
const sendStatusContext = async () => {

  const contextControllers = [];

  for(const item of controllers(injectedConfig)) {

    const answer = devicesByAddress.get(item?.address);

    if(!item?.address || !answer) {

      continue;
    }

    const entry = { address: item.address, password: item.password, serials: answer.devices.map((device) => device.serialNumber).filter((id) => typeof id === "string"),
      tokens: item.tokens, username: item.username, verifyTls: item.verifyTls };
    const controllerSerial = answer.devices.find(isController)?.serialNumber;

    if(controllerSerial !== undefined) {

      entry.controllerSerial = controllerSerial;
    }

    contextControllers.push(entry);
  }

  const request = homebridge.request(ACCESS_STATUS_CONTEXT_ROUTE, { controllers: contextControllers });

  ui.featureOptions.statusPanel?.watchRequest(request);

  // console is the browser panel's diagnostic transport; a transport failure here is a diagnostic, since feed progress and errors return over push events.
  // eslint-disable-next-line no-console
  request.catch((error) => console.error("The status context request failed.", error));

  try {

    await request;
  } catch {

    // The transport failure is already logged on the separate chain above; the feed simply keeps its previous registry until the next send.
  }
};

/* Add the fields the webUI framework renders from, and mark the controller entry with the address the plugin reached it at. It touches the device records and
 * nothing on the page, which is what lets both writers into the map above run it: the device view's own fetch, and a save re-seeding from the answer its validation
 * just received. One helper is what keeps those two from processing the same list into two different shapes.
 *
 * The serial number is not computed here. It arrives already decorated by the UI server, which reaches the plugin's own policy module for the Enterprise port suffix
 * that tells one port of a multi-door hub from its siblings...knowledge the browser has no way to derive for itself.
 *
 * The visibility rule below reduces the sidebar to the hardware this plugin actually projects into HomeKit. A device whose model is not among the models the
 * supported devices report is put in the hidden group rather than dropped, so the framework still holds a complete list while the sidebar shows only what a user can
 * act on.
 */
const processDeviceList = ({ address, devices }) => {

  const modelKeys = [...new Set(
    devices.filter(device => ["controller"].includes(device.display_model) || device.capabilities.includes("is_hub") || device.capabilities.includes("is_reader"))
      .map(device => (device.device_type === "UAH-Ent") ? device.model : device.display_model))];

  for(const device of devices) {

    device.name ??= device.alias ?? device.display_model;

    const model = (device.device_type === "UAH-Ent") ? device.model : device.display_model;

    if(!modelKeys.includes(model)) {

      device.sidebarGroup = "hidden";
    }

    device.sidebarGroup ??= device.capabilities.includes("is_hub") ? "Hubs" : "Readers";

    /* Stamp the configured address onto every record, which is what lets the docked editor find the configuration item a selection belongs to. The serialNumber the
     * framework correlates on is a hardware identity, and a configuration file records the address the plugin connects to and never a hardware identity, so the two
     * can never be matched to each other - the stamp is the only thing carrying that correspondence across.
     *
     * Every record carries it rather than the controller's alone, because a token-only controller has no record of its own: the official inventory answers its
     * devices and no console identity, so the connection editor has to be reachable from wherever the user actually is.
     */
    device.hbuaConfigAddress = address;

    if(isController(device)) {

      device.sidebarGroup = "controllers";
    }
  }

  return devices;
};

/* Show a controller's own name on its sidebar entry, which is something only a controller we have connected to can tell us - the configuration records an address
 * and the sidebar has nothing else to label the entry with until then. Every device fetch runs this, whether the list came off the wire or out of the map above: a
 * served list re-asserts the same string, and one uniform path is worth more than the assignment a divergent fast path would save.
 */
const patchControllerLabel = ({ address, devices }) => {

  const controllerDevice = devices.find(isController);

  if(!controllerDevice) {

    return;
  }

  const activeController = [...document.querySelectorAll("[data-navigation='controller']")].find((c) => c.getAttribute("data-device-serial") === address);

  if(activeController) {

    activeController.textContent = controllerDevice.name;
  }
};

// Return the list of controllers from our plugin configuration, paired with a clean connection outcome - the list is configuration-derived, so no fetch is involved
// and no failure can occur. The framework injects our primary platform-config entry; we map each configured controller to the sidebar shape, deliberately carrying
// no credentials into the rendered list.
const getControllers = ({ config }) => {

  injectedConfig = config;

  /* Close an open Add Controller card here, which is the one place that covers every way the view can be rebuilt underneath it. Every rebuild routes through this
   * hook - a menu round trip's show(), an explicit refreshControllers(), and the connection-error view's own Retry, which re-enters show() without touching a menu
   * button - so closing here needs no per-path wiring and can miss none of them. The card's region is outside the framework's own reveal cycle, so its lifetime is
   * ours to end: a rebuild discards whatever was typed into it, which is what a view rebuilding out from under an unsaved form should do.
   */
  closeControllerEditor();

  /* Each entry is labeled with the controller's own name once this session has heard it, and with the configured address until then. The answer this session already
   * received is where that name comes from, so a repaint of the sidebar arrives carrying the same labels the user was already reading rather than reverting every
   * entry to its raw address until a controller is selected again.
   */
  return {

    controllers: controllers(config).map((controller) => ({

      name: devicesByAddress.get(controller.address)?.devices.find(isController)?.name ?? controller.address,
      serialNumber: controller.address
    })),
    error: ""
  };
};

/* Map a probe answer onto the device list and connection outcome the framework's own hook contract carries. The verdict already separates the two: a success carries
 * its devices and an empty message, a failure carries no devices and the reason. Both successes therefore travel the same way, so a healthy token-only controller
 * populates the sidebar exactly as a credentialed one does and no failure surface is ever reached for it.
 */
const asDeviceListResult = (answer) => ({ devices: answer.devices, error: answer.message });

// Return the list of devices associated with a given Access controller, paired with the connection outcome. The framework injects the live platform config alongside
// the selected controller, so we can recover the selected controller's identity (which the sidebar entries deliberately omit) without reaching for the config
// ourselves. A connection failure travels back on the result rather than through a separate request.
const getDevices = async (selectedController, { config }) => {

  injectedConfig = config;

  // The global context legitimately has no devices and no failure.
  if(!selectedController) {

    return { devices: [], error: "" };
  }

  // Find the entry in our plugin configuration. A sidebar entry can outlive a Settings-tab edit that removed its controller, so a miss is a carried failure with an
  // actionable message rather than a silent empty result that would render nothing the user can act on.
  const controller = controllers(config).find((c) => c.address === selectedController.serialNumber);

  if(!controller) {

    return { devices: [], error: "The selected controller is no longer in the plugin configuration." };
  }

  const cached = devicesByAddress.get(controller.address);

  // A controller this session has already reached answers from what it said then, ahead of any bridge call at all. Every tab re-entry and every re-select passes
  // through here, and repeating a full connection for each of them is the wait the user notices most, for data that is almost never different.
  if(cached) {

    patchControllerLabel({ address: controller.address, devices: cached.devices });

    return asDeviceListResult(cached);
  }

  // The generation this fetch belongs to, read before the call and checked against after it, so an answer that an invalidation has overtaken can complete without
  // being kept.
  const generation = cacheGeneration;

  // The browser cannot reach the Access controller directly, so we bridge the request through the plugin's UI server, which holds the controller's identity.
  const answer = classifyProbeResponse(await homebridge.request("/getDevices", { address: controller.address, password: controller.password,
    tokens: controller.tokens, username: controller.username, verifyTls: controller.verifyTls }));

  processDeviceList({ address: controller.address, devices: answer.devices });
  patchControllerLabel({ address: controller.address, devices: answer.devices });

  // Remember what this controller answered, so every later re-entry is served from it. A failure is never kept, which is what keeps the connection-error view and its
  // retry acting on live attempts; an answer a save or a removal overtook while it was in flight is dropped for the same reason, at the cost of one more fetch the
  // next time this controller is selected.
  if((answer.kind !== "error") && (generation === cacheGeneration)) {

    devicesByAddress.set(controller.address, answer);

    // The status feed's registry tracks every kept answer, so the devices this fetch just listed become viewable the moment they are selectable.
    void sendStatusContext();
  }

  return asDeviceListResult(answer);
};

// Only show feature options that are valid for the capabilities of this device. Every read of the metadata channel is guarded at each step: the channel itself and
// both of its members are optional, so an entry that declares no scope at all reaches these tests as a chain of absent values rather than a throw.
const validOption = (device, option) => {

  if(device && (device.display_model !== "controller") && (
    (option.meta?.hasCapability && (!device.capabilities || !option.meta.hasCapability.some(x => device.capabilities.includes(x)))) ||
    (option.meta?.modelKey && !option.meta.modelKey.includes("all") && !option.meta.modelKey.includes(device.display_model)))) {

    return false;
  }

  return true;
};

// Only show feature option categories that are valid for a particular device type.
const validOptionCategory = (device, category) => {

  // Always show every category at the global and controller level.
  if(!device || (device.display_model === "controller")) {

    return true;
  }

  if(category.meta?.modelKey && !category.meta.modelKey.some(model => [ "all", device.display_model ].includes(model))) {

    return false;
  }

  if(category.meta?.hasCapability && (!device.capabilities || !category.meta.hasCapability.some(x => device.capabilities.includes(x)))) {

    return false;
  }

  return true;
};

// The number of cards this module copy has mounted, which is what makes each clone's field ids unique within the page.
let cardInstances = 0;

/* Mount one connection card into a caller's container and hand back the surface that caller drives it through.
 *
 * One card serves every place a controller's connection is entered or edited, so the markup lives in a template and each caller mounts a clone of it. A clone
 * cannot carry the ids the template would otherwise hold - two mounted cards would answer the same lookup and each label would point at whichever field the
 * document happened to reach first - so every element is addressed by a data attribute and each field is given an id of this instance's own, with the label that
 * names it pointed at that id so the association survives cloning.
 *
 * The caller declares what it offers by supplying handlers: a card with no onSave shows no Save control, and one with no onRemove shows no Remove. Validation is
 * the exception and is always offered, because it costs nothing and is the whole reason a user can find out whether a connection works before committing it.
 *
 * @param options.container      - The element the card mounts into, whose children it replaces.
 * @param options.heading        - The card's heading, null for no heading at all, or absent to keep the template's own wording.
 * @param options.helper         - The card's explanatory line, on the same terms as the heading.
 * @param options.noSweepReason  - What the removal confirmation says when there are no device settings it can offer to strip.
 * @param options.onCancel       - Invoked by the Cancel control, when the caller offers one.
 * @param options.onRemove       - Invoked with the MAC addresses to strip once a removal is confirmed, when the caller offers removal.
 * @param options.onSave         - Invoked by the Save control, when the caller offers one.
 * @param options.signal         - The caller's own lifecycle, when it has one. The card's teardown composes with it.
 *
 * @returns The card's surface: close, populate, values, and the verdict line.
 */
const mountConnectionCard = ({ container, heading, helper, noSweepReason = "", onCancel, onRemove, onSave, signal }) => {

  const card = document.getElementById("hbuaConnectionCard").content.firstElementChild.cloneNode(true);
  const fields = {};
  const instance = ++cardInstances;

  for(const field of card.querySelectorAll("[data-field]")) {

    const name = field.dataset.field;

    field.id = "hbuaCard" + instance + "-" + name;
    card.querySelector("[data-label-for='" + name + "']").htmlFor = field.id;
    fields[name] = field;
  }

  /* The field kinds the card carries answer their live state through different members: a text field's is `.value` and a checkbox's is `.checked`. Reading and
   * writing both through one uniform loop would read the constant "on" from the checkbox and write nothing back to it, so a TLS preference the user had turned on
   * would be silently replaced by the template's unchecked default on any unrelated edit. Every read and write below therefore names its field and its member.
   */
  const isCheckbox = (field) => field.type === "checkbox";

  // Every selector below reads an attribute this module's own template wrote, never anything a user or a controller supplied, so the composition is not a place
  // untrusted text can reach.
  const control = (action) => card.querySelector("[data-action='" + action + "']");
  const removeConfirm = card.querySelector("[data-role='removeConfirm']");
  const row = card.querySelector("[data-role='verdict']");

  // The card's own teardown, composed with whatever lifetime the caller gave it, so a caller that closes its card retires the card's wiring without disturbing
  // anything else the caller registered.
  const teardown = new AbortController();
  const cardSignal = signal ? AbortSignal.any([ signal, teardown.signal ]) : teardown.signal;

  /* The generation of this card's newest connection validation. It belongs to the card rather than to the module so two mounted cards cannot invalidate each other's
   * verdicts: each request captures the value as it starts and checks it after resolving, so only the newest request ON THIS CARD can paint - an older response
   * that loses the race discards itself rather than painting over what newer input or a newer request has put on screen. An edit bumps the generation too, which
   * is what keeps a slow verdict from landing beside input it no longer describes. The UI-server bridge carries no abort surface, so supersession is enforced at
   * the paint rather than on the wire.
   */
  let generation = 0;

  // The MAC addresses a removal would offer to strip settings for, as the caller's last population named them.
  let removalMacs = [];

  const verdict = {

    // Retire any validation still in flight, blank the line, and answer the generation this card is now on.
    invalidate: () => {

      renderVerdict({ row });

      return ++generation;
    },

    // Whether a validation that started at the supplied generation is still the newest one this card issued.
    isCurrent: (mark) => mark === generation,
    render: (options = {}) => renderVerdict({ ...options, row })
  };

  // Put the removal confirmation away. Every path that changes what the card is describing takes it back to its unarmed state, so a confirmation can never outlive
  // the controller it was naming.
  const disarmRemoval = () => removeConfirm.classList.add("d-none");

  /* Arm the removal confirmation, naming the controller in words rather than in a browser dialog. The sweep is offered as the follow-on choice it is: the settings
   * a user configured for a controller's devices are worth keeping when that controller is coming back under a new address, and worth deleting when it is gone for
   * good, and only the user knows which. Without a device list there is nothing to offer, so the card says why instead of pretending the choice exists.
   */
  const armRemoval = () => {

    const sweepable = removalMacs.length > 0;

    card.querySelector("[data-role='removePrompt']").textContent = "Remove " + fields.address.value + " from this plugin? " + (sweepable ?
      "You can also delete every feature option that was set for this controller and the devices it brought with it." : noSweepReason);
    control("removeSwept").classList.toggle("d-none", !sweepable);
    removeConfirm.classList.remove("d-none");
  };

  // The caller's own framing, where it wants something other than the first-run wording the template carries. A caller that wants no framing at all passes null,
  // which takes the element out of the flow rather than leaving an empty line of space behind.
  for(const [ role, copy ] of [ [ "heading", heading ], [ "helper", helper ] ]) {

    if(copy === undefined) {

      continue;
    }

    const element = card.querySelector("[data-role='" + role + "']");

    element.classList.toggle("d-none", !copy);
    element.textContent = copy ?? "";
  }

  const surface = {

    // Retire the card's wiring and take it off the page. Only a caller whose card is transient calls this; the docked cards live as long as the mount that
    // created them and are torn down by the mount signal instead.
    close: () => {

      teardown.abort();
      card.remove();
    },

    /* Fill the card in from a configured controller, and name what a removal would strip alongside it. Populating is also what disarms a standing removal
     * confirmation and blanks the verdict line: both describe whatever the card was showing a moment ago, and the card is now describing something else.
     */
    populate: ({ address, macs = [], password, tokens, username, verifyTls }) => {

      fields.address.value = address;
      fields.password.value = password;
      fields.token.value = tokens?.access ?? "";
      fields.username.value = username;
      fields.verifyTls.checked = verifyTls;
      removalMacs = macs;

      disarmRemoval();
      verdict.invalidate();
    },

    /* What the user has entered, in the shape a controllers[] item itself carries, so every validation, every probe body, and every write reads one vocabulary all
     * the way from the card to the plugin's own identity composition.
     *
     * A blank token field still composes a tokens object here, because this reads the card rather than deciding anything about it. What an empty field means is the
     * write path's rule to state, and it states it once.
     */
    values: () => ({ address: fields.address.value, password: fields.password.value, tokens: { access: fields.token.value }, username: fields.username.value,
      verifyTls: fields.verifyTls.checked }),
    verdict
  };

  // Each masked secret's reveal, bound from the markup itself: a toggle declares the field it serves, so the card grows a reveal without this wiring changing.
  for(const toggle of card.querySelectorAll("[data-reveal]")) {

    ui.on(toggle, "click", () => toggleReveal({ input: fields[toggle.dataset.reveal], toggle }), { signal: cardSignal });
  }

  // An edit to any field retires the verdict standing beside it, so the line never describes anything but the current input. A checkbox announces its own edits on
  // "change" rather than "input", so each field is bound on the event its kind actually fires.
  for(const field of Object.values(fields)) {

    ui.on(field, isCheckbox(field) ? "change" : "input", () => verdict.invalidate(), { signal: cardSignal });
  }

  ui.on(control("validate"), "click", () => void onValidateLogin({ button: control("validate"), card: surface }), { signal: cardSignal });

  if(onCancel) {

    control("cancel").classList.remove("d-none");
    ui.on(control("cancel"), "click", onCancel, { signal: cardSignal });
  }

  if(onSave) {

    control("save").classList.remove("d-none");
    ui.on(control("save"), "click", () => void onSave(), { signal: cardSignal });
  }

  if(onRemove) {

    control("remove").classList.remove("d-none");
    ui.on(control("remove"), "click", armRemoval, { signal: cardSignal });
    ui.on(control("removeCancel"), "click", disarmRemoval, { signal: cardSignal });

    ui.on(control("removeConfirmed"), "click", () => {

      disarmRemoval();
      void onRemove({ macs: [] });
    }, { signal: cardSignal });

    ui.on(control("removeSwept"), "click", () => {

      disarmRemoval();
      void onRemove({ macs: removalMacs });
    }, { signal: cardSignal });
  }

  container.replaceChildren(card);

  return surface;
};

/* Validate a card's connection and persist it, which is the whole of what Save means.
 *
 * Validation comes first and a failure writes nothing at all: a controller the plugin cannot connect to is not a configuration worth saving, and the card's own
 * verdict line already says why. The write then opens a session of its own rather than riding the feature-options page's long-lived one, because that page's
 * session is driven by its debounced option-persist effect and a card has no business staging anything behind it.
 *
 * The re-entry through refreshControllers() at the end is a correctness step rather than a repaint. The page's own session holds a replica of the configuration
 * that its option-persist effect writes from, and a save through an independent session leaves that replica describing the controllers as they were - so the next
 * option edit would quietly write the pre-save controller list back over this one. Re-entry re-reads the host configuration into that session before it repaints.
 * The window it cannot close is the instant between this commit and that re-read: an option edit whose debounce flushes inside it can still clobber, the same
 * in-flight instant every write on this page carries.
 *
 * @returns The address that was written, or null when nothing was.
 */
const saveController = async ({ card, originalAddress }) => {

  const identity = card.values();
  const probe = await requestControllerProbe({ ...identity, verdict: card.verdict });

  if(!probe) {

    return null;
  }

  try {

    const session = await PluginConfigSession.open({ host: homebridge, name: webUiParams.name });

    // The epoch is read immediately before the write, and again after it, on the same terms the load-time wiring reads it: a reopened panel retires this copy, and
    // a retired copy must not write configuration underneath the copy the user is looking at.
    if(ui.epochSignal.aborted) {

      return null;
    }

    await session.commit(withControllerSaved(session.platform, { ...identity, originalAddress }));

    if(ui.epochSignal.aborted) {

      return null;
    }

    await homebridge.savePluginConfig();
  } catch(err) {

    card.verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to save this controller."], tone: "text-danger" });

    return null;
  }

  // A token-only connection is a successful save with a consequence worth saying out loud, since the user will find no devices to configure behind it.
  card.verdict.render({ lines: (probe.kind === "token-only") ?
    [ "This controller has been saved.", "Its API token is valid. Add a local user's username and password to bring its doors and devices into HomeKit." ] :
    ["This controller has been saved."], tone: "text-success" });

  /* What this session remembers about the controllers is now a write behind, so the generation moves and every fetch still in flight loses its claim to be kept.
   * An address change also strands whatever was remembered under the address the user replaced, which names nothing the configuration holds any more; the Add
   * Controller path has no previous address and strands nothing.
   */
  cacheGeneration++;

  if(originalAddress && (originalAddress !== identity.address)) {

    devicesByAddress.delete(originalAddress);
  }

  /* The address that was just written is then re-seeded from this save's own validation, which connected to the controller with exactly this identity moments ago
   * and came back with its answer. That is newer than anything a deletion would have left behind, so the repaint below labels the entry with the controller's live
   * name rather than falling back to the raw address, and the next selection is served rather than reconnecting.
   */
  devicesByAddress.set(identity.address, { ...probe, devices: processDeviceList({ address: identity.address, devices: probe.devices }) });

  // The status feed's registry follows the re-seed, so the saved controller's devices are viewable under the identity that was just validated.
  void sendStatusContext();

  await ui.featureOptions.refreshControllers();

  return identity.address;
};

/* Remove a controller from the configuration, with the settings sweep the user chose.
 *
 * The write closes with the same re-entry Save makes, for the same reason, and then lands the page on the global view. That landing is not cosmetic: the node the
 * page was showing has just left the configuration, and the sidebar repaint replaces the controller list without moving the selection, so a page left alone would
 * go on showing a controller that no longer exists. The framework's own Global Options link is the affordance for that, so the landing is a click on the page's
 * own navigation rather than a reach into state the framework owns.
 */
const removeController = async ({ address, card, macs }) => {

  try {

    const { withControllerRemoved } = await accessConfig();
    const session = await PluginConfigSession.open({ host: homebridge, name: webUiParams.name });

    if(ui.epochSignal.aborted) {

      return;
    }

    await session.commit(withControllerRemoved(session.platform, { address, macs }));

    if(ui.epochSignal.aborted) {

      return;
    }

    await homebridge.savePluginConfig();
  } catch(err) {

    card.verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to remove this controller."], tone: "text-danger" });

    return;
  }

  // The controller is gone from the configuration, so what this session remembered about it goes with it, and the generation moves so a fetch that was already in
  // flight for that address cannot put it back. The settings sweep read its MAC addresses long before this, when the card was populated.
  cacheGeneration++;
  devicesByAddress.delete(address);

  // The status feed's registry follows the delete, so a removed controller's serials leave it rather than lingering as viewable ghosts.
  void sendStatusContext();

  await ui.featureOptions.refreshControllers();

  document.querySelector("#controllersContainer .nav-link[data-navigation='global']")?.click();
};

/* Mount a card that edits a controller already in the configuration, in whichever home the caller names.
 *
 * Each home differs in where it sits and in what a removal can offer, and in nothing else. The docked editor rides a reachable controller's own stats panel
 * and can strip the settings of every device that controller answered with; the editor the connection-error view hosts reaches a controller the page has no device
 * list for, where removal is offered on its own. Both correlate to a configuration item by address, both validate before they write, and both follow the address
 * they wrote so a second save edits the same item rather than appending a duplicate beside it.
 *
 * @param options.collapsible   - Whether the card sits behind a disclosure the user opens, which the docked editor does and the error-view editor does not.
 * @param options.container     - The element this editor owns entirely, including its visibility.
 * @param options.heading       - The card's heading, on the card factory's own terms.
 * @param options.helper        - The card's explanatory line, on the card factory's own terms.
 * @param options.noSweepReason - What a removal says when it has no device settings to offer to strip.
 * @param options.signal        - The mount's lifecycle signal.
 * @param options.sweepable     - Whether a removal may offer to strip the controller's device settings.
 *
 * @returns The editor's surface: the per-render call that shows, hides, and re-populates it.
 */
const mountControllerEditor = ({ collapsible = false, container, heading, helper, noSweepReason, signal, sweepable = false }) => {

  const slot = document.createElement("div");

  if(collapsible) {

    const disclosure = document.createElement("details");
    const summary = document.createElement("summary");

    summary.textContent = "Controller connection settings";
    disclosure.append(summary, slot);
    container.replaceChildren(disclosure);
  } else {

    container.replaceChildren(slot);
  }

  // The configured address this card currently stands for, which is the item a save writes onto and a removal drops.
  let configAddress = null;

  const card = mountConnectionCard({

    container: slot,
    heading,
    helper,
    noSweepReason,
    onRemove: ({ macs }) => removeController({ address: configAddress, card, macs }),
    onSave: async () => {

      const saved = await saveController({ card, originalAddress: configAddress });

      // The card now stands for the address it just wrote. Following it is what keeps an address change an edit: without this, a second save would look for the
      // address the user replaced, find nothing, and append a duplicate controller beside the one it meant to edit.
      if(saved !== null) {

        configAddress = saved;
      }
    },
    signal
  });

  return {

    render: (address) => {

      // Nothing to edit: the render is a device or the global view, or the page has no controller in scope at all.
      if(!address) {

        container.classList.add("d-none");

        return;
      }

      container.classList.remove("d-none");
      configAddress = address;

      const item = controllers(injectedConfig).find((controller) => controller?.address === address);

      /* The identities a removal could offer to strip settings for are read out of this controller's remembered answer here rather than stored beside it, so the one
       * answer this session holds is the only thing describing what a controller brought with it. A controller this session never reached has nothing remembered and
       * offers removal without the sweep, which is the case the card's own no-sweep wording is written for.
       *
       * What is collected is each record's SCOPING identity - the serial the UI server decorated it with - and never its raw MAC address. A configured option entry
       * is addressed by the scoping identity, so a sweep handed raw MACs would match nothing and quietly leave every one of the removed controller's settings behind.
       */
      card.populate({

        address: address,
        macs: sweepable ? (devicesByAddress.get(address)?.devices.map((device) => device.serialNumber).filter((id) => typeof id === "string") ?? []) : [],
        password: item?.password ?? "",
        tokens: item?.tokens,
        username: item?.username ?? "",
        verifyTls: item?.verifyTls === true
      });
    }
  };
};

/* The card the framework's connection-error view hosts, paired with the mount it belongs to, or null before the first error render.
 *
 * This is the one path that reaches a controller the page has no device list for, and those are exactly the controllers a user most needs to fix or remove: a wrong
 * password, a changed address, a console that is off, and the healthy token-only controller whose doors need a local user's credentials before they can be
 * configured.
 */
let errorPanel = null;

// Render our own panel inside the framework's connection-error view. The panel element and the signal are the mount's own and arrive unchanged on every error
// render, so the card is built once and re-populated afterwards, exactly as the docked editor is.
const showControllerErrorPanel = ({ controller, panel, signal }) => {

  if(errorPanel?.signal !== signal) {

    // The compact-card class keys the page's style block, so this card's controls render at the panel's own type rhythm rather than the full-size card scale.
    panel.classList.add("hbua-compact-card");

    errorPanel = { editor: mountControllerEditor({

      container: panel,
      heading: "Controller connection settings",
      helper: "Update this controller's address or sign-in, or remove it from this plugin.",
      noSweepReason: "This controller has answered with no device list, so the feature options set for its devices cannot be identified and will be left in place.",
      signal
    }), signal };
  }

  // A controller-less error render - a configuration read that failed, or a controller list that never arrived - has nothing for this card to edit.
  errorPanel.editor.render(controller?.serialNumber ?? null);
};

/* The dock's two sub-regions and the serial the hook last rendered, paired with the mount they belong to, or null before the first render of the session.
 *
 * The status panel hands the same dock element to every render of one mount, so the pair is built once per mount - keyed on the mount's own signal, which is the
 * framework's stated once-ness idiom - and REPLACES whatever the dock is holding rather than appending to it, so a superseded mount's regions from an earlier
 * show() cycle can never accumulate beneath the new ones.
 *
 * Subdividing the dock is what honors mountControllerEditor's ownership contract: its container is the element the editor owns entirely, and its mount
 * replaceChildren()s that container - so the token-only notice lives in a region of its own above the editor's, where the editor's mount can never wipe it. The
 * remembered serial rides the mount pair rather than bare module state, so a fresh mount starts with no remembered serial and a stale one can never leak a stray
 * re-view across a remount; the hello re-elicitation reads it from the CURRENT mount pair.
 */
let detailsPanel = null;

/* The plugin's content hook beneath the live status panel: the docked connection editor and the token-only notice. The identity rows and the live rows above are
 * the panel's own; what docks here is the content whose lifetime is the mount's rather than the selection's.
 *
 * The hook runs on every selection render, the mount-time no-device render included - the signal-keyed once-ness tolerates that call by construction, the same
 * guard this dock has always keyed its mount on.
 */
const showAccessDetails = ({ device, panel, signal }) => {

  if(detailsPanel?.signal !== signal) {

    const editorRegion = document.createElement("div");
    const noticeRegion = document.createElement("div");

    // The compact-card class keys the page's style block, so the standing editor's controls render at the panel's own type rhythm rather than the full-size
    // card scale.
    editorRegion.className = "hbua-compact-card";

    panel.replaceChildren(noticeRegion, editorRegion);

    detailsPanel = { editor: mountControllerEditor({

      collapsible: true,
      container: editorRegion,
      heading: null,
      helper: "Update this controller's address or sign-in, or remove it from this plugin.",
      noSweepReason: "This controller has not answered with a device list in this session, so the feature options set for its devices cannot be identified and " +
        "will be left in place.",
      signal,
      sweepable: true
    }), lastSerial: undefined, noticeRegion, signal };
  }

  // Remember the serial this hook is rendering, on the mount pair itself and before any early return, so the hello re-elicitation can re-request the on-screen
  // view from a fresh helper process. The no-device render remembers the absence just as deliberately.
  detailsPanel.lastSerial = device?.serialNumber;

  const { editor, noticeRegion } = detailsPanel;

  // Whether the selection belongs to a controller this session reached with an API token alone, which is what decides both the notice below and where the connection
  // editor is offered.
  const tokenOnly = Boolean(device) && (devicesByAddress.get(device.hbuaConfigAddress)?.kind === "token-only");

  /* The docked editor rides the controller's own node, and every node of a token-only controller. A credentialed controller answers with a record of its own, so
   * its node is the one place its connection is edited and a device render leaves the editor out of sight - a device is not a thing whose connection can be edited.
   * A token-only controller has no record of its own to select, so the editor is offered from wherever the user is instead of from a node that does not exist. It is
   * created once per mount and only toggled here, which is what keeps its wiring alive across the selection changes that repaint the panel beside it.
   *
   * The address the editor edits is the one the sidebar reached this controller at, stamped onto every record when the list was processed.
   */
  editor.render((device && (isController(device) || tokenOnly)) ? (device.hbuaConfigAddress ?? null) : null);

  /* The notice region is re-rendered on every invocation - the token-only arm writes it, every other arm clears it - because the region persists for the mount's
   * life, and an un-toggled notice would linger after switching to a credentialed selection. A token-only controller's devices are real and configurable, and what
   * they are not yet is HomeKit accessories. The notice says which of those is which, and sits between the panel's facts and the connection editor because that is
   * the order a user reads them in: what this is, why it is not in HomeKit, and where to fix it.
   */
  if(!tokenOnly) {

    noticeRegion.replaceChildren();

    return;
  }

  const notice = document.createElement("p");

  notice.className = "small mb-0 mt-2";
  notice.textContent = TOKEN_ONLY_NOTICE;

  noticeRegion.replaceChildren(notice);
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  connectionErrorPanel: showControllerErrorPanel,
  getControllers: getControllers,
  getDevices: getDevices,
  sidebar: {

    controllerLabel: "Access Controllers",

    /* The refresh action the framework docks on the controller-list heading. Reloading the world is one generation bump and one cleared map: the handler is
     * invalidation and nothing more, because the framework owns everything around it - the re-entry through its own show(), the boot affordance that clothes the
     * refetch, and the control's in-flight state. The selection landing back on the first controller is what reloading costs, the same landing every framework
     * re-entry makes.
     */
    refresh: {

      label: "Refresh controllers",
      onRefresh: () => {

        cacheGeneration++;
        devicesByAddress.clear();
      }
    }
  },

  /* The live status panel configuration. The panel component, the wire vocabulary, and the view cadence are the framework's; what is supplied here is exactly the
   * Access projection - the identity cells the retired static grid carried (the panel's own status label owns liveness), the placeholder skeleton, the error copy
   * whose Access wording differs from the component's credential-neutral defaults, the helper-restart re-elicitation, and the docked content hook.
   */
  statusPanel: {

    contentPanel: showAccessDetails,
    errorMessages: {

      "auth-invalid": { label: "Sign-in failed", message: "The controller rejected this sign-in. Check the username and password, or the API token, in the card " +
        "below." },
      "auth-missing": { label: "Sign-in required", message: "Live status needs a way to sign in to this controller. Add a local user's username and password, or " +
        "an API token, in the card below." },
      "not-found": { message: "This device was not listed by a configured controller in this session. Refresh the controller list to relist it." }
    },
    identity: (device) => [

      { label: "Model", value: device.model ?? device.display_model },
      { label: "Device ID", mono: true, value: device.serialNumber },
      { label: "IP Address", mono: true, value: device.ip ?? "" }
    ],

    /* The re-elicitation chokepoint for a restarted helper process, re-establishing BOTH halves the fresh process lost: the context registry first, then the
     * current selection's view. The two are sequenced inside one voided handler because the view request must land against a filled registry, and a no-device
     * selection sends the context alone. The view re-request is the one deliberate plugin-side use of the shared view route: the panel owns the route on every
     * selection change, but its hello handling clears floors and notifies without re-viewing, so without this a helper restart would freeze the on-screen device
     * on its pre-restart snapshot indefinitely. The remembered serial is read from the CURRENT mount pair, and the panel handle is read at call time because it is
     * minted per show() and must never be captured.
     */
    onServerHello: () => {

      void (async () => {

        await sendStatusContext();

        const serial = detailsPanel?.lastSerial;

        if(serial === undefined) {

          return;
        }

        const request = homebridge.request(STATUS_VIEW_ROUTE, { serialNumber: serial });

        ui.featureOptions.statusPanel?.watchRequest(request);

        // console is the browser panel's diagnostic transport; a transport failure here is a diagnostic, since feed progress and errors return over push events.
        // eslint-disable-next-line no-console
        request.catch((error) => console.error("The status view request failed.", error));

        try {

          await request;
        } catch {

          // The transport failure is already logged on the separate chain above; the panel's own re-request cadence covers the next selection.
        }
      })();
    },

    // The pre-snapshot skeleton, one generic set - the snapshot replaces the row set wholesale per device, so this is a rendering placeholder rather than a
    // promise, and a reader's snapshot simply carries fewer rows.
    placeholderRows: [

      { id: "lock", label: "Lock", sizer: "Unlocked" },
      { id: "door", label: "Door", sizer: "Closed" },
      { id: "tamper", label: "Tamper", sizer: "Detected" }
    ]
  },
  ui: {

    // The copy the framework's boot affordance shows while a controller connection is in flight, in place of its generic default.
    connectingMessage: "Connecting to your UniFi Access controller...",
    // The guidance line for a controller the page has no device list for, pointing at the connection editor mounted beneath the error rather than at a tab the
    // reader is already on.
    controllerFailureGuidance: "You can correct this controller's connection details below, or retry.",
    // The delay before the connection-error view re-enables its retry button, overriding the library's five-second default. A UniFi Access controller can take well
    // over five seconds to authenticate and answer with its topology, so twenty seconds keeps an impatient user from hammering retry while the first connection
    // attempt is still in flight.
    controllerRetryEnableDelayMs: 20000,
    isController: isController,
    validOption: validOption,
    validOptionCategory: validOptionCategory
  }
};

// Parameters for our plugin webUI.
const webUiParams = {

  featureOptions: featureOptionsParams,
  firstRun: {

    isRequired: firstRunIsRequired,
    onStart: firstRunOnStart,
    onSubmit: firstRunOnSubmit
  },
  name: "UniFi Access"
};

// Instantiate the webUI.
const ui = new webUi(webUiParams);

/* Adopt the framework's theming for this page - the design tokens, the themed canvas, the dark-mode corrections, the page-kit classes, and the host's own accent -
 * with one call that holds for as long as this module copy owns the window. Theming is a page concern rather than a view one, so the first-run page, the
 * feature-options view, and the support tab all wear it from here. The promise is voided rather than awaited because the framework owns its rejection posture: a
 * failed initial lighting-mode read still leaves the sheets adopted and the host's theme signals followed, so the next announcement the host makes brings the page
 * into step.
 */
void ui.registerTheming();

/* Validate a card's controller connection on demand. It is early feedback and nothing else: every path that commits anything - the first-run submit, a card's own
 * Save - validates through this same helper first, so a user who never presses the control is no worse off, and one who does learns whether their sign-in works
 * before committing a configuration.
 */
const onValidateLogin = async ({ button, card }) => {

  button.disabled = true;

  try {

    const probe = await requestControllerProbe({ ...card.values(), verdict: card.verdict });

    // The epoch signal is read after the await: a reopened panel mints a successor copy of this module, and a retired copy must not paint over what the copy the
    // user is looking at is showing. The helper paints every failure itself, so only the success verdict is ours to say.
    if(ui.epochSignal.aborted || !probe) {

      return;
    }

    // A token-only connection is valid, and saying only that would leave the user wondering where their doors went once the device list comes back empty.
    card.verdict.render({ lines: (probe.kind === "token-only") ?
      [ "Your UniFi Access API token is valid.", "Add a local user's username and password to bring this controller's doors and devices into HomeKit." ] :
      ["Your UniFi Access controller sign-in is valid."], tone: "text-success" });
  } finally {

    // The re-enable is unconditional, superseded copy or not: the invocation that disabled the control is the only thing that can balance its own disable.
    button.disabled = false;
  }
};

// A reveal toggle's accessible name, naming what the NEXT click will do rather than what the field is doing now, which is what a control announced as a button
// wants to say. The subject is the field's own plain name, so each toggle on the page announces which secret it acts on.
const revealLabel = (subject, revealed) => (revealed ? "Hide the " : "Show the ") + subject + ".";

/* Flip one masked secret between hidden and shown. A toggle names the field it serves and the subject its accessible name uses on its own data attributes, so a
 * field gains a reveal by carrying a button in the markup rather than by growing a handler of its own.
 *
 * The field's type, the toggle's accessible name, and its pressed state describe one state between them, so they are written together and no path can move one and
 * leave the others saying something else. Nothing here touches a value: whether a secret is on screen right now says nothing about the configuration.
 */
const toggleReveal = ({ input, toggle }) => {

  const revealed = input.type === "password";

  input.type = revealed ? "text" : "password";
  toggle.setAttribute("aria-label", revealLabel(toggle.dataset.revealSubject, revealed));
  toggle.setAttribute("aria-pressed", revealed ? "true" : "false");
};

/* The first-run page's own card, mounted into the slot the template vacated. It is mounted here rather than at first-run start because the page's markup is present
 * before this module loads while the first-run hooks run later, so one mount at load serves every call the framework makes into them afterwards.
 */
const firstRunCard = mountConnectionCard({ container: document.getElementById("hbuaFirstRunCard") });

/* The card the Add Controller affordance opens, or null when the affordance is closed.
 *
 * Its region sits outside the framework's own reveal cycle, so nothing the framework does opens or closes it and its whole lifetime is ours. That is why it closes
 * on every exit path rather than being left standing: an unsaved card that survived a view rebuild would be describing a page that no longer exists behind it.
 */
let addCard = null;

// Put the Add Controller card away and give the feature-options view back its main content, discarding whatever was typed into it. Closing an already-closed
// affordance is nothing at all, which is what lets every exit path call it without first asking whether it is open.
const closeControllerEditor = () => {

  if(!addCard) {

    return;
  }

  addCard.close();
  addCard = null;

  document.getElementById("hbuaControllerEditor").style.display = "none";
  document.getElementById("hbuaFeatureContent").style.display = "";
};

/* Open a blank card as the whole of the feature-options view's main content.
 *
 * The framework's own regions are hidden by hiding the wrapper this plugin put around them, never by writing on the regions themselves: the framework sets their
 * display on its own teardown-and-reveal schedule, and two writers on one element would eventually disagree. Hiding a wrapper of our own leaves everything the
 * framework wrote exactly as it wrote it, so restoring the view is a single assignment and the framework never notices the card was there.
 */
const openControllerEditor = () => {

  const region = document.getElementById("hbuaControllerEditor");

  // A second click while the affordance is already open would otherwise mount a second card over the first and leak the first one's wiring.
  closeControllerEditor();

  addCard = mountConnectionCard({

    container: region,
    heading: "Add a UniFi Access controller",
    helper: "Enter the controller's address and either a local user's login or an Access console API token. The sign-in is validated against the controller before " +
      "anything is saved.",
    onCancel: () => closeControllerEditor(),
    onSave: () => saveController({ card: addCard, originalAddress: undefined })
  });

  document.getElementById("hbuaFeatureContent").style.display = "none";
  region.style.display = "";
};

/* Wire the plugin's own page controls. Every binding registers through the facade, so a superseded module copy's handlers die when a newer copy claims the window.
 *
 * The lookups hand their result straight to the facade: a nullish target declares that surface absent, so registering against a control this page's markup omits
 * is the facade's own documented no-op and costs that control's wiring alone.
 */
ui.on(document.getElementById("hbuaAddController"), "click", () => openControllerEditor());

/* A sidebar navigation click closes the Add Controller card, so choosing somewhere else to be takes effect at once rather than at the next rebuild. The rebuild
 * paths close it too, at the controller hook they all pass through; this is for the immediacy the rebuild cannot give, since navigating within an already-rendered
 * view rebuilds nothing. The binding is delegated from the plugin's own column, so it survives every repaint the framework makes to the sidebar inside it.
 */
ui.on(document.getElementById("hbuaSidebarColumn"), "click", (event) => {

  if(event.target.closest(".nav-link[data-navigation]")) {

    closeControllerEditor();
  }
});

// The load-time wiring's own lifecycle. Aborting it is how an envelope that failed or expired tells a continuation still running underneath it that it must not stage
// anything after the fact.
const wiringController = new AbortController();

/* The signal the wiring's cancellation points read: the envelope's own controller, bounded by this module copy's claim on the window. The epoch half matters because
 * a reopened settings panel mints a successor copy and retires this one, so whichever of the two aborts first cancels a superseded copy's wiring at the same
 * chokepoints the deadline uses, rather than letting a retired copy write configuration underneath the copy the user is looking at.
 */
const wiringSignal = ui.epochBounded(wiringController.signal);

/* Run the legacy-settings migration, once, at load.
 *
 * The envelope is awaited here rather than at module top, so the page's chrome arms immediately instead of waiting on a bridge round trip. ui.show() runs only after
 * the envelope settles, which is the ordering that matters: the framework opens its own configuration session inside the launch path ui.show() starts, so every
 * replica it hands to a hook - the first-run config, the feature-options page's persist path - is read after the migration has settled, and none of them can commit
 * a pre-migration snapshot over it.
 *
 * A migration that composes a patch persists it itself, without waiting for the user to press Save. Most people never open this panel to save anything, so a
 * migration that waited for one would leave a fleet split between two configuration shapes indefinitely, and the plumbing that reconciles them could never retire.
 * The write is gated on there being a patch, which is what bounds the cost: only a pass that actually found legacy settings writes at all, so a converged
 * configuration's every later open finds nothing to do and reaches neither the controllers nor the disk.
 *
 * Reopening the panel is convergent. Each open imports a fresh copy of this module whose wiring runs independently, and a copy reading an already-migrated
 * configuration composes nothing and writes nothing. Two genuinely simultaneous wirings are where the honest bound sits: they read the same configuration but may
 * resolve different sets of reachable controllers, so their patches need not be identical and the later commit is the one that stands. Nothing is lost to that -
 * whatever the earlier pass migrated is still sitting in the configuration the later one read, and the next open migrates it again.
 *
 * One further bound, stated plainly: the check before the commit is the last cancellation point. A commit whose bridge round trip is already in flight cannot be
 * recalled, because the session takes no signal and the deadline bounds only the await, so composing the epoch into the signal narrows the stale-write window to
 * that in-flight instant rather than closing it.
 *
 * When the envelope fails, nothing has been written and the page loads exactly as it otherwise would. No read this webUI performs consults the consolidated
 * settings - first run reads the identity, which stays in the configuration file - so a session whose fetches are failing still routes, still runs first run, and
 * simply leaves the migration to a session whose fetches succeed.
 */
const wireAccessConfig = async () => {

  const { migrate } = await accessConfig();

  // The library's session is the single conduit the framework's own writes use, so the patch merges onto a replica synced just now rather than onto a snapshot taken
  // before the page opened. The name seeds the primary platform entry, and it is read from the same constant the framework is configured with so the two cannot drift.
  const session = await PluginConfigSession.open({ host: homebridge, name: webUiParams.name });

  /* Resolve a MAC address for each controller whose per-controller settings still need one. The probes run in parallel because each performs a full authentication
   * and topology fetch, and serializing them would multiply the open-time wait by the number of controllers configured.
   *
   * Each probe is bounded individually, and that is what delivers the per-controller isolation the migration depends on. A deadline bounds only the await - the
   * request itself cannot be recalled - so without a per-probe bound a single slow or hung controller would stall the shared wait past the envelope, abort the
   * wiring, and discard the ENTIRE pass, every other controller's resolved work included, on every open until that one controller sped up. Bounded, it costs nobody
   * but itself. A probe that throws, that reports a failure, that answers no devices, or that its own deadline overtakes contributes no entry at all, and the
   * controller it names simply keeps its settings for another day.
   */
  const macByAddress = new Map();

  await Promise.all(controllersAwaitingMigration(session.platform).map(async ({ address, password, tokens, username, verifyTls }) => {

    const response = await withDeadline({ promise: homebridge.request("/getDevices", { address, password, tokens, username, verifyTls }),
      seconds: PROBE_DEADLINE, signal: wiringSignal }).catch(() => null);

    /* The controller reports itself as a record whose display model is "controller", so it is found by that key rather than by its position in the list.
     *
     * What is taken from it is its SCOPING identity - the serial the UI server decorated it with, which is the exact spelling the plugin's runtime keys a
     * controller-scoped option entry by - and never the raw MAC address the record also carries. An entry composed against the raw form would be written in a
     * spelling no read at runtime ever asks for, so the migration would appear to succeed while the setting it moved silently stopped answering.
     */
    const scopingId = classifyProbeResponse(response).devices.find(isController)?.serialNumber;

    if(scopingId) {

      macByAddress.set(address, scopingId);
    }
  }));

  const patch = migrate(session.platform, macByAddress);

  // The signal is read immediately before the write, so an envelope that expired while the probes were still running - or a copy the window has retired - cannot
  // stage a patch after the fact.
  if(patch && !wiringSignal.aborted) {

    await session.commit(patch);

    // The signal is read a second time, because the commit itself was an await and the envelope may have expired across it. A save the deadline overtakes is skipped
    // rather than forced, which leaves the migration staged for the user's own save - the weaker outcome, and the honest one.
    if(!wiringSignal.aborted) {

      await homebridge.savePluginConfig();
    }
  }
};

try {

  await withDeadline({ promise: wireAccessConfig(), seconds: WIRING_DEADLINE, signal: wiringSignal });
} catch(error) {

  wiringController.abort(error);
}

// Display the webUI.
ui.show();
