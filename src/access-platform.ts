/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-platform.ts: homebridge-unifi-access platform class.
 */
import { ACCESS_DEVICE_REMOVAL_DELAY_MESSAGE, ACCESS_WEBHOOK_PORT, PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { API, DynamicPlatformPlugin, Logging } from "homebridge";
import { APIEvent, FeatureOptions, debugGatedLog, formatErrorMessage, guardedDispatch, onAbort } from "homebridge-plugin-utils";
import type { AccessAccessory, AccessPlatformConfig } from "./access-types.ts";
import { AccessController, createRemovalQueue } from "./access-controller.ts";
import type { AccessLoginOutcome, ControllerOwnershipKeys, MembershipClaims } from "./access-policy.ts";
import { AccessWebhookListener, localAddressFor } from "./access-webhooks.ts";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { accessoryStranded, composeConnectIdentity, reclaimFenceOpen } from "./access-policy.ts";
import { featureOptionCategories, featureOptions } from "./access-options.ts";
import type { AccessOptions } from "./access-options.ts";

/* What one controller's startup settled: the controller itself, and what its login established about its identity. The two are paired at the moment the login is
 * started, so nothing downstream has to match an outcome back to a controller by its position in an array.
 */
interface AccessControllerReport {

  controller: AccessController;
  outcome: AccessLoginOutcome;
}

export class AccessPlatform implements DynamicPlatformPlugin {

  public accessories: AccessAccessory[];
  public readonly api: API;
  public readonly config: AccessOptions;
  private readonly controllers: AccessController[];
  public readonly featureOptions: FeatureOptions;
  public readonly log: Logging;
  /* The plugin's own debug channel, gated at global scope. Composed once here because the platform speaks for the plugin as a whole and has one identity to resolve
   * against, unlike a controller or a device, each of which composes its own gate over its own name.
   */
  readonly #debugLog: HomebridgePluginLogging;
  /* The plugin's lifetime, aborted when Homebridge tells us it is going away. This is the one root every controller's own terminal signal composes from, so the
   * shutdown event is registered exactly once for the plugin rather than once per controller.
   */
  readonly #shutdownController: AbortController;
  /* The delayed removals of accessories no configured controller answers for, built on the first reclaim that honors a delay. An install whose controllers answer
   * for everything they created never builds one, and never arms a timer.
   */
  #strandedRemovals: Nullable<ReturnType<typeof createRemovalQueue>>;
  // The one webhook listener, constructed on the first controller that asks for it. A plugin with webhooks turned off never asks, so it binds no port at all.
  #webhookListener: Nullable<AccessWebhookListener>;
  // The port that listener will bind, read once here because the port is a plugin-wide deployment decision rather than a per-controller one.
  readonly #webhookPort: number;

  constructor(log: Logging, config: AccessPlatformConfig | undefined, api: API) {

    this.accessories = [];
    this.api = api;
    this.controllers = [];
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, config?.options ?? []);
    this.log = log;
    this.#debugLog = debugGatedLog(log, () => this.featureOptions.test("Log.Debug"));
    this.#shutdownController = new AbortController();
    this.#strandedRemovals = null;
    this.#webhookListener = null;
    this.#webhookPort = this.featureOptions.getInteger("Controller.Webhooks.Port") ?? ACCESS_WEBHOOK_PORT;

    // Arm the plugin's lifetime before anything below can return early, so the signal every controller and every listener composes against always exists.
    api.on(APIEvent.SHUTDOWN, () => this.#shutdownController.abort());

    // Plugin options into our config variables.
    this.config = {

      controllers: config?.controllers ?? [],
      options: config?.options ?? []
    };

    // We need a UniFi Access controller configured to do anything.
    if(!this.config.controllers.length) {

      this.log.info("No UniFi Access controllers have been configured.");

      return;
    }

    // Debugging - most people shouldn't enable this.
    this.debug("Debug logging on. Expect a lot of data.");

    // Loop through each configured NVR and instantiate it.
    for(const controllerConfig of this.config.controllers) {

      // We need an address, or there's nothing to do.
      if(!controllerConfig.address) {

        this.log.info("No host or IP address has been configured.");

        continue;
      }

      // We need an identity the client can connect with - credentials, an API token, or both - or we're skipping this one. The composition is stated once in the
      // policy module so this gate and the controller's own cannot drift apart on what counts as valid.
      const identity = composeConnectIdentity(controllerConfig);

      if(identity.error !== undefined) {

        this.log.info(identity.error);

        continue;
      }

      this.controllers.push(new AccessController(this, controllerConfig));
    }

    // Avoid a prospective race condition by waiting to configure our controllers until Homebridge is done loading all the cached accessories it knows about, and calling
    // configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.launchControllers.bind(this));
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic
  // for device discovery.
  public configureAccessory(accessory: AccessAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  /**
   * Remove an accessory from HomeKit and from our own list of them: the one exit an accessory leaves through at this layer.
   *
   * This is the list-and-HomeKit mechanics and nothing else. An owner holding live state for the accessory - a configured device instance with its services, its
   * timers, and its subscriptions - releases that state before calling here, and the departure paths that do so are the controller's `removeHomeKitDevice` and
   * its own retire. A caller reaching for this method directly is bypassing that release and is almost certainly wrong; the one caller that legitimately does is
   * the reclaim below, whose accessories were never configured by anything and so hold no state to release.
   *
   * An accessory we are not carrying is a no-op, which is what makes a second call for the same accessory harmless.
   *
   * @param accessory - The accessory to remove.
   */
  public unregisterAccessory(accessory: AccessAccessory): void {

    const index = this.accessories.indexOf(accessory);

    if(index < 0) {

      return;
    }

    // Unregister the accessory and delete its remnants from HomeKit and the plugin.
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.splice(index, 1);

    // Tell Homebridge to save the updated list of accessories.
    this.api.updatePlatformAccessories(this.accessories);
  }

  /* Launch our configured controllers once all accessories have been loaded. Once we do, they will sustain themselves.
   *
   * Every login starts concurrently, with nothing waiting on the one before it, and each is paired with its own controller as it starts so the reclaim that
   * consumes them can attribute an outcome without counting positions. A login that rejects is absorbed at its own pair and reported against the controller it
   * belongs to, which keeps one controller's failure from costing its siblings anything and leaves the aggregate unable to reject.
   *
   * The logins are started by the map above the dispatch, so they begin eagerly whatever the dispatch does with them. The reclaim itself rides the shared guarded
   * dispatch, which reports a fault through our log rather than letting one float out of a call nothing awaits.
   */
  private launchControllers(): void {

    const reports = this.controllers.map((controller) => controller.login().then(
      (outcome): AccessControllerReport => ({ controller, outcome }),
      (error: unknown): AccessControllerReport => {

        // A login that rejects outright leaves this controller's identity unknown, which the fence reads as unavailable...the reclaim stands down for the session.
        controller.log.error("Startup did not complete, so stranded-accessory cleanup is skipped for this session: %s.", formatErrorMessage(error));

        return { controller, outcome: "unavailable" };
      }));

    guardedDispatch({ handler: async (): Promise<void> => this.reclaimStranded(reports), label: "stranded-accessory cleanup", log: this.log });
  }

  /**
   * Reclaim the cached accessories that belong to nothing this plugin is configured for, once every configured controller has reported.
   *
   * A controller replaced by different hardware, or an entry the user deleted from the configuration, leaves accessories behind that no controller will ever
   * speak for again. No per-controller path can reclaim them: each one is deliberately blind to accessories another controller keyed, which is exactly what keeps
   * two controllers configured in one plugin from reclaiming each other's. Deciding this takes every controller's evidence at once, so it is decided here.
   *
   * The pass runs once per session, on evidence that is complete or not at all. A controller still working through its connect retry never settles its report and
   * holds the pass off for the whole session, which is the conservative default: an accessory left in place can be reclaimed at the next start, while one removed
   * on incomplete evidence costs the user their configuration.
   *
   * @param reports - Each controller's login, paired with the controller it was started for.
   */
  private async reclaimStranded(reports: Promise<AccessControllerReport>[]): Promise<void> {

    // Every report resolves by construction, since a rejecting login is mapped to an unavailable identity at its own pair, so this can never reject.
    const settled = await Promise.all(reports);

    // A shutdown that resolved these logins is not an occasion to act on them.
    if(this.signal.aborted) {

      this.debug("Not looking for accessories to reclaim: the plugin is shutting down.");

      return;
    }

    const outcomes = settled.map((report) => report.outcome);

    if(!reclaimFenceOpen({ configuredControllers: this.config.controllers.length, constructedControllers: this.controllers.length, outcomes })) {

      this.debug("Not looking for accessories to reclaim: %s of %s configured controllers were started, and their logins reported %s.", this.controllers.length,
        this.config.controllers.length, outcomes.join(", "));

      return;
    }

    const { claims, keys } = this.#reclaimEvidence(settled);
    // The delay resolves at global scope, since this pass names no controller and no device...it speaks for accessories that have neither.
    const delayInterval = this.featureOptions.getInteger("Controller.DelayDeviceRemoval") ?? 0;

    /* Walk a copy of the list, because a removal splices the live one. Nothing awaits between the evidence read above and the removals below, so the whole walk
     * decides against one picture of what the controllers claim.
     */
    for(const accessory of [...this.accessories]) {

      if(!accessoryStranded({ claims, contextKey: accessory.context.controller, keys, mac: accessory.context.mac, uuid: accessory.UUID })) {

        continue;
      }

      // With no delay configured there is nothing to wait for.
      if(!delayInterval) {

        this.#retireStranded(accessory);

        continue;
      }

      /* The queue is built by the first accessory that needs one, and the teardown is wired inside the same branch as the construction so that however many
       * accessories follow this one, the plugin's lifetime carries exactly one listener for the queue it clears.
       */
      if(!this.#strandedRemovals) {

        this.#strandedRemovals = createRemovalQueue({ remove: (target) => this.#retireStranded(target),
          stillGone: (uuid) => this.#stillStranded({ settled, uuid }) });
        onAbort(this.signal, () => this.#strandedRemovals?.clear());
      }

      // The queue holds one timer per accessory and arming a second would strand the first, so it is asked before arming - the contract the departure path honors.
      if(this.#strandedRemovals.isQueued(accessory.UUID)) {

        continue;
      }

      this.log.info(ACCESS_DEVICE_REMOVAL_DELAY_MESSAGE, accessory.displayName, delayInterval, delayInterval > 1 ? "s" : "");
      this.#strandedRemovals.queue(accessory, delayInterval * 1000);
    }
  }

  /* The evidence a reclaim decides against: the keys every configured controller answers by, and the membership claims of those that have any to make.
   *
   * Both moments that decide - the pass itself, and each delayed removal re-checking before it fires - assemble it here, so they cannot come to disagree about
   * what counts as evidence. The keys come from every report, because the decision is about every configured controller by definition. The claims come only from
   * the controllers that reported: one the user disabled has disposed its client and already retired everything it answered for, and this one statement of which
   * set is read is what keeps it from being asked.
   */
  #reclaimEvidence(settled: AccessControllerReport[]): { claims: MembershipClaims[]; keys: ControllerOwnershipKeys[] } {

    const claims: MembershipClaims[] = [];
    const keys: ControllerOwnershipKeys[] = [];

    for(const report of settled) {

      keys.push(report.controller.reclaimKeys);

      if(report.outcome !== "reporting") {

        continue;
      }

      const claim = report.controller.reclaimClaims();

      if(claim !== undefined) {

        claims.push(claim);
      }
    }

    return { claims, keys };
  }

  /* Whether an accessory awaiting removal still belongs to nothing, asked when its timer fires. The evidence is assembled again rather than captured when the
   * timer was armed, so a device that arrived during the delay - hardware readopted, a hub back from a reboot - keeps the accessory that names it.
   *
   * @param options - The reports the pass settled on, and the UUID of the accessory whose removal is about to fire.
   */
  #stillStranded(options: { settled: AccessControllerReport[]; uuid: string }): boolean {

    const { settled, uuid } = options;
    const accessory = this.accessories.find(candidate => candidate.UUID === uuid);

    // Something else took it out of HomeKit while the timer ran, so there is nothing left to do.
    if(!accessory) {

      return false;
    }

    const { claims, keys } = this.#reclaimEvidence(settled);

    return accessoryStranded({ claims, contextKey: accessory.context.controller, keys, mac: accessory.context.mac, uuid });
  }

  /* Remove an accessory the reclaim has decided belongs to nothing. This is deliberately not the controller's own retire: there is no device instance to clean up
   * and no membership to cancel a queued removal against, because nothing ever configured this accessory in this session, and no controller's lifecycle owns it -
   * the accessory outlived whichever controller created it.
   *
   * Our list is consulted first so an accessory already gone is never announced as leaving.
   */
  #retireStranded(accessory: AccessAccessory): void {

    if(!this.accessories.includes(accessory)) {

      return;
    }

    this.log.info("%s: Removing this accessory from HomeKit. It belongs to no configured controller, and no controller reports its device.",
      accessory.displayName);

    this.unregisterAccessory(accessory);
  }

  // Debug logging for lines that have no owner identity to name - the platform's own, and anything else that speaks for the plugin as a whole. They resolve at global
  // scope, so a plugin-wide debug entry turns them on while a device- or controller-suffixed one does not.
  public debug(message: string, ...parameters: unknown[]): void {

    this.#debugLog.debug(message, ...parameters);
  }

  /**
   * The plugin's lifetime signal, aborted once when Homebridge shuts down. Every controller composes its own terminal signal from this one.
   *
   * @returns The signal.
   */
  public get signal(): AbortSignal {

    return this.#shutdownController.signal;
  }

  // The port the webhook listener binds. The registered endpoint URL names this rather than whatever port the server has actually bound, because a registration is
  // composed the moment a controller connects and the bind completes on its own schedule.
  public get webhookPort(): number {

    return this.#webhookPort;
  }

  /**
   * The plugin's one webhook listener, constructed the first time a controller asks for it.
   *
   * One listener serves every configured controller, routed by path, because the port is a deployment decision the user makes once for the whole plugin rather
   * than once per controller. Nothing constructs it until a controller with webhooks turned on asks, so the default configuration binds no port and pays nothing.
   *
   * @returns The listener.
   */
  public webhookListener(): AccessWebhookListener {

    this.#webhookListener ??= new AccessWebhookListener({ log: this.#debugLog, port: this.#webhookPort, signal: this.signal });

    return this.#webhookListener;
  }

  /**
   * The local address a controller at the given host can reach this plugin on.
   *
   * It lives on the platform rather than at each controller's own call site because composing this plugin's reachable address is a deployment decision, and
   * because one named home for the plugin's only outbound network probe is what lets it be substituted rather than reached for.
   *
   * @param host - The controller's configured address.
   *
   * @returns The local address the route toward that controller leaves from.
   */
  public async localAddressFor(host: string): Promise<string> {

    return localAddressFor(host);
  }
}
