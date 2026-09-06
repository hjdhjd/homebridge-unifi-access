/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.ts: Access controller device class for UniFi Access.
 */
import { ACCESS_DEVICE_REMOVAL_DELAY_MESSAGE, ACCESS_WEBHOOK_EVENT_LIST, ACCESS_WEBHOOK_FRESHNESS_WINDOW_MS } from "../settings.ts";
import type { AccessAccessory, AccessAccessoryContext } from "../types.ts";
import type { AccessAccessoryOwnership, AccessControllerPhase, AccessLoginOutcome, ControllerOwnershipKeys, DecoratedSerial,
  MembershipClaims } from "../policy.ts";
import { AccessAuthorizationError, AccessClient, AccessOfficialApiError, isAccessWebhookDelivery, selectDoorStates, verifyWebhookSignature } from "unifi-access";
import type { AccessControllerConfig, AccessLogging, AccessOfficialWebhookEndpoint, AccessState, AccessStateDevice, ConnectIdentity, ConnectOptions,
  OfficialApi } from "unifi-access";
import type { HomebridgePluginLogging, HttpListenerRequest, MqttClient, MqttPublishInit, Nullable } from "homebridge-plugin-utils";
import { TimerRegistry, createMqttClient, debugGatedLog, formatErrorMessage, guardedDispatch, isHbpuAbortError, loopFaultReporter, mqttConnectionSettings,
  onAbort, prefixedLog, retry, sanitizeName, superviseLoop } from "homebridge-plugin-utils";
import { accessoryOwnership, canTransition, composeConnectIdentity, createConnectRetryPolicy, createMembershipIdsSelector, deviceModel, deviceRecord,
  deviceSerial, isManagedRecord, isSupportedAccessDevice, membershipDelta, orphanedWebhookRegistrations, projectedRecords, recordByMac, serialForm,
  webhookDeliveryFresh, webhookEndpointPath, webhookEndpointUrl, webhookRegistrationPlan, webhookRegistrations, webhookSignatureHeader } from "../policy.ts";
import type { AccessControllerOptions } from "../options.ts";
import { AccessDeliveryLedger } from "../webhooks.ts";
import type { AccessDevice } from "../devices/device.ts";
import { AccessEvents } from "./events.ts";
import { AccessHub } from "../devices/hub.ts";
import type { AccessPlatform } from "../platform.ts";

/**
 * The connect port: how a controller reaches its Access controller.
 *
 * This is the class's one external boundary, and it is named here rather than reached for inline so that standing a controller up does not require a network. A
 * controller transitively owns the whole accessory graph, its observe loops, and its webhook lifecycle, and none of that can be exercised at all if the one call
 * that establishes a client cannot be answered.
 *
 * The port only decides WHAT connect is called. Everything around it - the startup-resilient retry, the auth budget, the shutdown checks - is the controller's own
 * and is unaffected by which implementation answers.
 */
export type AccessControllerConnect = (options: ConnectOptions) => Promise<AccessClient>;

// The default port: the real client. Wrapped rather than referenced so the static's own this binding stays with its class.
const defaultConnect: AccessControllerConnect = (options) => AccessClient.connect(options);

export class AccessController {

  // The unifi-access client - the single owner of protocol truth: the reduced state, the realtime channel, recovery, and door state. Established by #connect() and
  // torn down through its asynchronous disposal. Definite-assignment typed for the connected lifetime; it is genuinely unset only in the narrow window before the
  // first connect resolves, and #liveClient() is the one place that window is read.
  public client!: AccessClient;
  public readonly config: AccessControllerOptions;
  public readonly configuredDevices: Map<string, AccessDevice>;
  public events!: AccessEvents;
  public readonly log: HomebridgePluginLogging;
  public mqtt: Nullable<MqttClient>;
  public readonly platform: AccessPlatform;
  // The unifi-access client logger. It shares this controller's log destination but gates error output through logApiErrors, so teardown noise stays quiet.
  readonly #clientLog: AccessLogging;
  // How this controller reaches its Access controller. The real client answers it in every configuration the plugin builds.
  readonly #connectClient: AccessControllerConnect;
  // The composed connect identity, written once by the constructor's gate on its success path and the only identity source #connect reads - the raw configuration is
  // never consulted again. Definite-assignment typed because the gate's inert early return leaves it unwritten, a state the platform's own identity gate means never
  // arises in practice.
  readonly #identity!: ConnectIdentity;
  // This controller's own membership selector instance. The memo is one slot per instance, so a shared selector would be thrashed by two controllers' interleaved
  // stores and neither would keep its reference stability.
  readonly #membershipSelector: (state: AccessState) => readonly string[];
  #name: string;
  // Lifecycle phase, mutated only through transition().
  #phase: AccessControllerPhase;
  /* The delayed removals of devices that have left this controller's membership, keyed by accessory UUID. It arms on the platform's clock and drains on this
   * controller's terminal signal, so no deferred removal can survive the controller it belonged to.
   */
  readonly #removals: TimerRegistry;
  // The terminal plugin-shutdown abort, fired exactly once in transition("shuttingDown"). Every loop and every per-device controller composes against it, so shutdown
  // tears the whole tree down as one cascade.
  readonly #shutdownController: AbortController;
  #unsupportedDevices: Record<string, boolean>;
  /* This controller's webhook registration, or null when it holds none. The registration is active exactly when this is non-null, and it is set and cleared as one
   * value so the endpoint, the replay ledger, and the route it feeds can never disagree about whether webhooks are running.
   *
   * The warn-once latch lives inside the bundle rather than beside it, which is what gives a fresh registration a fresh latch by construction instead of by
   * someone remembering to reset one.
   */
  #webhook: Nullable<{ endpoint: AccessOfficialWebhookEndpoint; ledger: AccessDeliveryLedger; refusalWarned: boolean; route: Disposable }>;

  constructor(platform: AccessPlatform, accessOptions: AccessControllerOptions, connect: AccessControllerConnect = defaultConnect) {

    this.config = accessOptions;
    this.#connectClient = connect;
    this.configuredDevices = new Map();
    this.mqtt = null;
    this.#name = accessOptions.name ?? accessOptions.address;
    this.#membershipSelector = createMembershipIdsSelector();
    this.#phase = "connecting";
    this.platform = platform;
    this.#shutdownController = new AbortController();
    this.#unsupportedDevices = {};
    this.#webhook = null;

    // Built after the abort controller above, because the signal this registry drains on is that controller's and nothing else establishes it.
    this.#removals = new TimerRegistry({ clock: platform.clock, signal: this.signal });

    /* Derive our logger from the platform's, prefixing every line with this controller's name so its output is attributable at a glance, and gating debug at this
     * controller's own scope so a controller-suffixed Log.Debug entry turns on this controller and everything it manages.
     *
     * The gate wraps the prefix rather than the other way around, so a suppressed debug line costs one predicate call and no string composition. The predicate reads
     * this controller's identity on every call rather than capturing it here...a controller consulted before it has connected has no id yet and logs at global scope,
     * the only scope that can name it.
     */
    this.log = debugGatedLog(prefixedLog(this.platform.log, () => this.name), () => this.platform.featureOptions.test("Log.Debug", undefined, this.id));

    /* The unifi-access client logger. The library logs complete sentences with structured context attached as trailing parameters, and rendering that context inline
     * would put raw object dumps in front of the user - so each non-debug level emits the sentence alone at its level and echoes the full line, context included, to
     * debug, where the forensic detail belongs. Every level goes through our own logger, so a library line is attributable to the controller that produced it exactly as
     * the lines we write ourselves are, and the echo answers to the debug gate. Error output is additionally gated by logApiErrors so teardown noise stays quiet, while
     * the echo is left out of that gate so debug logging captures the full record even where the user-facing line is suppressed.
     */
    const routeClientContext = (write: (message: string) => void): ((message: string, ...parameters: unknown[]) => void) => {

      return (message: string, ...parameters: unknown[]): void => {

        write(message);

        if(parameters.length) {

          this.log.debug(message, ...parameters);
        }
      };
    };

    this.#clientLog = {

      debug: (message: string, ...parameters: unknown[]): void => this.log.debug(message, ...parameters),
      error: routeClientContext((message: string): void => {

        if(this.logApiErrors) {

          this.log.error(message);
        }
      }),
      info: routeClientContext((message: string): void => this.log.info(message)),
      warn: routeClientContext((message: string): void => this.log.warn(message))
    };

    // Compose the identity we will connect with. The platform gates the same configuration before we are constructed, so an inert controller here is a defense that
    // never fires in practice rather than an expected path.
    const identity = composeConnectIdentity(accessOptions);

    if(identity.error !== undefined) {

      this.log.error(identity.error);

      return;
    }

    this.#identity = identity.identity;

    /* Tear ourselves down when the plugin's lifetime ends. The platform owns the one shutdown registration and every controller composes from its signal, which is
     * the same composition the device base applies one layer down.
     */
    onAbort(this.platform.signal, () => {

      this.transition("shuttingDown");
      void this.#disconnect();
    });
  }

  /**
   * Initialize our connection to the UniFi Access controller. The one-time entry point called at startup: it establishes the connection, creates the event bridge
   * and MQTT, performs the initial device population, and spawns the observe loop that keeps us in sync with the controller.
   *
   * The outcome is what this controller can be held to for the rest of the session, and the platform's own cross-controller decisions read it. Each exit reports
   * what it settled about our identity rather than whether it did any work: an exit taken before we ever connected leaves the identity unknown, while the disabled
   * exit connected first and therefore knows exactly who it is even though it will serve nothing.
   *
   * @returns What this login settled about this controller's identity.
   */
  public async login(): Promise<AccessLoginOutcome> {

    // The plugin has been disabled globally. The controller's identity is unknown until we connect, so this pre-connect gate consults global feature-option scope
    // directly rather than hasFeature, which would read a MAC address we do not yet have.
    if(!this.platform.featureOptions.test("Device")) {

      this.log.info("Disabling this UniFi Access controller.");

      return "unavailable";
    }

    if(!(await this.#connect())) {

      return "unavailable";
    }

    // Now that we know the controller configuration, check to see whether the user has disabled it.
    if(!this.hasFeature("Device")) {

      this.log.info("Disabling this UniFi Access controller in HomeKit.");

      /* Unregister the accessories for this controller that Homebridge may have restored already. Any that arrive later are caught as they are restored. The
       * claims membership makes are read once for the whole pass, and each admitted accessory retires directly: the filter has already answered the ownership
       * question, and the public path's gate would only ask it a second time.
       */
      const claims = this.#membershipClaims(this.client.state.snapshot());

      for(const accessory of this.platform.accessories.filter(x => this.#isOurs(x, claims))) {

        this.#retire(accessory);
      }

      /* Turning a controller off in HomeKit must also stop it delivering webhooks, since nothing here will be listening for them. The retirement runs while the
       * client is still alive, because deleting a registration is an official call like any other.
       */
      const official = this.client.official;

      if(official) {

        await this.#retireWebhook(official);
      }

      await this.client[Symbol.asyncDispose]();

      return "disabled";
    }

    // Initialize our UniFi Access events bridge.
    this.events = new AccessEvents(this);

    /* Initialize MQTT, if configured. The library resolves both settings in one place, and the rule it applies is that a configured option answers in every state
     * it can be in: an option the user turned off, or enabled without giving it a value, is the user saying MQTT is off for this controller. The controller's own
     * configuration properties answer only where no option speaks. A null answer means there is nothing to connect to, so no client is constructed at all. The
     * client binds to our terminal shutdown signal, so its connection ends on plugin shutdown rather than leaking past it.
     *
     * A token-only controller resolves no MAC address for the life of the process, since the controller document a MAC comes from is credential surface the
     * published API does not serve. Per-controller option entries cannot address such a controller at all, so its broker and topic are carried by the
     * configuration properties and the canonical topic prefix alone.
     */
    const mqttSettings = mqttConnectionSettings({ config: this.config, controller: this.id, featureOptions: this.platform.featureOptions });

    this.mqtt ??= mqttSettings && createMqttClient({ ...mqttSettings, log: this.log }, { signal: this.signal });

    // Inform the user about the devices we see. This fires once here, so a device that arrives mid-run gets no retroactive line...the adding-to-HomeKit line covers
    // it instead.
    const state = this.client.state.snapshot();

    for(const id of this.#membershipSelector(state)) {

      const device = deviceRecord(id, state);

      if(device) {

        this.log.info("Discovered %s: %s.", this.resolveDeviceModel(device), this.getDeviceName(device, this.resolveDeviceName(device), true));
      }
    }

    // Perform the initial device population and spawn the observe loop that keeps membership in sync.
    this.#startMembershipObserver();

    // Spawn the observe loop that keeps every hub's door state current.
    this.#startDoorStateObserver();

    // Spawn the observe loop that pushes controller-level reachability to every device and heals what an outage staled.
    this.#startConnectionObserver();

    /* Bring our webhook registration into line, after the observers and off the startup path. The membership seed above constructs every hub synchronously, so by
     * the time any delivery can be routed each hub present at startup is already listening for it; startup itself never waits on an official round trip; and a
     * fault is logged by the primitive rather than escaping a login the platform calls unawaited.
     */
    guardedDispatch({ handler: async (): Promise<void> => this.#configureWebhooks(), label: "webhook configuration", log: this.log });

    return "reporting";
  }

  /* Establish a connection to the Access controller. AccessClient.connect() is atomic - it authenticates, fetches what the identity can reach, seeds the state
   * model, and brings the realtime channel up as one ready-or-throws operation, owning recovery and the periodic refresh failsafe internally. We wrap it in a
   * startup-resilient retry: authentication faults get a small consecutive budget so a controller still sorting out its own auth recovers, while genuinely-wrong
   * credentials fail fast rather than looping forever, and any non-auth fault resets the budget and retries unbounded until the controller appears or we shut down.
   *
   * The backoff between attempts waits on the platform's clock rather than on the platform's timers, so a suite walks the whole ladder on virtual time instead of
   * serving it out in real seconds.
   */
  async #connect(): Promise<boolean> {

    const { shouldRetry } = createConnectRetryPolicy();

    try {

      this.client = await retry((signal) => this.#connectClient({ host: this.config.address, log: this.#clientLog, signal,
        verifyTls: this.config.verifyTls === true, ...this.#identity }), { attempts: Infinity, clock: this.platform.clock, shouldRetry, signal: this.signal });
    } catch(error) {

      // The shutdown signal aborting the retry is an orderly teardown, not a failure to report. An exhausted auth budget surfaces here.
      if(this.#isShuttingDown()) {

        return false;
      }

      this.log.error("Unable to connect to the UniFi Access controller: %s.", formatErrorMessage(error));

      return false;
    }

    // A connect that resolves after shutdown must not resurrect this controller's lifecycle. The freshly-established client is otherwise orphaned, so dispose it and
    // bail before anything else reads it.
    if(this.#isShuttingDown()) {

      await this.client[Symbol.asyncDispose]();

      return false;
    }

    const controllerInfo = this.client.controllerInfo;
    // The host hardware's own type, under whichever spelling the controller document answers with. A client that reads no controller document answers none of them,
    // and the empty string is what the composition below tests to leave that controller's name undecorated.
    const controllerType = controllerInfo?.host.device_type ?? controllerInfo?.host.shortname ?? "";

    /* Assign our log-prefix name unless the user stated a preference, falling back to the address when the controller has not named itself, and qualify it with the
     * host hardware's type so a controller-scoped line names the hardware it came from at a glance. A controller reached with an API token alone never reads a
     * controller document, so it has no type to render and keeps its bare name rather than bracketing a label over an absent value.
     *
     * The composition runs on every connect, so a controller replaced under the same address carries the new hardware's type from its next session forward.
     */
    this.#name = (this.config.name ?? this.client.controllerName ?? this.config.address) + (controllerType.length ? " [" + controllerType + "]" : "");

    this.transition("running");

    // We successfully connected.
    this.log.info("Connected to %s (UniFi Access %s running on UniFi OS %s).", this.config.address, controllerInfo?.version, controllerInfo?.host.firmware_version);

    return true;
  }

  /* Tear this controller down. Called from the shutdown handler after the phase has already moved, so the abort cascade has fired and every loop is unwinding by the
   * time we get here. Neither the MQTT client nor the removal registry needs an explicit call: both were constructed against our terminal signal and end with it,
   * which is what makes the abort the one act that tears this controller down.
   */
  async #disconnect(): Promise<void> {

    // The event bridge is created post-connect, so a shutdown during the initial connect reaches here before it exists.
    const events = this.events as AccessEvents | undefined;

    events?.dispose();

    const client = this.#liveClient();

    /* Retire the registration before the client goes away, since deleting it is an official call and the client is what carries one. Only a controller that
     * actually holds a registration has anything to do here: a configure attempt that minted a record without ever routing it already undid its own.
     *
     * A hard kill skips all of this, which is by design rather than by omission - the record it leaves behind is what the next startup's reconcile reuses.
     */
    if(this.#webhook) {

      this.#webhook.route[Symbol.dispose]();

      const official = client?.official;

      if(official) {

        await this.#retireWebhook(official);
      }

      this.#webhook = null;
    }

    if(client) {

      await client[Symbol.asyncDispose]();
    }
  }

  /* Bring this controller's webhook registration into line with what it should be, and route the deliveries that follow.
   *
   * This runs once per login, off the startup path, and never rejects: every arm is inside one try, a synchronous throw from the route registration included, so a
   * controller whose webhooks cannot be arranged still runs everything else normally.
   */
  async #configureWebhooks(): Promise<void> {

    // The one record this attempt owes an undo, and the URL a permission failure needs to name. Both live at method scope so the catch below can reach them.
    let minted: Nullable<AccessOfficialWebhookEndpoint> = null;
    let official: Nullable<OfficialApi> = null;
    let url = "";

    try {

      // A non-null official surface IS official capability: the client's own getter folds the capability flag into it.
      official = this.client.official;

      /* Turning the option off also cleans the controller, rather than leaving it delivering to a port nothing is listening on. A token-only controller resolves
       * this option at global scope, since it never learns a MAC address for a per-controller entry to name it by.
       */
      if(!this.hasFeature("Controller.Webhooks")) {

        if(official) {

          await this.#retireWebhook(official);
        }

        return;
      }

      // Enabled, but this controller has no published API to register through, so there is nothing to arrange and one line says why.
      if(!official) {

        this.log.info("Webhooks require an API token with webhook permissions for this controller.");

        return;
      }

      const listener = this.platform.webhookListener();
      const path = webhookEndpointPath(this.config.address);
      let host: string;

      try {

        host = await this.platform.localAddressFor(this.config.address);
      } catch(error) {

        /* The plugin's own lifetime rejects a lookup that is still pending, so a teardown landing here is the orderly one the outer catch reports the same way
         * rather than a host this plugin could not reach. Everything else is a genuine failure to resolve, and the user is told which host it was about.
         */
        if(this.#isShuttingDown()) {

          this.log.debug("The webhook configuration ended with a shutdown in progress: %s.", formatErrorMessage(error));

          return;
        }

        this.log.error("Unable to determine the address the Access controller can reach this plugin on: %s.", formatErrorMessage(error));

        return;
      }

      url = webhookEndpointUrl({ host, path, port: this.platform.webhookPort });

      const desired = { endpoint: url, events: ACCESS_WEBHOOK_EVENT_LIST, name: "Homebridge UniFi Access (" + this.config.address + ")" };
      // One listing serves both the plan below and the orphan sweep at the end, so reconciling costs the controller exactly one read of its registrations.
      const existing = await official.webhooks.fetchAllEndpoints();
      const plan = webhookRegistrationPlan({ desired, existing, path });

      /* Registrations that piled up at our path across address changes without a clean shutdown in between are cleared now rather than left until the feature is
       * turned off. The deletions are sequential deliberately: they are writes against one controller, and a controller that refuses the first should not then be
       * handed the rest.
       */
      for(const record of plan.stale) {

        // eslint-disable-next-line no-await-in-loop
        await official.webhooks.deleteEndpoint(record.id);
      }

      let endpoint: AccessOfficialWebhookEndpoint;

      switch(plan.kind) {

        case "create":

          minted = await official.webhooks.createEndpoint(desired);
          endpoint = minted;

          break;

        case "update":

          endpoint = await official.webhooks.updateEndpoint(plan.endpoint.id, desired);

          break;

        case "reuse":

          endpoint = plan.endpoint;

          break;
      }

      /* A shutdown that arrived while we were talking to the controller must not leave a registration nothing will ever retire, which is the same check the
       * connect path makes for the same reason.
       */
      if(this.#isShuttingDown()) {

        await this.#undoMinted(official, minted);

        return;
      }

      /* One synchronous sequence with no task boundary inside it: the secret is in hand before the route exists, so there is no window in which a delivery can
       * reach a route that cannot verify it.
       *
       * The lambda is also the single place a verdict becomes a status, which is what lets the decision behind it stay a two-valued answer about the delivery
       * and keeps the HTTP vocabulary at the boundary that speaks HTTP. Deliveries are posted, so the route accepts that method alone and the listener answers
       * anything else without the handler ever seeing it.
       */
      this.#webhook = { endpoint, ledger: new AccessDeliveryLedger({ windowMs: ACCESS_WEBHOOK_FRESHNESS_WINDOW_MS }), refusalWarned: false,
        route: listener.route(path, (request) => ({ status: this.#receiveDelivery(request) ? 200 : 401 }), { methods: ["POST"] }) };

      // The listener's own line is the truth about the port, so this one is about the registration.
      this.log.info("Registered for Access webhook deliveries at %s.", url);

      /* Clear the registrations this plugin left on this controller at addresses none of our configured controllers answers for - what a re-addressed controller
       * leaves behind, since the reconcile above matches this controller's own path alone and never sees them.
       *
       * Best effort, and deliberately not the stale loop's semantics: this runs after the bundle is live, and each deletion stands alone inside its own try, so a
       * controller that refuses one costs the user that record and nothing more. The stale loop ends on its first refusal because those are ordering-sensitive
       * writes against the very path this attempt is about to own; these are writes against paths nothing here depends on.
       *
       * The listing was taken before this attempt created or updated anything, so it cannot hold the registration this attempt minted...and our own path is
       * excluded by the selection in any case.
       */
      for(const record of orphanedWebhookRegistrations({ configuredAddresses: this.platform.config.controllers.map((entry) => entry.address), existing, host,
        port: this.platform.webhookPort })) {

        try {

          // eslint-disable-next-line no-await-in-loop
          await official.webhooks.deleteEndpoint(record.id);

          this.log.info("Removed a webhook registration this plugin left at a controller address it is not configured for: %s.", record.name);
        } catch(error) {

          this.log.debug("Unable to remove the webhook registration %s: %s.", record.name, formatErrorMessage(error));
        }
      }
    } catch(error) {

      /* A rejection produced by teardown disposing the transport under an in-flight official call is an orderly shutdown rather than a fault. Nothing further is
       * attempted either - a record minted inside that window is the next startup's reconcile case.
       */
      if(this.#isShuttingDown()) {

        this.log.debug("The webhook configuration ended with a shutdown in progress: %s.", formatErrorMessage(error));

        return;
      }

      if((error instanceof AccessAuthorizationError) || (error instanceof AccessOfficialApiError)) {

        this.log.warn("The API token cannot manage webhook endpoints (%s). Grant it webhook permissions, or register %s with the ufa command line tool and the " +
          "plugin will use it.", error.message, url);
      } else if((error instanceof TypeError) || isHbpuAbortError(error)) {

        /* The listener refused, and its own message names the cause. A TypeError is the path already routed - two controllers configured with one address - or
         * the listener refusing an option it was constructed with, an out-of-range port among them, and it names the collision or the option. An abort error is
         * a listener whose lifetime ended on a bind failure it has already reported. A shutdown never arrives here, because the check above answers it first.
         */
        this.log.error("Unable to receive Access webhook deliveries. %s", error.message);
      } else {

        this.log.error("Unable to configure Access webhook deliveries: %s.", formatErrorMessage(error));
      }

      if(official) {

        await this.#undoMinted(official, minted);
      }
    }
  }

  /* Undo a registration this attempt minted but never took ownership of, best effort. A record created by an attempt that then failed to route it must not outlive
   * that attempt, or the controller would deliver to a path nothing answers on.
   */
  async #undoMinted(official: OfficialApi, minted: Nullable<AccessOfficialWebhookEndpoint>): Promise<void> {

    if(!minted || this.#webhook) {

      return;
    }

    try {

      await official.webhooks.deleteEndpoint(minted.id);
    } catch(error) {

      this.log.debug("Unable to remove the webhook registration this attempt created: %s.", formatErrorMessage(error));
    }
  }

  /* Remove every webhook registration this controller holds at its own path. Three callers share this one statement: the option being off, the controller being
   * turned off in HomeKit, and teardown.
   *
   * A failure here is logged at debug and nothing more. A token without webhook permissions cannot even list the endpoints, and a feature the user turned off - or
   * a controller they turned off - must never cost them an error line about it.
   */
  async #retireWebhook(official: OfficialApi): Promise<void> {

    try {

      const path = webhookEndpointPath(this.config.address);

      // Sequential for the same reason the reconcile's own cleanup is: these are writes against one controller, and the first refusal should end the attempt.
      for(const record of webhookRegistrations({ existing: await official.webhooks.fetchAllEndpoints(), path })) {

        // eslint-disable-next-line no-await-in-loop
        await official.webhooks.deleteEndpoint(record.id);
      }
    } catch(error) {

      this.log.debug("Unable to retire the webhook registration: %s.", formatErrorMessage(error));
    }
  }

  /* Decide whether one inbound delivery is genuine, fresh, and new, and hand it to the accessories when it is. This is the route the listener calls, and its
   * verdict is what the sender is answered with.
   *
   * Every refusal says why at debug and nothing louder: the input is untrusted, so a forger must not be able to write into the user's log at will. The one
   * exception is the warn that fires once per registration when verification starts failing, because that names a problem only the user can fix.
   *
   * The clock is read once at the head and both time-dependent tests share the reading, so a delivery cannot be judged fresh against one moment and replayed
   * against another. It is the platform's clock, the same one every timer here arms on, so a suite that moves time past the freshness window sees this judgment
   * move with it.
   */
  #receiveDelivery(request: HttpListenerRequest): boolean {

    const nowMs = this.platform.clock.now();
    const header = webhookSignatureHeader(request.headers);
    const webhook = this.#webhook;

    if(!webhook || (header === undefined)) {

      this.log.debug("A webhook delivery arrived carrying no signature, or with no registration to verify it against.");

      return false;
    }

    const signature = verifyWebhookSignature({ body: request.body, header, secret: webhook.endpoint.secret });

    if(!signature) {

      /* A well-formed header that fails the message authentication code is either a secret mismatch or a forgery, and only the first is something the user can
       * act on. One breadcrumb per registration is enough to point at it without a forger being able to fill the log.
       */
      if(!webhook.refusalWarned) {

        webhook.refusalWarned = true;

        this.log.warn("A webhook delivery failed signature verification. If the endpoint was re-registered outside the plugin, restart Homebridge to pick up its " +
          "new secret.");
      }

      this.log.debug("A webhook delivery failed signature verification.");

      return false;
    }

    if(!webhookDeliveryFresh({ nowMs, timestampSeconds: signature.timestamp, windowMs: ACCESS_WEBHOOK_FRESHNESS_WINDOW_MS })) {

      this.log.debug("A webhook delivery was refused as stale or postdated.");

      return false;
    }

    let parsed: unknown;

    try {

      parsed = JSON.parse(request.body.toString("utf8"));
    } catch(error) {

      this.log.debug("A webhook delivery carried a body that is not JSON: %s.", formatErrorMessage(error));

      return false;
    }

    if(!isAccessWebhookDelivery(parsed)) {

      // Authentic and fresh, but not a delivery this plugin models. The controller is told we took it so it stops retrying, and nothing is emitted.
      this.log.debug("A webhook delivery carried an event this plugin does not model.");

      return true;
    }

    if(!webhook.ledger.admit({ id: parsed.event_object_id, nowMs })) {

      this.log.debug("A webhook delivery repeated an identifier already accepted inside the freshness window.");

      return false;
    }

    this.events.emitDelivery(parsed);

    return true;
  }

  /* Move this controller to a new lifecycle phase. The single chokepoint that keeps every derived effect aligned: it refuses an illegal change, updates the phase,
   * and aborts the terminal shutdown signal on entry to shuttingDown - the one place the whole loop tree is torn down. The logApiErrors getter derives from the
   * phase and needs no update here.
   */
  private transition(next: AccessControllerPhase): void {

    if(!canTransition({ from: this.#phase, to: next })) {

      return;
    }

    this.#phase = next;

    if(next === "shuttingDown") {

      this.#shutdownController.abort();
    }
  }

  // Whether the terminal shutdown signal has fired. Read through a method so each caller re-reads the live signal rather than a snapshot an earlier bail captured.
  #isShuttingDown(): boolean {

    return this.signal.aborted;
  }

  /* The one place the client's definite-assignment typing is widened. The field is genuinely unset until the first connect resolves, and the getters and the
   * teardown path all need to read it during that window; confining the widening here makes the window readable without weakening the typing everywhere else.
   */
  #liveClient(): AccessClient | undefined {

    return this.client;
  }

  // Fire-and-forget a background loop. superviseLoop owns the resilience envelope - swallow on shutdown abort, surface a genuine fault once - and this binds every
  // loop to the terminal shutdown signal, so a loop's lifetime is that signal rather than an await.
  public spawnLoop(title: string, loop: () => Promise<void>): void {

    void superviseLoop({ loop, onError: loopFaultReporter(this.log, title), signal: this.signal });
  }

  /* Seed the device population and observe membership from there on. The seed read, the seed reconcile, the orphan sweep, and the loop statement are deliberately
   * one unbroken synchronous chain: the store captures an observer's baseline inside the first next() call, so leaving no task boundary between the snapshot and
   * the subscription means no dispatch can slip through unobserved. An await inserted anywhere in that chain reopens the missed-dispatch window.
   */
  #startMembershipObserver(): void {

    this.spawnLoop("the device list", async () => {

      const state = this.client.state.snapshot();

      this.#reconcileMembership(state);
      this.#sweepOrphans(state);

      for await (const ids of this.client.state.observe(this.#membershipSelector, { signal: this.signal })) {

        this.#reconcileMembership(this.client.state.snapshot(), ids);
      }
    });
  }

  /* Deliver the client's live door state to every hub that projects one, and keep delivering as that state moves. The first delivery and the loop statement are
   * deliberately one unbroken synchronous chain, for the same reason the membership observer's is: the store captures an observer's baseline inside the first
   * next() call, so an await anywhere between the first read and the subscription reopens a window in which a dispatch lands unobserved.
   *
   * That first delivery deliberately overlaps what each hub already seeded for itself at construction. The overlap is exactly what closes the gap between a hub
   * being built and this loop watching, and the apply path writes only what genuinely differs, so a second reading of unchanged state costs nothing.
   *
   * Observing the door-state map rather than consuming the client's typed door-state event is what makes the delivery total: the packet event carries only what the
   * wire reported, where this wakes on every change the model records, whichever surface established it.
   */
  #startDoorStateObserver(): void {

    this.spawnLoop("door states", async () => {

      this.#deliverDoorStates();

      for await (const _doorStates of this.client.state.observe(selectDoorStates, { signal: this.signal })) {

        this.#deliverDoorStates();
      }
    });
  }

  /* Hand every configured hub its own door state. Each hub resolves the door it drives through the library's own handle, so this plugin never rebuilds a
   * door-to-device map of its own.
   *
   * The per-device isolation is what keeps one hub's fault from costing its siblings their delivery: without it, a single synchronous throw would unwind the whole
   * loop through superviseLoop's terminal catch and end door-state delivery for every hub on this controller.
   */
  #deliverDoorStates(): void {

    for(const device of this.configuredDevices.values()) {

      if(!(device instanceof AccessHub)) {

        continue;
      }

      try {

        device.refreshDoorState();
      } catch(error) {

        device.log.error("Unable to update the door state: %s.", formatErrorMessage(error));
      }
    }
  }

  /* Observe the controller's connection and keep every device honest about it. This is the single consumer of the connection's state stream in this process, and it
   * carries both of the controller-wide duties that stream drives on the one iterator.
   *
   * Controller health is one fact with one reader. Rather than every device subscribing to a monitor that can only ever tell them all the same thing, this loop walks
   * the configured devices and pushes each its recomputed reachability, while each device's own record loop pulls the per-device half of that composition. Push where
   * the fact is controller-wide, pull where it is per-device.
   *
   * No initial walk is needed: the connection is healthy by construction where login() reaches this, and every carrier seeds its own value when it is configured.
   */
  #startConnectionObserver(): void {

    this.spawnLoop("the controller connection", async () => {

      for await (const transition of this.client.connection.observe({ signal: this.signal })) {

        this.log.debug("Controller connection: %s -> %s.", transition.from, transition.to);

        /* The per-device isolation is what keeps one device's fault from costing its siblings their push: without it, a single synchronous throw would unwind the
         * whole loop through superviseLoop's terminal catch and end availability pushes for every device on this controller. The restore walk below carries its own
         * for the same reason.
         */
        for(const device of this.configuredDevices.values()) {

          try {

            device.refreshReachability();
          } catch(error) {

            device.log.error("Unable to update the availability state: %s.", formatErrorMessage(error));
          }
        }

        /* Leaving the reconnecting state for anything other than lost is the state machine's own statement that a recovery completed, which is what makes it the
         * trigger here. Reconnecting has exactly one entry - inside the recovery path, after its reachability probe answers - and a completed recovery re-bootstraps
         * state and relaunches the notification channel without replaying the packets the gap swallowed, whichever flavor the episode was. It exits to healthy, or to
         * throttled where the transport's breaker happens to be open at that moment.
         *
         * The library's recovered event under-covers this, speaking only for an episode that reached lost, and an arrival at healthy over-covers it, since a plain
         * throttle cycle arrives there having done no stream work and missed nothing.
         */
        if((transition.from !== "reconnecting") || (transition.to === "lost")) {

          continue;
        }

        for(const device of this.configuredDevices.values()) {

          try {

            device.onConnectionRestored();
          } catch(error) {

            device.log.error("Unable to refresh state after the connection recovered: %s.", formatErrorMessage(error));
          }
        }
      }
    });
  }

  /* Reconcile HomeKit membership against the controller's current device set. One engine handles both directions: an identity we have not configured is added, and a
   * configured device whose identity has left is queued for removal. The content-memoized selector wakes the loop only on a genuine membership change, so the
   * reconcile cost scales with real deltas rather than with how chatty the controller is.
   *
   * The delta is taken against each configured device's own record identity, never against the map's keys - the map is keyed by accessory UUID, and diffing UUIDs
   * against record identities would classify every configured device as simultaneously added and removed on every pass.
   */
  #reconcileMembership(state: AccessState, ids = this.#membershipSelector(state)): void {

    const { toAdd, toRemove } = membershipDelta(ids, [...this.configuredDevices.values()].map(device => device.uda.unique_id));

    for(const id of toAdd) {

      const device = deviceRecord(id, state);

      if(device) {

        this.addHomeKitDevice(device);
      }
    }

    for(const id of toRemove) {

      const accessDevice = this.deviceLookup(id);

      if(accessDevice) {

        this.removeHomeKitDevice(accessDevice.accessory);
      }
    }

    // Refresh the accessory cache when membership actually moved, rather than on a cadence.
    if(toAdd.length || toRemove.length) {

      this.platform.api.updatePlatformAccessories(this.platform.accessories);
    }
  }

  /* Reclaim cached accessories current membership cannot account for. Homebridge restores previously-registered accessories at startup, so a device unpaired
   * while we were down comes back as an accessory with nothing behind it, and so does an accessory created under an earlier form of a device's identity.
   * Anything belonging to this controller that we have not configured and that current membership cannot account for is reclaimed here, and the two cases part on
   * the identity the accessory records. One that records none was created under an earlier form, or had its record wiped by an older version running in between:
   * nothing will ever mint an accessory that records no identity again, so it can never be adopted whether or not its device is present, and it goes at once
   * rather than through a delay that exists for a device that might come back. One that records the identity it was created under is a departure - its device may
   * return and be adopted under that same identity - and takes the same removal delay a membership departure honors.
   */
  #sweepOrphans(state: AccessState): void {

    const claims = this.#membershipClaims(state);

    for(const accessory of this.platform.accessories.filter(x => this.#isOurs(x, claims))) {

      if(this.configuredDevices.has(accessory.UUID) || claims.uuids.has(accessory.UUID)) {

        continue;
      }

      if(accessory.context.id === undefined) {

        this.#retire(accessory, "It carries no record of the device identity this version keys accessories by.");

        continue;
      }

      this.removeHomeKitDevice(accessory);
    }
  }

  /* The claims current membership makes on cached accessories. Accessory identity is UUID-shaped while membership identity is record-shaped, and this is the one
   * bridge between the two vocabularies - consulted by the orphan sweep at startup, by the disabled-controller pass, and by each armed removal when its timer
   * fires, which are the same question asked at different moments. The UUIDs are what membership accounts for; the serials are the hardware it projects, which is
   * how an accessory stamped by a key this controller never answered by is still recognized as naming a device of its own. Both are read from one walk of the
   * projected membership, so a pass over every cached accessory costs one walk and then a set test per accessory.
   *
   * A stateless read of the snapshot it is handed, so there is nothing to invalidate at teardown, and the set tests leave the sweep order-independent - an
   * accessory whose record is projectable stays whether or not it has been adopted yet.
   */
  #membershipClaims(state: AccessState): MembershipClaims {

    const serials = new Set<DecoratedSerial>();
    const uuids = new Set<string>();

    for(const device of projectedRecords(state)) {

      serials.add(serialForm(device.mac));
      uuids.add(this.#accessoryUuid(device));
    }

    return { serials, uuids };
  }

  /* The one accessory-UUID derivation: the accessory identity a device record maps to. The seed is the device's decorated serial - the identity every
   * feature-option read, MQTT topic, and webUI row addresses the device by, and the identity the hub records in the accessory's context - so the accessory cache
   * key and the device identity are one statement, and every site that needs to know which accessory a record maps to comes through here. The record arrives
   * already narrowed to one carrying a hardware identity, because there is no accessory identity to derive without one.
   */
  #accessoryUuid(device: AccessStateDevice & { mac: string }): string {

    return this.platform.api.hap.uuid.generate(deviceSerial(device));
  }

  /* Create an instance of the Access device type in our plugin. Resolving the hub view first is what gives lock-capable hardware its command surface: hub() and
   * accessPoint() answer the command-bearing projection, while device() answers the command-less base a reader needs nothing more than.
   *
   * The record is handed to the device as its admission record, which is where the device captures the hardware identity it keeps for its lifetime. The projection
   * cannot serve that purpose: it reads through to live state, where the identity is optional and the record moves under it.
   */
  #addAccessDevice(accessory: AccessAccessory, device: AccessStateDevice & { mac: string }): void {

    const id = device.unique_id;
    const hubHandle = this.client.hub(id) ?? this.client.accessPoint(id);
    const handle = hubHandle ?? this.client.device(id);

    if(!handle) {

      this.log.debug("%s: The device left controller state before it could be adopted.", this.getDeviceName(device));

      return;
    }

    this.configuredDevices.set(accessory.UUID, new AccessHub(this, handle, accessory, device, hubHandle));
  }

  /**
   * Add a newly detected Access device to HomeKit.
   *
   * @param device - The device record to add.
   *
   * @returns `true` when the device is now tracked in HomeKit.
   */
  public addHomeKitDevice(device: AccessStateDevice): boolean {

    /* The record has to still be one membership would admit. Membership applied this same gate when it named the device, so a record failing it here left
     * membership between the selector's wake and this lookup - the ordinary removal window, which the adoption path below reports the same way. Establishing it
     * here is also what gives every identity read past this point a record whose hardware identity exists.
     */
    if(!isManagedRecord(device)) {

      this.log.debug("%s: The device left controller state before it could be added to HomeKit.", this.getDeviceName(device));

      return false;
    }

    // We only support certain device capabilities. Membership admits managed-but-unsupported records deliberately, so this gate is reachable and the user hears about
    // hardware we cannot project exactly once.
    if(!isSupportedAccessDevice(device)) {

      // If we've already informed the user about this one, we're done.
      if(this.#unsupportedDevices[device.mac]) {

        return false;
      }

      // Notify the user we see this device, but we aren't adding it to HomeKit.
      this.#unsupportedDevices[device.mac] = true;

      this.log.info("UniFi Access device type '%s' is not currently supported, ignoring: %s.", device.device_type, this.getDeviceName(device));

      return false;
    }

    // Generate this device's accessory identity. For an Enterprise hub we can't rely on the MAC address alone, since one drives several doors.
    const uuid = this.#accessoryUuid(device);
    let accessory = this.platform.accessories.find(x => x.UUID === uuid);

    // Enable or disable certain devices based on configuration parameters.
    if(!this.hasFeature("Device", deviceSerial(device))) {

      if(accessory) {

        this.#retire(accessory);
      }

      return false;
    }

    // A device arriving here is being adopted, so cancel any pending removal armed against its accessory - the orphan-return path, where a startup sweep armed a
    // grace and the device came back before it fired.
    if(accessory) {

      this.#removals.clear(accessory.UUID);
    }

    // We've got a new device, let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.platform.api.platformAccessory<AccessAccessoryContext>(sanitizeName(this.resolveDeviceName(device)), uuid);

      this.log.info("%s: Adding %s to HomeKit.", this.getDeviceName(device), this.resolveDeviceModel(device));

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      this.platform.registerAccessory(accessory);
    }

    // Setup the accessory as a new Access device in HBUA if we haven't configured it yet. A device we already track needs nothing here: its updates arrive through
    // its own observe loop rather than a synthetic re-emit.
    if(!this.configuredDevices.has(accessory.UUID)) {

      this.#addAccessDevice(accessory, device);
    }

    return true;
  }

  /**
   * Remove an individual Access device from HomeKit: the departure path, which honors the configured removal delay. Whether the accessory is this controller's to
   * act on is answered by `#isOurs`, and the mechanics of leaving HomeKit live in `#retire`, so a caller retiring an accessory for a reason of its own reaches the
   * same two statements this one does.
   *
   * @param device          - The accessory to remove.
   * @param noRemovalDelay  - Whether to bypass the configured removal delay.
   */
  public removeHomeKitDevice(accessory: AccessAccessory, noRemovalDelay = false): void {

    // Ensure that this accessory hasn't already been removed.
    if(!this.platform.accessories.some(x => x.UUID === accessory.UUID)) {

      return;
    }

    // We only remove devices if they're on the Access controller we're interested in.
    if(!this.#isOurs(accessory)) {

      return;
    }

    const delayInterval = this.getFeatureNumber("Controller.DelayDeviceRemoval") ?? 0;

    /* For certain use cases, we may want to defer removal of an Access device where Access may lose track of devices for a brief period of time. This prevents a
     * potential back-and-forth where devices are removed momentarily only to be readded later.
     */
    if(!noRemovalDelay && delayInterval) {

      /* An armed timer already owns this removal, so a reconcile raising the same departure again leaves it alone. Asking first is what keeps the delay the one
       * already being served: a second registration under the same key would replace the first and start the whole wait over.
       */
      if(this.#removals.has(accessory.UUID)) {

        return;
      }

      this.log.info(ACCESS_DEVICE_REMOVAL_DELAY_MESSAGE, accessory.displayName, delayInterval, delayInterval > 1 ? "s" : "");

      /* The registry removes the entry before running the callback, so the membership re-check below is the whole of what decides: a device that came back during
       * the delay keeps its accessory, its entry is already gone, and nothing arms in its place.
       */
      this.#removals.setTimeout(accessory.UUID, () => {

        if(!this.#membershipClaims(this.client.state.snapshot()).uuids.has(accessory.UUID)) {

          this.removeHomeKitDevice(accessory, true);
        }
      }, delayInterval * 1000);

      return;
    }

    this.#retire(accessory);
  }

  /* The one path an accessory leaves HomeKit through. Its callers own the policy of when: a departure honors the removal delay and the ownership predicate first,
   * an accessory created under an earlier form of its device's identity goes at once from the sweep since the predicate already counts it as ours, and a
   * controller the user disabled takes every accessory it answered for with it while a device the user disabled gives up the accessory under its identity.
   *
   * Whether the accessory is still in the list is read first, so one already gone returns here rather than narrating a departure that has already happened. The
   * mechanics of leaving - the unregister, the list, and the cache refresh - belong to the platform's one exit, which answers the same question for itself.
   *
   * Each retirement refreshes the accessory cache once, so a start that retires several accessories refreshes once per retirement. The refresh is what makes each
   * unregister durable, and a retirement is a one-time event per accessory.
   *
   * A caller with something to add beyond the departure itself hands over a reason, which is said after the removal line's own sentence.
   */
  #retire(accessory: AccessAccessory, reason?: string): void {

    if(!this.platform.accessories.includes(accessory)) {

      return;
    }

    // Cleanup after ourselves.
    this.#removals.clear(accessory.UUID);

    // Grab our instance of the Access device, if it exists.
    const accessDevice = this.configuredDevices.get(accessory.UUID);

    // See if we can name the device from our own instance or, for an accessory we never configured, from the controller's own record of it.
    const state = this.#liveClient()?.state.snapshot();
    const mac = accessory.context.mac;
    const device = accessDevice?.uda ?? (((state !== undefined) && (mac !== undefined)) ? recordByMac(mac, state.devices.values()) : undefined);

    this.log.info("%s: Removing %s from HomeKit.%s", device ? this.getDeviceName(device) : accessDevice?.accessoryName ?? accessory.displayName,
      device ? this.resolveDeviceModel(device) : "device", reason ? " " + reason : "");

    // Cleanup our device instance.
    accessDevice?.cleanup();

    // Finally, remove it from our list of configured devices and HomeKit.
    this.configuredDevices.delete(accessory.UUID);

    // Unregister the accessory and delete its remnants from HomeKit and the plugin, through the platform's one exit for that.
    this.platform.unregisterAccessory(accessory);
  }

  /**
   * Publish to MQTT, if configured. The one fire-and-forget publish chokepoint every publish site in the plugin routes through.
   *
   * It exists to state the optionality of MQTT once: a controller whose user configured no broker has no client at all, and every publish site in the plugin would
   * otherwise carry that question of its own. What becomes of the publish belongs to the client, which reports a genuine delivery failure at error level naming the
   * expanded topic, and drops a cancelled one - the client tearing down, or the publish's own signal firing before or while it is in flight - to debug, since a
   * caller whose publish has been torn down has nothing left to do with the outcome.
   *
   * The device layer's own subscribe methods call the client directly rather than through a chokepoint here, deliberately: registering a subscription is
   * synchronous, returns no promise, and early-returns on an aborted signal, so no rejection class exists there.
   *
   * @param topic   - The composed topic tail to publish to.
   * @param payload - The payload to publish.
   * @param init    - The client's own per-publish options, forwarded as given. A device publishes under its own lifetime signal; a controller-scoped publish passes
   *                  nothing, since the client is already bound to the controller's terminal signal.
   */
  public mqttPublish(topic: string, payload: string, init?: MqttPublishInit): void {

    this.mqtt?.publishGuarded(topic, payload, init);
  }

  /**
   * Lookup a device by its identifier and return it if it exists.
   *
   * @param deviceId - The device's record identity.
   *
   * @returns The configured device, or `null`.
   */
  public deviceLookup(deviceId: string): Nullable<AccessDevice> {

    for(const device of this.configuredDevices.values()) {

      if(device.uda.unique_id === deviceId) {

        return device;
      }
    }

    return null;
  }

  /* Utility to generate a nicely formatted device string, in the form: Device Name [Device Type] (address: IP address id: device identity).
   *
   * The identity clause establishes the exact string a per-device feature option and an MQTT topic address this device by, an Enterprise port's qualifier
   * included, so a user reading the startup log has the spelling to type. The parenthetical carries what the record actually establishes and nothing more: the
   * official API's inventory reports no address at all, and a device it names by an identifier that is not address-shaped carries no hardware identity either, so
   * each clause is present only where its own fact is rather than rendering a label over an absent value.
   */
  public getDeviceName(device: AccessStateDevice, name = device.alias.length ? device.alias : device.name, deviceInfo = false): string {

    const details: string[] = [];

    if(device.ip) {

      details.push("address: " + device.ip);
    }

    if(isManagedRecord(device)) {

      details.push("id: " + deviceSerial(device));
    }

    return name + " [" + this.resolveDeviceModel(device) + "]" + ((deviceInfo && details.length) ? " (" + details.join(" ") + ")" : "");
  }

  // Utility to retrieve a reasonable device name for an Access device. The alias an administrator gave the hardware where there is one, and the controller's own
  // name for it otherwise - both are members every census establishes, so there is nothing further to fall back to.
  public resolveDeviceName(device: AccessStateDevice): string {

    return device.alias.length ? device.alias : device.name;
  }

  // Utility to retrieve a reasonable device model for an Access device. The resolution itself lives in the policy module, so the webUI server and the plugin's own
  // display paths read one statement of it.
  public resolveDeviceModel(device: AccessStateDevice): string {

    return deviceModel(device);
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getFloat(option, this.id);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.id);
  }

  /* Utility for checking feature options on the controller, and on one of its devices where the caller names one.
   *
   * The caller names a device by its decorated serial, which is the identity the option engine scopes on...the brand is what turns a raw MAC address handed in at
   * this boundary into a compile error. This is the pre-construction path, for the adoption gate that has to ask about a record before there is a device object to
   * ask for itself; a constructed device reads the engine through its own accessors. A caller naming no device resolves the option at this controller's own scope.
   */
  public hasFeature(option: string, device?: DecoratedSerial): boolean {

    return this.platform.featureOptions.test(option, device ?? this.id, this.id);
  }

  // The controller's own information document, read through to the live state, or null before one has been fetched.
  public get uda(): Nullable<AccessControllerConfig> {

    return this.#liveClient()?.controllerInfo ?? null;
  }

  /* The key this controller stamps its accessories with, and matches them by: the controller's own MAC address where a controller document exists, and the
   * configured address where one never will.
   *
   * A controller reached with an API token alone reads no controller document for the life of the process, because that document is served by the Access
   * application's own endpoints rather than the published API. Its address is the only stable name it has, and an accessory has to carry some name of its
   * controller or the orphan sweep cannot tell one controller's hardware from another's.
   */
  public get ownershipKey(): string {

    return this.uda?.host.mac ?? this.config.address;
  }

  /**
   * Both keys this controller answers its accessories by: the one it stamps them with now, and the one it answered by before it learned its MAC address. The prior
   * key exists only once a controller document has been read, since that is the transition it describes.
   *
   * The pair is composed here, once, because two decisions read it - our own ownership verdict below, and the platform's decision about an accessory no controller
   * has claimed, which weighs a context key against every configured controller's keys at once. A controller is the only thing that can say what its own are.
   *
   * @returns The keys this controller answers by.
   */
  public get reclaimKeys(): ControllerOwnershipKeys {

    return { currentKey: this.ownershipKey, priorKey: this.uda ? this.config.address : undefined };
  }

  /**
   * The claims this controller's membership makes at this moment, or `undefined` when no client has been established to ask.
   *
   * The claims are meaningful only for a controller whose login resolved as reporting. One the user disabled has disposed its client and already retired every
   * accessory it answered for, so nothing should be asking it what it projects. The platform's pass over unclaimed accessories and each delayed re-check that
   * follows it are the consumers, and each of them reads this afresh rather than holding an answer, so a device that arrives between those moments is seen.
   *
   * @returns What this controller's membership currently claims, or `undefined` when there is no client to read it from.
   */
  public reclaimClaims(): MembershipClaims | undefined {

    const state = this.#liveClient()?.state.snapshot();

    return (state === undefined) ? undefined : this.#membershipClaims(state);
  }

  /* The ownership verdict for one cached accessory: whether it is ours by the key we answer by now, ours by the key we answered by before we learned our MAC
   * address, or nobody's business of ours. Both keys arrive as the one pair every consumer of them reads.
   */
  #accessoryOwnership(accessory: AccessAccessory): AccessAccessoryOwnership {

    return accessoryOwnership({ contextKey: accessory.context.controller, ...this.reclaimKeys });
  }

  /* The one statement of which accessories are this controller's to act on: one stamped by a key we answer by, or one whose context names the hardware of a device
   * this controller projects, in any spelling. The identity claim is the stronger proof of the two, since a key is whatever was written into the context when the
   * accessory was created while the MAC address names the hardware itself. The context carries no port qualifier and the claim needs none: every port of an
   * Enterprise hub shares the hub's hardware, and the port grain is answered by the accessory UUID against membership, which every caller that can act on the
   * answer reads first.
   *
   * A caller holding the claims passes them in and one that does not lets the predicate derive them from the live snapshot once, after the key test, so the common
   * case - a key we answer by - settles for the cost of one string comparison.
   */
  #isOurs(accessory: AccessAccessory, claims?: MembershipClaims): boolean {

    if(this.#accessoryOwnership(accessory) !== "foreign") {

      return true;
    }

    const mac = accessory.context.mac;

    if(mac === undefined) {

      return false;
    }

    if(claims !== undefined) {

      return claims.serials.has(serialForm(mac));
    }

    // A controller with no live client has no membership claims to consult, so it claims by key alone.
    const state = this.#liveClient()?.state.snapshot();

    return (state !== undefined) && this.#membershipClaims(state).serials.has(serialForm(mac));
  }

  // Return a unique identifier for an Access controller.
  public get id(): DecoratedSerial | undefined {

    return this.uda ? serialForm(this.uda.host.mac) : undefined;
  }

  /* The identity this controller's own MQTT topics are published under: its serial where a controller document exists, and its configured address where one never
   * will. A controller reached with an API token alone reads no controller document for the life of the process, so its address is the only stable name it has,
   * exactly as the ownership key above reasons. A credentialed controller publishes under its serial, the same identity form every device topic carries.
   */
  public get mqttIdentity(): string {

    return this.id ?? this.config.address;
  }

  // The name this controller's log lines are prefixed with.
  public get name(): string {

    return this.#name;
  }

  // Whether client-side errors should reach the user. True in every phase but shutdown, where the teardown cascade produces noise about a connection we are
  // deliberately ending.
  public get logApiErrors(): boolean {

    return (this.#phase === "connecting") || (this.#phase === "running");
  }

  // The terminal plugin-shutdown abort signal, fired exactly once through the transition chokepoint. Every loop and per-device controller composes against it.
  public get signal(): AbortSignal {

    return this.#shutdownController.signal;
  }
}
