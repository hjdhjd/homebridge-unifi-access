/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge UniFi Access webUI.
 */
"use strict";

import { CONTROLLER_LISTED_WARNING, classifyProbeResponse, deviceListResult, hasValidIdentity, makeAccessConfig, makeControllerList, readProbeRejection,
  staleSelectionVerdict } from "./lib/webui/access-config.js";
import { FeatureOptions, buildCatalogIndex, enumerateConfiguredEntries, enumerateScopeEntries, formatValueList,
  scopeSafeId } from "homebridge-plugin-utils/featureOptions.js";
import { TOKEN_REFUSED_WARNING, makeControllerActions, makeControllerProbe } from "./lib/webui/controller-actions.js";
import { addressListedElsewhere, addressListingForm } from "homebridge-plugin-utils/webui/address.js";
import { createActionGuard, withDeadline } from "homebridge-plugin-utils/webUi-liveness.mjs";
import { ACCESS_STATUS_CONTEXT_ROUTE } from "./lib/webui/status-route.js";
import { PluginConfigSession } from "homebridge-plugin-utils/pluginConfigSession.mjs";
import { STATUS_VIEW_ROUTE } from "homebridge-plugin-utils/webui/status.js";
import { createSaveFlow } from "homebridge-plugin-utils/webui/saveflow.js";
import { displayedName } from "homebridge-plugin-utils/homekit-name.js";
import { errorMessage } from "homebridge-plugin-utils/webUi-errors.mjs";
import { webUi } from "homebridge-plugin-utils/webUi.mjs";

// The configured controller list's interpreters, bound once over homebridge-plugin-utils' listed-address rule, which is the rule the plugin skips a repeated
// controller by, so the page lists, refuses, and writes controllers by the same reading of an address the plugin starts them by.
const { controllerListedElsewhere, controllers, controllersWithSave, primaryController, primaryListedElsewhere, withPrimaryIdentity } =
  makeControllerList({ addressListedElsewhere, addressListingForm });

/* The bound in seconds on each individual controller probe. This is not a worst-case bound and does not pretend to be one: a probe performs a full authentication and
 * then fetches the controller's information and topology documents, so a genuinely worst-case first connection runs past it. PROBE_DEADLINE admits the healthy
 * case. A controller slower than that reads as unreachable for this pass, keeps its per-controller settings, and is probed again at the next open, which is exactly the
 * posture an offline controller already gets.
 */
const PROBE_DEADLINE = 5;

/* The bound in seconds on the whole load-time wiring below. The page's own boot monitor fires its slow-boot notice and hides the spinner ten seconds into the
 * page's parse, while WIRING_DEADLINE starts only once the loader has imported this module, so the envelope settles inside that watchdog whenever the loader's own
 * startup fits in the margin between the two...and then a wiring step that hangs against an unresponsive host is not what makes the settings panel look broken.
 *
 * The catalog read carries the bound homebridge-plugin-utils gives it and each migration probe carries PROBE_DEADLINE, but the session open and its write carry
 * none, and the bounded steps run one after another, so their bounds add up rather than overlap. This outer guard covers the unbounded steps and caps the sum. An
 * expiry stops the pass at its next cancellation point, and the whole pass retries at the next open. A configuration that has already converged never comes near
 * this guard, because its envelope is the catalog fetch and the session open and nothing else.
 */
const WIRING_DEADLINE = 8;

/* The bound in seconds on a controller connection check. A check performs a full authentication and then fetches the controller's documents, so the bound sits
 * well past a slow connection and is reached only by a check whose answer is not coming. A check that outlasts it answers as a request that threw, carrying the
 * deadline's own sentence, rather than leaving the card waiting on a request that never settles.
 */
const CONNECTION_CHECK_DEADLINE = 30;

/* What a controller's details panel says when this session reached it with an API token alone. Such a controller's devices are projected into HomeKit already -
 * the official API lists them and the runtime adopts them - so what credentials add is the controller's own information document, which is the source of the
 * facts this panel renders about the console itself and of an Enterprise hub's port topology. That is what this line tells the user, with the connection editor
 * sitting directly beneath it.
 */
const TOKEN_ONLY_NOTICE = "These devices are listed through this controller's API token and are in HomeKit already. Adding a local user's username and password " +
  "lets the plugin read the controller's own document as well: its name and uptime on this panel, and an Access Enterprise hub's ports.";

/* The configuration interpreters that need the served catalog, built over the framework's own page-lifetime read of it. A save and a removal reach them through
 * here rather than holding an instance, so a removal that happens long after the load-time wiring builds against the same catalog the boot read: the accessor
 * memoizes one fetch for the page, bounds it, validates its shape once, and clears its memo on rejection so a later read retries rather than holding a transient
 * fault for the session. The index is rebuilt per call because it is a pure walk over a fixed catalog and its readers are the load-time wiring, a save, and a
 * removal, each rare. The one instance anything keeps is the one the load-time wiring builds, which the sidebar's device links are named through, because they
 * render synchronously and cannot wait on the catalog.
 */
const accessConfig = async () => {

  const { categories, options } = await ui.featureOptions.catalog();

  return makeAccessConfig({ FeatureOptions, buildCatalogIndex, catalog: buildCatalogIndex(categories, options), controllers, controllersWithSave, displayedName,
    enumerateConfiguredEntries, enumerateScopeEntries, formatValueList, scopeSafeId });
};

/* Execute our first run screen until the primary controller carries both of the things the plugin needs of it. The two are asked separately because the plugin's own
 * configuration gate asks them separately: an address is where to connect, and an identity is how, and a configuration missing either is one the platform skips.
 * The framework injects our primary platform-config entry, so this is a pure predicate over the persisted config rather than a reach into the feature-options page's
 * state.
 *
 * The address is read as the platform reads it: only a string is an address, and it is read trimmed, so an address of spaces alone, or a hand edit that left
 * something other than a string, is a configuration the platform skips and one first run asks for again.
 */
const firstRunIsRequired = ({ config }) => {

  const controller = primaryController(config);

  return (typeof controller?.address !== "string") || !controller.address.trim().length || !hasValidIdentity(controller);
};

// Initialize our first run screen with any information from our existing configuration. The injected config is the primary platform entry; we pre-populate the form
// from its primary controller, if one is already configured. Populating also blanks the card's verdict line, because show() cycles repeat within one page - the menu
// re-enters the launch after a failure - and the card outlives every cycle, so a verdict painted in an earlier cycle never stands beside the next one's form.
const firstRunOnStart = ({ config }) => {

  const controller = primaryController(config);

  firstRunCard.populate({ address: controller?.address ?? "", password: controller?.password ?? "", tokens: controller?.tokens,
    username: controller?.username ?? "", verifyTls: controller?.verifyTls === true });

  return true;
};

/* The classes the login result line wears in every state. The tone layers on top of this base, so the line's blank, failure, and success states are one layout with
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

// The controller connection check every card's validate control, every card's Save, and the first-run submit share, bounded by CONNECTION_CHECK_DEADLINE. The
// bridge's request is reached through a closure rather than handed over as a reference, because the method reads its own object.
const requestControllerProbe = makeControllerProbe({ classifyProbeResponse, deadline: CONNECTION_CHECK_DEADLINE, hasValidIdentity, readProbeRejection,
  request: (path, body) => homebridge.request(path, body), withDeadline });

// Validate our Access sign-in and commit it. An answer of true hands the page over to the feature-options view and false keeps the user on the first-run form;
// the framework raises the spinner around the whole submit and brings it down on every path, so no path here touches it.
const firstRunOnSubmit = async ({ commit, config }) => {

  const identity = firstRunCard.values();
  const action = firstRunCard.verdict.start();
  const listed = { lines: [CONTROLLER_LISTED_WARNING], tone: "text-warning" };

  /* An address a controller after the primary already holds is refused before the connection test, by the rule a controller save is refused under, because the
   * answer needs no controller and the user should not wait on a connection whose result would be thrown away. The card's action is started first, as a save's
   * is, so a validation still in flight cannot paint over the refusal.
   */
  if(primaryListedElsewhere(config, identity)) {

    firstRunCard.verdict.render(listed);

    return false;
  }

  const probe = await requestControllerProbe({ ...identity, signal: action.signal });

  // A failed check is delivered through the action the submit started, which paints while the card presents it, and a retired one says nothing.
  if(probe.kind !== "passed") {

    if(probe.kind === "failed") {

      action.report({ ...probe.outcome, tone: "text-danger" });
    }

    return false;
  }

  try {

    // Persist the validated identity through the session's single write hook. We own the shape of the write - the identity lives on the primary controller, which
    // withPrimaryIdentity encodes while preserving any additional controllers - and the session owns persistence and the preservation of sibling platform entries.
    await commit(withPrimaryIdentity(config, identity));

    /* A controller that refused the API token beside the credentials is still a valid setup, and the user hears it here whether or not they pressed the validate
     * control, in the sentence a card's Save speaks and through the host's toast it speaks through. It follows the write rather than preceding it, because the
     * sentence says the controller has been saved, and a write that rejects answers on the card instead.
     */
    if(probe.answer.tokenRefused) {

      homebridge.toast.warning(TOKEN_REFUSED_WARNING);
    }

    return true;
  } catch(err) {

    // The config write can reject. Painting into the result line keeps the user on the form with concrete guidance and the specific failure, and this catch resolves
    // first, so the framework's generic toast never fires for this plugin.
    firstRunCard.verdict.render({ detail: errorMessage(err), lines: ["Unable to complete the plugin configuration."], tone: "text-danger" });

    return false;
  }
};

// The UI server projects the controller itself into the device list as a record whose display model is "controller" - every other model key belongs to a device the
// controller manages.
const isController = (device) => device.display_model === "controller";

// The serial a probe answer's controller row carries is the controller's identity in the exact spelling the runtime keys its controller-scoped entries by: the
// decorated serial of a credentialed answer, and the address identity of a token-only one. Every read of it on the page goes through this one expression.
const controllerSerial = (answer) => answer?.devices.find(isController)?.serialNumber;

/* The platform configuration the feature-options hooks (getControllers and getDevices) last received, or null before the first of them runs.
 *
 * The framework re-reads the host configuration into its own session immediately before it calls these hooks, so what is held here is the configuration the page
 * itself is working from rather than a snapshot taken at load. The docked editors populate their fields from it, which is a read the framework's render path gives
 * them no other way to make: the info-panel and connection-error bags carry the selection, not the configuration behind it.
 *
 * Nothing WRITES through this copy. Every write composes against the configuration its session holds at the write, so a stale copy here never persists. A
 * save's listed-address check does read it, ahead of the connection test, so a stale copy can refuse a save the composer would accept, which the user retries once
 * the page has caught up. It can never let a duplicate through, because the composer asks the same rule of the configuration the write composes over, and its
 * refusal is the one that decides.
 */
let injectedConfig = null;

/* Send the live-status feed its controller context: for each configured controller this session holds a kept probe answer for, the identity members exactly as the
 * configuration item spells them, the decorated serials of the answer's devices, and the decorated serial of the answer's controller record where one exists - a
 * token-only answer carries no console identity, so that member is honestly absent. A send follows every save and removal that lands, every put-back of a save's
 * seed, and every fetch whose answer is kept, so the feed's registry tracks what this session knows; the feed rebuilds its registry wholesale from each send. The
 * Refresh control's clear sends nothing and leaves the registry to the next send, and so does a write outcome the page does not recognize.
 *
 * The raw request promise feeds the shared panel's link-lost watchdog directly, as the panel's own view request does: the watchdog counts a rejection as a live
 * relay, so it must observe the raw promise rather than one the diagnostic's catch has already turned into a resolution. The console diagnostic runs on a separate
 * chain off the same promise, and the panel handle is read at call time because it is minted per show() and must never be captured. The settle is awaited so the
 * one caller that must sequence behind the send - the hello re-elicitation - can; every other call site voids the promise, and the swallow keeps a failure from
 * surfacing twice.
 */
const sendStatusContext = async () => {

  const contextControllers = [];

  for(const item of controllers(injectedConfig)) {

    const answer = answers.get(item?.address);

    if(!item?.address || !answer) {

      continue;
    }

    const entry = { address: item.address, password: item.password, serials: answer.devices.map((device) => device.serialNumber).filter((id) => typeof id === "string"),
      tokens: item.tokens, username: item.username, verifyTls: item.verifyTls };
    const serial = controllerSerial(answer);

    if(serial !== undefined) {

      entry.controllerSerial = serial;
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

// The sidebar's own order for the groups this page assigns: the hubs first, then the readers that hang off them.
const HUB_GROUP = "Hubs";
const READER_GROUP = "Readers";
const SIDEBAR_GROUP_ORDER = [ HUB_GROUP, READER_GROUP ];

// A group's place in the order above, with a group the order does not name ranking after every group it does.
const sidebarGroupRank = (group) => {

  const rank = SIDEBAR_GROUP_ORDER.indexOf(group);

  return (rank === -1) ? SIDEBAR_GROUP_ORDER.length : rank;
};

/* Add the fields the webUI framework renders from, and mark every record with the configured address of the controller that listed it. It touches the device
 * records and nothing on the page, which is what lets both writers of the kept controller answers run it: the device view's own fetch, and a save re-seeding from
 * the answer its validation just received. One helper is what keeps those two from processing the same list into two different shapes.
 *
 * The serial number is not computed here. It arrives already decorated by the UI server, which reaches the plugin's own policy module for the Enterprise port suffix
 * that tells one port of a multi-door hub from its siblings...knowledge the browser has no way to derive for itself.
 *
 * The visibility rule below reduces the sidebar to the hardware this plugin actually projects into HomeKit. A device whose model is not among the models the
 * supported devices report is put in the hidden group rather than dropped, so the framework still holds a complete list while the sidebar shows only what a user can
 * act on.
 */
const processDeviceList = ({ address, devices }) => {

  // An Enterprise hub is listed as its ports, and unifi-access spells each port's display model as the hub's with that port's name appended, which names a port
  // rather than a hardware model. A port is keyed by its model field instead, which carries the hub's own model and is the same on every port of that hub.
  const modelKeys = [...new Set(
    devices.filter(device => ["controller"].includes(device.display_model) || device.capabilities.includes("is_hub") || device.capabilities.includes("is_reader"))
      .map(device => (device.device_type === "UAH-Ent") ? device.model : device.display_model))];

  for(const device of devices) {

    device.name ??= device.alias ?? device.display_model;

    const model = (device.device_type === "UAH-Ent") ? device.model : device.display_model;

    if(!modelKeys.includes(model)) {

      device.sidebarGroup = "hidden";
    }

    device.sidebarGroup ??= device.capabilities.includes("is_hub") ? HUB_GROUP : READER_GROUP;

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
 * and the sidebar has nothing else to label the entry with until then. Every device fetch runs this, whether the list came off the wire or out of the kept answers: a
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

/* The page's coordinated write, stated once and handed to the actions below, whose removal writes through it, and to every card's save flow, so the page has
 * one account of how it reaches its write. It is a closure rather than a reference, because the framework page is constructed further down and the method reads
 * its own object: taking the reference at call time is what binds it to the page that exists by then. The options travel with the composer, because they carry
 * the rename an address change declares, and the framework carries the selection onto a renamed controller only when it is handed that rename.
 */
const commitConfig = (compose, options) => ui.featureOptions.commitConfig(compose, options);

/* The settings page's kept controller answers and the controller save and the controller removal that write them, built once for this page copy. Everything those actions
 * reach outside themselves is handed in from here, because each of those reaches is the page's to own: the host's toast, the framework's coordinated write and the
 * catalog-backed interpreters behind it, the configuration the page last received, the device-list decoration a save's seed runs over the answer it keeps, the
 * connection check and the status-context send, which travel over the UI-server bridge, and the row shape the UI server writes a controller into, which the serial
 * read interprets. The listed-address check comes from the controller list bound above and its sentence from the interpretation module, rather than through the
 * interpreters, because neither needs the catalog and a save's refusal must not wait on a catalog read. The error text rule is homebridge-plugin-utils', handed in
 * beside them because the module imports types alone. What the actions keep about each controller stays theirs, and the page reads it back through the handle alone.
 */
const { answers, removeController, saveController } = makeControllerActions({

  commitConfig,
  controllerListedElsewhere,
  controllerListedWarning: CONTROLLER_LISTED_WARNING,
  controllerSerial,
  errorMessage,
  interpreters: accessConfig,
  platformConfig: () => injectedConfig,
  processDeviceList,
  requestControllerProbe,
  sendStatusContext,
  toast: homebridge.toast
});

// Return the list of controllers from our plugin configuration, paired with a clean connection outcome - the list is configuration-derived, so no fetch is involved
// and no failure can occur. The framework injects our primary platform-config entry; we map each configured controller to the sidebar shape, deliberately carrying
// no credentials into the rendered list.
const getControllers = ({ config }) => {

  injectedConfig = config;

  /* Close an open Add Controller card here, which is the one place that covers every way the view can be rebuilt underneath it. Every rebuild routes through this
   * hook - a menu round trip's show(), a coordinated write's re-establishment, and the connection-error view's own Retry, which re-enters show() without touching
   * a menu button - and the framework leaves a standing takeover in place across a refresh of the controller list, so releasing it here needs no per-path wiring
   * and can miss none of them. A rebuild discards whatever was typed into the card, which is what a view rebuilding out from under an unsaved form should do.
   */
  closeControllerEditor();

  /* Each entry is labeled with the controller's own name once this session has heard it, and with the configured address until then. The answer this session already
   * received is where that name comes from, so a repaint of the sidebar arrives carrying the same labels the user was already reading rather than reverting every
   * entry to its raw address until a controller is selected again.
   */
  return {

    controllers: controllers(config).map((controller) => ({

      name: answers.get(controller.address)?.devices.find(isController)?.name ?? controller.address,
      serialNumber: controller.address
    })),
    error: ""
  };
};

// Return the list of devices associated with a given Access controller, paired with the connection outcome. The framework injects the live platform config alongside
// the selected controller, so we can recover the selected controller's identity (which the sidebar entries deliberately omit) without reaching for the config
// ourselves. A connection failure travels back on the result rather than through a separate request.
const getDevices = async (selectedController, { config }) => {

  injectedConfig = config;

  // The global context legitimately has no devices and no failure.
  if(!selectedController) {

    return { devices: [], error: "" };
  }

  // Find the entry in our plugin configuration. A sidebar entry can outlive a Settings-tab edit that removed its controller, so a miss is a carried failure whose
  // copy names what became of the entry and what to do about it, rather than a silent empty result that would render nothing the user can act on.
  const controller = controllers(config).find((c) => c.address === selectedController.serialNumber);

  if(!controller) {

    return deviceListResult(staleSelectionVerdict());
  }

  const cached = answers.get(controller.address);

  // A controller this session has already reached answers from what it said then, ahead of any bridge call at all. Every tab re-entry and every re-select passes
  // through here, and repeating a full connection for each of them is the wait the user notices most, for data that is almost never different.
  if(cached) {

    patchControllerLabel({ address: controller.address, devices: cached.devices });

    return deviceListResult(cached);
  }

  // The generation this fetch belongs to, read before the call and checked against after it, so an answer that an invalidation has overtaken can complete without
  // being kept.
  const generation = answers.generation();

  // The browser cannot reach the Access controller directly, so we bridge the request through the plugin's UI server, which holds the controller's identity. A
  // request that rejects is left to reject this hook, because the framework renders a rejected fetch as the plugin's own failure rather than the controller's,
  // which is what a UI server that did not answer is.
  const answer = classifyProbeResponse(await homebridge.request("/getDevices", { address: controller.address, password: controller.password,
    tokens: controller.tokens, username: controller.username, verifyTls: controller.verifyTls }));

  processDeviceList({ address: controller.address, devices: answer.devices });
  patchControllerLabel({ address: controller.address, devices: answer.devices });

  // Offer what this controller answered for keeping, so every later re-entry is served from it. Whether it is worth keeping is the answers' own rule to apply.
  if(answers.keep({ address: controller.address, answer, generation })) {

    // The status feed's registry tracks every kept answer, so the devices this fetch just listed become viewable the moment they are selectable.
    void sendStatusContext();
  }

  return deviceListResult(answer);
};

/* The configuration interpreter the load-time wiring built once the catalog resolved, or null before it lands. The sidebar renders a device link synchronously and
 * cannot wait on the catalog, so retaining the interpreter here is what lets a link be named the moment it renders.
 */
let configInterpreter = null;

/* The namer the sidebar last named device links through, and the options array it was built over. The edited configuration is composed afresh on every read, but its
 * options array keeps its identity until an edit or a rollback moves it, so a sidebar build names every link through one engine and an edit builds one more.
 */
let linkNamer = { name: null, options: null };

/* The text one device link shows: the name the plugin gives the device's accessory in HomeKit, with the custom name being edited applied where HomeKit can carry it,
 * read from the edited configuration. Before the interpreter lands, a link shows the name the UI server composed for the device. Nothing here writes a row: the kept
 * answers are the rows themselves, and a name written onto one would go on showing after its custom name was cleared.
 */
const deviceLinkName = (row) => {

  if(!configInterpreter) {

    return row.homeKitName ?? row.name ?? "";
  }

  const config = ui.featureOptions.editedConfig[0];

  if(linkNamer.options !== config?.options) {

    linkNamer = { name: configInterpreter.deviceNamer(config), options: config?.options };
  }

  return linkNamer.name(row);
};

// The class each device link's name node wears, which is how the repaint finds every one of them on the page.
const DEVICE_LINK_NAME_CLASS = "hbua-device-name";

/* Every device link's name node, mapped to the raw row it names. The framework rebuilds its links on its own schedule, so the repaint finds the nodes on the page
 * as it stands rather than holding them, and a node the framework drops leaves this map with it.
 */
const linkRows = new WeakMap();

// Compose one device link's content: the device's name, in a node of its own that the repaint can find again.
const deviceContent = (device) => {

  const node = document.createElement("span");

  node.className = DEVICE_LINK_NAME_CLASS;
  node.textContent = deviceLinkName(device);
  linkRows.set(node, device);

  return node;
};

/* Repaint every device link's name, once an edit or a refused write moved the configured options. A custom name is applied in the browser, so a rename needs this
 * rather than a round trip. It runs synchronously inside the framework's hook, which reads the edited configuration as the change left it, and it changes no option
 * and re-reads nothing, so it is as safe inside a drain as outside one. Each node is named from the raw row it rendered from, so a cleared custom name shows that
 * row's own name again.
 */
const repaintDeviceLinks = () => {

  for(const node of document.querySelectorAll("#devicesContainer ." + DEVICE_LINK_NAME_CLASS)) {

    const row = linkRows.get(node);

    if(row) {

      node.textContent = deviceLinkName(row);
    }
  }
};

// Only show feature options that are valid for the capabilities of this device. Every read of the metadata channel is guarded at each step: the channel itself and
// both of its members are optional, so an entry that declares no scope at all reaches these tests as a chain of absent values rather than a throw.
const validOption = (device, option) => {

  // Every option shows at the global and controller level, because an entry set at either applies to every device beneath it that sets none of its own; only a
  // device's own view is filtered to what that device can use.
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
 * @param options.onRemove       - Invoked with the scoping identities to strip once a removal is confirmed, when the caller offers removal.
 * @param options.onSave         - Invoked by the Save control, when the caller offers one. A card offering a Save carries the save flow its presses run through.
 * @param options.removalAddress - A read of the configured address the card stands for, which a removal acts on and its confirmation names, when the caller offers
 *                                 removal.
 * @param options.signal         - The caller's own lifecycle, when it has one. The card's teardown composes with it.
 *
 * @returns The card's surface: close, its save flow or null, populate, values, and the verdict line.
 */
const mountConnectionCard = ({ container, heading, helper, noSweepReason = "", onCancel, onRemove, onSave, removalAddress, signal }) => {

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

  /* This card's latest-action-wins guard over its validations, including the one every Save runs before it writes, so only the newest action ON THIS CARD
   * stands. It belongs to the card rather than to the module so two mounted cards cannot retire each other's actions, and an edit retires the action in flight, so
   * a slow answer never lands beside input it no longer describes, and a Save waiting on it writes nothing.
   *
   * It takes no parent, because only this card's own acts retire an action: an edit, a Validate press, or another Save. Closing the card or re-populating it is
   * moving on rather than retiring, so neither cancels a pressed Save, which goes on to write if its check passes; where each answer lands is the presentation rule
   * start() states below. The UI-server bridge carries no abort surface, so a retired check still runs to its answer and is dropped there rather than cancelled
   * on the wire.
   */
  const guard = createActionGuard();

  // The population the card is presenting, which every populate moves on. An action captures it when it starts, which is how the card tells an answer about what it
  // shows now from an answer about what it showed when the action began.
  let population = 0;

  // The scoping identities (decorated serials) a removal would offer to strip settings for, as the caller's last population named them.
  let removalMacs = [];

  const verdict = {

    render: (options = {}) => renderVerdict({ ...options, row }),

    // Retire any action still in flight and blank the line. An edit calls for this, because the verdict standing there describes input the card no longer holds.
    retire: () => {

      guard.cancel();
      renderVerdict({ row });
    },

    /* Blank the line and begin an action, answering its handle: the signal that aborts the moment a later start or a retirement overtakes the action, the one rule
     * for where the action's answers land, and the report that lands an outcome on the line only while that rule holds. The card presents an action while the card
     * is open, the action has not been retired, the card still shows the population it showed when the action began, and the line is on screen. A validation's
     * outcome that the card no longer presents is dropped, because nothing it found changed anything. A Save delivers through its save flow instead, which reads
     * this same rule and raises the host's toast where the paint would drop, because the Save writes whether or not anyone is still looking at its card.
     *
     * Whether the line is on screen is read at delivery rather than tracked, because the ways a card leaves the screen without closing are many and one of them
     * runs no code of ours: a device selection hides the docked editor, a takeover hides the region it docks in, a disclosure collapses over it, and the
     * connection-error view's panel is detached when the page leaves that view without calling back into this plugin. checkVisibility() answers false for every
     * one of them - a detached element, a display: none ancestor, and hidden content alike.
     */
    start: () => {

      renderVerdict({ row });

      const signal = guard.start();
      const startedUnder = population;
      const presented = () => !cardSignal.aborted && !signal.aborted && (population === startedUnder) && row.checkVisibility();

      return {

        presented,
        report: (options = {}) => {

          if(presented()) {

            renderVerdict({ ...options, row });
          }
        },
        signal
      };
    }
  };

  /* This card's save flow, built once beside its guard when the caller offers a Save. The flow's one piece of state across presses is whether a write is in flight,
   * so a flow belongs to the card it serves: a press during this card's write starts nothing and the card's Save control is not pressable for that span, while
   * another card's write refuses nothing here. It begins each press through the card's own starter, so a Save retires and is retired by the card's other actions
   * exactly as they retire each other, and it delivers each outcome under the presentation rule that starter answers.
   */
  const flow = onSave ? createSaveFlow({ commit: commitConfig, control: control("save"), start: verdict.start, toast: homebridge.toast }) : null;

  // Put the removal confirmation away. Every path that changes what the card is describing takes it back to its unarmed state, so a confirmation can never outlive
  // the controller it was naming.
  const disarmRemoval = () => removeConfirm.classList.add("d-none");

  /* Arm the removal confirmation, naming the controller in words rather than in a browser dialog. The name is the configured address the removal acts on, read as
   * the confirmation arms, rather than whatever the address field holds, so an unsaved edit of the field cannot make the prompt name one controller while the
   * removal drops another. The sweep is offered as the follow-on choice it is: the settings a user configured for a controller's devices are worth keeping when
   * that controller is coming back under a new address, and worth deleting when it is gone for good, and only the user knows which. Without a device list there
   * is nothing to offer, so the card says why instead of pretending the choice exists.
   */
  const armRemoval = () => {

    const sweepable = removalMacs.length > 0;

    card.querySelector("[data-role='removePrompt']").textContent = "Remove " + removalAddress() + " from this plugin? " + (sweepable ?
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

    // The save flow this card's Save presses run through, or null for a card that offers no Save.
    flow,

    /* Fill the card in from a configured controller, and name what a removal would strip alongside it. Populating is also what disarms a standing removal
     * confirmation and blanks the verdict line: both describe whatever the card was showing a moment ago, and the card is now describing something else. It moves
     * the card to a new population and retires nothing, so an action still in flight goes on and the presentation rule in start() decides where its answers land.
     */
    populate: ({ address, macs = [], password, tokens, username, verifyTls }) => {

      fields.address.value = address;
      fields.password.value = password;
      fields.token.value = tokens?.access ?? "";
      fields.username.value = username;
      fields.verifyTls.checked = verifyTls;
      removalMacs = macs;
      population++;

      disarmRemoval();
      renderVerdict({ row });
    },

    /* What the user has entered, in the shape a controllers[] item itself carries, so every validation, every probe body, and every write reads one vocabulary all
     * the way from the card to the plugin's own identity composition.
     *
     * A blank token field still composes a tokens object here, because this reads the card rather than deciding anything about it. What an empty field means is the
     * write path's rule to state, and it states it once.
     *
     * The address is read trimmed, because the plugin reads a listed controller's address trimmed: the probe, the listed-elsewhere check, the write, its rename
     * and the card's follow of what it saved all read the address the plugin connects to, and the first-run card and the edit card read it through this one method.
     */
    values: () => ({ address: fields.address.value.trim(), password: fields.password.value, tokens: { access: fields.token.value }, username: fields.username.value,
      verifyTls: fields.verifyTls.checked }),
    verdict
  };

  // Each masked secret's reveal, bound from the markup itself: a toggle declares the field it serves, so the card grows a reveal without this wiring changing.
  for(const toggle of card.querySelectorAll("[data-reveal]")) {

    toggle.addEventListener("click", () => toggleReveal({ input: fields[toggle.dataset.reveal], toggle }), { signal: cardSignal });
  }

  // An edit to any field retires the verdict standing beside it, so the line never describes anything but the current input. A checkbox announces its own edits on
  // "change" rather than "input", so each field is bound on the event its kind actually fires.
  for(const field of Object.values(fields)) {

    field.addEventListener(isCheckbox(field) ? "change" : "input", () => verdict.retire(), { signal: cardSignal });
  }

  control("validate").addEventListener("click", () => void onValidateLogin({ button: control("validate"), card: surface }), { signal: cardSignal });

  if(onCancel) {

    control("cancel").classList.remove("d-none");
    control("cancel").addEventListener("click", onCancel, { signal: cardSignal });
  }

  if(onSave) {

    control("save").classList.remove("d-none");
    control("save").addEventListener("click", () => void onSave(), { signal: cardSignal });
  }

  if(onRemove) {

    control("remove").classList.remove("d-none");
    control("remove").addEventListener("click", armRemoval, { signal: cardSignal });
    control("removeCancel").addEventListener("click", disarmRemoval, { signal: cardSignal });

    control("removeConfirmed").addEventListener("click", () => {

      disarmRemoval();
      void onRemove({ macs: [] });
    }, { signal: cardSignal });

    control("removeSwept").addEventListener("click", () => {

      disarmRemoval();
      void onRemove({ macs: removalMacs });
    }, { signal: cardSignal });
  }

  container.replaceChildren(card);

  return surface;
};

/* Mount a card that edits a controller already in the configuration, in whichever home the caller names.
 *
 * Each home differs in where it sits and in what a removal can offer, and in nothing else. The docked editor sits in a reachable controller's own stats panel
 * and can strip the settings of every device that controller answered with; the editor the connection-error view hosts reaches a controller the page has no device
 * list for, where removal is offered on its own. Both correlate to a configuration item by address, both validate before they write, and both follow the address
 * they wrote so a second save edits the same item rather than looking for the address the first one replaced.
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

      const edited = configAddress;
      const saved = await saveController({ card, originalAddress: edited });

      /* The card now stands for the address it just wrote. Following it is what keeps an address change an edit: without this, a second save would look for the
       * address the user replaced and find nothing, so it would be refused as already listed, or, where it changed the address again, append a second entry for
       * the same controller. A save outlives a re-population, so the card follows only while it still stands for the item this save edited...once it has been
       * pointed at another controller, following would aim that controller's next save or removal at the item this one wrote.
       */
      if((saved !== null) && (configAddress === edited)) {

        configAddress = saved;
      }
    },
    removalAddress: () => configAddress,
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
        macs: sweepable ? (answers.get(address)?.devices.map((device) => device.serialNumber).filter((id) => typeof id === "string") ?? []) : [],
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
 * remembered serial lives on the mount pair rather than bare module state, so a fresh mount starts with no remembered serial and a stale one can never leak a stray
 * re-view across a remount; the hello re-elicitation reads it from the CURRENT mount pair.
 */
let detailsPanel = null;

/* The plugin's content hook beneath the live status panel: the docked connection editor and the token-only notice. The identity rows and the live rows above are
 * the panel's own; what docks here is the content whose lifetime is the mount's rather than the selection's.
 *
 * The hook runs on every selection render, the mount-time no-device render included - the signal-keyed once-ness the dock's mount uses tolerates that call by
 * construction.
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

  // Whether the selection is the controller's own row AND that controller answered this session with an API token alone, which decides whether the notice below
  // shows. The connection editor is offered on every controller row either way.
  const tokenOnlyController = Boolean(device) && isController(device) && (answers.get(device.hbuaConfigAddress)?.kind === "token-only");

  /* The docked editor sits on the controller's own node and nowhere else. Every controller answers with a row of its own whichever way it was reached, so that row
   * is the one place its connection is edited and a device render leaves the editor out of sight - a device is not a thing whose connection can be edited. It is
   * created once per mount and only toggled here, which is what keeps its wiring alive across the selection changes that repaint the panel beside it.
   *
   * The address the editor edits is the one the sidebar reached this controller at, stamped onto every record when the list was processed.
   */
  editor.render((device && isController(device)) ? (device.hbuaConfigAddress ?? null) : null);

  /* The notice region is re-rendered on every invocation - the token-only arm writes it, every other arm clears it - because the region persists for the mount's
   * life, and an un-toggled notice would linger after switching to a credentialed selection. The notice says what adding credentials would add, and sits above the
   * connection editor because that is where the user adds them: what this connection reaches, what it does not, and the fields that close the gap.
   */
  if(!tokenOnlyController) {

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

  // Repaint the device names an options edit moved, the moment the framework announces it, so a custom name shows in the sidebar as soon as it is entered and before
  // it is saved.
  onOptionsEdited: () => repaintDeviceLinks(),

  // Repaint the device names a refused write rolled back. The host refusing a write restores the configuration it last accepted without announcing an edit, so a
  // custom name that never landed would otherwise stay on screen.
  onOptionsRolledBack: () => repaintDeviceLinks(),

  sidebar: {

    controllerLabel: "Access Controllers",

    // Each device link shows the device's name as the plugin names its accessory, the custom name being edited applied.
    deviceContent: deviceContent,

    /* Where each group of the device list sits: the hubs first, then the readers that hang off them. The framework hands this comparator only the names that render
     * as sections, so neither a controller's own group nor the reserved hidden group ever reaches it, and a group the order above does not name sorts after every
     * named one by locale.
     */
    groupOrder: (a, b) => (sidebarGroupRank(a) - sidebarGroupRank(b)) || a.localeCompare(b),

    /* The refresh action the framework docks on the controller-list heading. Reloading the world is one generation bump and one cleared map: the handler is
     * invalidation and nothing more, because the framework owns everything around it - the re-entry through its own show(), the boot affordance that clothes the
     * refetch, and the control's in-flight state. The selection landing back on the first controller is what reloading costs, the same landing every framework
     * re-entry makes.
     */
    refresh: {

      label: "Refresh controllers",
      onRefresh: () => {

        answers.clear();
      }
    }
  },

  /* The live status panel configuration. The panel component, the wire vocabulary, and the view cadence are the framework's; what is supplied here is exactly the
   * Access projection - the identity cells (the panel's own status label owns liveness), the placeholder skeleton, the error copy whose Access wording differs from
   * the component's credential-neutral defaults, the helper-restart re-elicitation, and the docked content hook.
   */
  statusPanel: {

    contentPanel: showAccessDetails,
    errorMessages: {

      "auth-invalid": { label: "Sign-in failed", message: "The controller rejected this sign-in. Check the username and password, or the API token, in the card " +
        "below." },
      "auth-missing": { label: "Sign-in required", message: "Live status needs a way to sign in to this controller. Add a local user's username and password, or " +
        "an API token, in the card below." },
      "faulted": { label: "Controller error", message: "The controller answered with an error, or with a response that could not be understood. Check that " +
        "the controller and the Access application are running normally, and that the plugin is up to date." },
      "misconfigured": { label: "Certificate rejected", message: "This controller presented a TLS certificate that could not be verified. Turn off " +
        "certificate verification for this controller in the card below, or install a trusted certificate on the console and on the Access developer API." },
      "not-found": { message: "This device was not listed by a configured controller in this session. Refresh the controller list to relist it." },
      "unsupported": { label: "No developer API", message: "This controller has no developer API for an API token to reach. Add a local user's username and " +
        "password in the card below." }
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

    /* The choice sources our catalog names, each answering the list its picker offers for the device in view. The lists are attached to the device records the server
     * answers, because deriving them needs what only the server reaches - the topology's door guards and the official users census, the access-method catalog, and the
     * hub sensor and logging tables - so a resolver here reads what its record carries and nothing more. Each runs on every projection recompute and must stay pure
     * and cheap.
     */
    choices: {

      // The methods the reader in view supports; at the global and controller views, where no device is in view, every method the catalog knows.
      accessMethods: ({ device, option }) => device?.accessMethods ?? option.meta?.choiceDomain ?? [],
      // The door guards the door in view lists. The option is offered at device scope alone, so a resolver with no device in view answers a list nothing renders.
      doorGuards: ({ device }) => device?.doorGuards ?? [],
      // The contact sensors the hub in view drives; with no device in view, every sensor the table knows.
      hubSensors: ({ device, option }) => device?.hubSensors ?? option.meta?.choiceDomain ?? [],
      // The event categories the hub in view produces, offered on the same terms its sensors are.
      logEvents: ({ device, option }) => device?.logEvents ?? option.meta?.choiceDomain ?? []
    },
    // The copy the framework's boot affordance shows while a controller connection is in flight, in place of its generic default.
    connectingMessage: "Connecting to your UniFi Access controller...",
    // The guidance line for a controller the page has no device list for, pointing at the connection editor mounted beneath the error rather than at a tab the
    // reader is already on.
    controllerFailureGuidance: "You can correct this controller's connection details below, or retry.",
    // The delay before the connection-error view re-enables its retry button, overriding the library's five-second default. A UniFi Access controller can take well
    // over five seconds to authenticate and answer with its topology, so this longer delay keeps an impatient user from hammering retry while the first connection
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
 * with one call that holds for the life of the page. Theming is a page concern rather than a view one, so the first-run page, the feature-options view, and the
 * support tab all wear it from here. The promise is voided rather than awaited because the framework owns its rejection posture: a failed initial lighting-mode read
 * still leaves the sheets adopted and the host's theme signals followed, so the next announcement the host makes brings the page into step.
 */
void ui.registerTheming();

/* The verdict a validation that connected paints, by what the connection reached. A token-only connection is valid, and saying only that would leave the user
 * wondering what the credential fields beside the token are still for. A connection whose token the controller refused is valid as well, because the credentials
 * carry it, but saying only that would leave the user believing the token is in use, so the line warns and names what only an accepted token reaches.
 */
const successVerdict = (probe) => {

  if(probe.kind === "token-only") {

    return { lines: [ "Your UniFi Access API token is valid.", "Add a local user's username and password to let the plugin read this controller's own document " +
      "as well; its doors and devices appear in HomeKit either way." ], tone: "text-success" };
  }

  if(probe.tokenRefused) {

    return { lines: [ "Your UniFi Access controller sign-in is valid, but the controller did not accept the API token.", "The plugin will use the local user's " +
      "username and password alone. Webhooks and the doorbell trigger need an API token the controller accepts." ], tone: "text-warning" };
  }

  return { lines: ["Your UniFi Access controller sign-in is valid."], tone: "text-success" };
};

/* Validate a card's controller connection on demand. It is early feedback and nothing else: every path that commits anything - the first-run submit, a card's own
 * Save - validates through requestControllerProbe first, the same check this control runs, so a user who never presses the control is no worse off, and one who
 * does learns whether their sign-in works before committing a configuration.
 */
const onValidateLogin = async ({ button, card }) => {

  button.disabled = true;

  try {

    const action = card.verdict.start();
    const probe = await requestControllerProbe({ ...card.values(), signal: action.signal });

    // Every outcome is said through the same action the check ran under, so an answer about a controller the card has moved on from, or about a card that has left
    // the screen, is dropped rather than painted where nobody asked for it.
    switch(probe.kind) {

      case "passed": {

        action.report(successVerdict(probe.answer));

        break;
      }

      case "failed": {

        action.report({ ...probe.outcome, tone: "text-danger" });

        break;
      }

      // A retired check belongs to an action a newer act on the card already replaced, so it says nothing at all.
      default: {

        break;
      }
    }
  } finally {

    // The re-enable is unconditional: the invocation that disabled the control is the only thing that can balance its own disable.
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

/* The takeover handle the open Add Controller card holds the page's content area with, or null when the affordance is closed.
 *
 * The card stands in the content area through the framework's takeover, so the framework hides and restores its own regions around the card and ends the takeover
 * itself when the user moves the selection or the page cycle ends. Whatever ends it, the handle's abort is the one place this reference is cleared and the card torn
 * down, so no exit path can leave the reference naming a card that is gone.
 */
let addCardTakeover = null;

// Put the Add Controller card away by giving the page's content area back, discarding whatever was typed into it. Closing an already-closed affordance is nothing at
// all, which is what lets every exit path call it without first asking whether it is open.
const closeControllerEditor = () => {

  if(!addCardTakeover) {

    return;
  }

  addCardTakeover.release();
};

/* Open a blank card as the whole of the feature-options view's main content.
 *
 * The card is handed to the framework's takeover inside an element of its own, carrying the compact-card class the page's style block keys on, and the framework
 * hides its own regions while the card holds the area and restores them when the takeover ends. The handle's signal is the card's lifetime, so the card's listeners
 * leave with the takeover however it ends.
 */
const openControllerEditor = () => {

  // A second click while the affordance is already open would otherwise mount a second card over the first and leak the first one's wiring.
  closeControllerEditor();

  const region = document.createElement("div");

  region.className = "hbua-compact-card";

  const takeover = ui.featureOptions.takeover(region);

  const card = mountConnectionCard({

    container: region,
    heading: "Add a UniFi Access controller",
    helper: "Enter the controller's address and either a local user's login or an Access console API token. The sign-in is validated against the controller before " +
      "anything is saved.",
    onCancel: () => closeControllerEditor(),
    onSave: async () => {

      const saved = await saveController({ card, originalAddress: undefined });

      /* A save that wrote something gives the area back itself, whatever the write did to the page: a write may re-show the page or re-establish it in place, and
       * the release is safe either way, including on a takeover the rebuild already ended. It releases this card's own handle rather than going through the close
       * above, because the save resolves after an await and by then the area may belong to a later open.
       */
      if(saved !== null) {

        takeover.release();
      }
    },
    signal: takeover.signal
  });

  addCardTakeover = takeover;

  // Every end of the takeover arrives here as one abort - this plugin's own release, a sidebar selection, a later takeover, or the page cycle ending - so the
  // reference is cleared and the card torn down along a single path whichever of them it was.
  takeover.signal.addEventListener("abort", () => {

    addCardTakeover = null;
    card.close();
  }, { once: true });
};

// Wire the plugin's own page controls. The controls are part of this page's markup and live as long as the page does, so their listeners carry no signal.
document.getElementById("hbuaAddController").addEventListener("click", () => openControllerEditor());

// The load-time wiring's own lifecycle. Aborting it is how an envelope that failed or expired tells a continuation still running underneath it that it must not stage
// anything after the fact, and its signal is the one every cancellation point below reads.
const wiringController = new AbortController();
const wiringSignal = wiringController.signal;

/* Run the legacy-settings migration, once, at load.
 *
 * The envelope is awaited here rather than at module top, so the page's chrome arms immediately instead of waiting on a bridge round trip. ui.show() runs only after
 * the envelope settles, which is the ordering that matters: the framework opens its own configuration session inside the launch path ui.show() starts, so every
 * replica it hands to a hook - the first-run config, the feature-options page's persist path - is read after the migration has settled, and none of them can commit
 * a pre-migration snapshot over it.
 *
 * A migration that composes a patch persists it itself, without waiting for the user to press Save. Most people never open this panel to save anything, so a
 * migration that waited for one would leave a fleet split between two configuration shapes indefinitely, and the plumbing that reconciles them could never retire.
 * The session's commit answers a null patch as unchanged without writing anything, and the save is gated on the commit having written, which is what bounds the
 * cost: only a pass that actually found legacy settings writes at all, so a converged configuration's every later open finds nothing to do and reaches neither the
 * controllers nor the disk.
 *
 * Reopening the panel is convergent. Each open imports a fresh copy of this module whose wiring runs independently, and a copy reading an already-migrated
 * configuration composes nothing and writes nothing. Two genuinely simultaneous wirings are where the honest bound sits: they read the same configuration but may
 * resolve different sets of reachable controllers, so their patches need not be identical and the later commit is the one that stands. Nothing is lost to that -
 * whatever the earlier pass migrated is still sitting in the configuration the later one read, and the next open migrates it again.
 *
 * One further bound, stated plainly: the check before the commit is the last cancellation point. A commit whose bridge round trip is already in flight cannot be
 * recalled, because the session takes no signal and the deadline bounds only the await, so the check narrows the window in which an expired envelope still writes to
 * that in-flight instant rather than closing it.
 *
 * When the envelope fails, nothing has been written and the page loads exactly as it otherwise would. No read this webUI performs consults the consolidated
 * settings - first run reads the identity, which stays in the configuration file - so a session whose fetches are failing still routes, still runs first run, and
 * simply leaves the migration to a session whose fetches succeed.
 */
const wireAccessConfig = async () => {

  const interpreter = await accessConfig();

  // Retain the interpreter for the sidebar's device links, which name themselves through it from here on, whatever becomes of the rest of this envelope.
  configInterpreter = interpreter;

  const { controllersAwaitingMigration, migrate } = interpreter;

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
    const scopingId = controllerSerial(classifyProbeResponse(response));

    if(scopingId) {

      macByAddress.set(address, scopingId);
    }
  }));

  const patch = migrate(session.platform, macByAddress);

  // The signal is read immediately before the write, so an envelope that expired while the probes were still running cannot stage a patch after the fact.
  if(wiringSignal.aborted) {

    return;
  }

  const result = await session.commit(patch);

  /* The save follows only a commit that wrote, which a null patch never does. The signal is read a second time, because the commit itself was an await and the
   * envelope may have expired across it. A save the deadline overtakes is skipped rather than forced, which leaves the migration staged for the user's own save -
   * the weaker outcome, and the honest one.
   */
  if((result.kind === "written") && !wiringSignal.aborted) {

    await session.persist();
  }
};

try {

  await withDeadline({ promise: wireAccessConfig(), seconds: WIRING_DEADLINE });
} catch(error) {

  wiringController.abort(error);
}

// Display the webUI.
ui.show();
