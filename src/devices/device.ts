/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.ts: Base class for all UniFi Access devices.
 */
import { ACCESS_DEVICE_UPDATE_EVENT, ACCESS_WEBHOOK_EVENT_PREFIX } from "../controller/events.ts";
import type { API, HAP, Service } from "homebridge";
import type { AccessDeviceDisplayName, DecoratedSerial, LogEventName } from "../policy.ts";
import type { AccessDevice as AccessDeviceProjection, AccessEventPacket, AccessHub as AccessHubProjection, AccessStateDevice, AccessWebhookEvent } from "unifi-access";
import type { HomebridgePluginLogging, MqttAvailabilityPayload, MqttConnectHandler, MqttGetHandler, MqttPublishInit, MqttSetHandler, MqttTopicEntry,
  Nullable, ValidServiceOptions, ValidServiceResult } from "homebridge-plugin-utils";
import { MQTT_AVAILABILITY_OFFLINE, MQTT_AVAILABILITY_ONLINE, TimerRegistry, composeSignals, debugGatedLog, mqttTopic, notResponding, ownedName, prefixedLog,
  presenceChanged, resolveNameOverride, setAccessoryName, setServiceName, validService, watchServiceName } from "homebridge-plugin-utils";
import { deviceDisplayName, deviceSerial, recordAvailable, serialForm } from "../policy.ts";
import type { ACCESS_WEBHOOK_EVENTS } from "../settings.ts";
import type { AccessAccessory } from "../types.ts";
import type { AccessController } from "../controller/controller.ts";
import type { AccessListener } from "../controller/events.ts";
import type { AccessPlatform } from "../platform.ts";
import { AccessReservedNames } from "../types.ts";
import { mqttTopics } from "../mqtt.ts";

// The deliveries this plugin consumes, named by the settings constant so the registration a controller asks for and the handler that receives it agree on the
// vocabulary by construction rather than by two literals happening to match.
export type AccessConsumedWebhookEventName = typeof ACCESS_WEBHOOK_EVENTS[keyof typeof ACCESS_WEBHOOK_EVENTS];

// The delivery a consumed event name carries, extracted from unifi-access's own union so the payload type follows the name with nothing restated here.
export type AccessConsumedWebhookDelivery<K extends AccessConsumedWebhookEventName> = Extract<AccessWebhookEvent, { event: K }>;

/* The device-specific options and settings a device holds. What lives here is the user's stated preference, resolved once at configuration time...never a cached
 * reading of what the hardware reports, which every gate derives fresh from the evidence in hand so that a change in what the hardware says reaches the accessory
 * on its own.
 *
 * The side door hint is the exception the UA Gate earns, because that hardware drives two doors: the hint folds the fact that the device is a gate into the user's
 * setting for its second door.
 */
export interface AccessHints {

  hasSideDoor: boolean;
  logEvents: ReadonlySet<LogEventName>;

  /* The custom HomeKit name the user set for this device, trimmed, or null when they set none HomeKit can carry, as homebridge-plugin-utils' custom-name rule
   * decides. It is resolved here once, as every option is, because an option changes only at a restart, so every reader of the name takes the one resolution.
   */
  nameOverride: Nullable<string>;

  /* Whether the plugin owns this device's HomeKit name, as homebridge-plugin-utils' family naming rule decides it from the custom name above and SyncName below: a
   * custom name HomeKit can carry owns it, SyncName on owns it otherwise, and with neither the user does. It is resolved once with the hints it reads, so the
   * accessory and every part named from it follow one answer for the life of the device.
   */
  nameOwned: boolean;
  syncName: boolean;
}

/* The options a part's presence is reconciled with: homebridge-plugin-utils' own validate options, less the accessory this device supplies and the name it composes,
 * with the text the part adds to its device's name in their place. Every other field, its type, and its documentation stay the library's own. A part that declares
 * no suffix is named the device's name itself.
 */
type AccessServiceOptions<T extends Service> = Omit<ValidServiceOptions<T>, "accessory" | "name"> & { readonly suffix?: string };

// A part held to the name the plugin owns for its device: its service, the suffix it adds to the device's name, and the watch that puts the owned name back after a
// rename in the Home app, or null for a kind HomeKit names with Name alone, which the Home app cannot rename.
interface OwnedPart {

  readonly service: Service;
  readonly suffix: string;
  readonly watch: Nullable<Disposable>;
}

// The key a part is held under: its service type and its subtype, where no subtype and an empty one name the same service, as homebridge-plugin-utils' service
// lookup reads them.
function partKey({ UUID, subtype }: { readonly UUID: string; readonly subtype?: string }): string {

  return UUID + " " + (subtype ?? "");
}

export abstract class AccessBase {

  public readonly api: API;
  protected readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
  public readonly controller: AccessController;
  public readonly platform: AccessPlatform;

  // The constructor derives the API and HAP handles, the controller and platform references, and this owner's prefixed, debug-gated logger.
  constructor(controller: AccessController) {

    this.api = controller.platform.api;
    this.hap = this.api.hap;
    this.controller = controller;
    this.platform = controller.platform;

    /* Derive our logger from the platform's. Every level carries this owner's name as a prefix so a line is attributable at a glance, and the debug level is gated at
     * this owner's own scope so what a user asks to hear from one device stays that device's business rather than the whole plugin's.
     *
     * The gate wraps the prefix rather than the other way around, which is what makes a suppressed debug line cost one predicate call and no string composition. The
     * predicate is a closure over this owner's live identity rather than a value read here, so a line always resolves against the identity the owner holds at the
     * moment it speaks.
     */
    this.log = debugGatedLog(prefixedLog(this.platform.log, () => this.name), () => this.debugEnabled());
  }

  // Whether this owner's debug lines speak, which each concrete owner supplies at its own scope.
  protected abstract debugEnabled(): boolean;

  /* Configure the device information for HomeKit.
   *
   * The hardware identity arrives as its own argument rather than being read from the record, because the record's identity member is optional and the accessory's
   * is not: an accessory's serial number is frozen at adoption and every cache in the field is keyed by it, so it is the captured identity that belongs here and
   * never whatever the live record happens to carry now.
   */
  protected setInfo(accessory: AccessAccessory, device: AccessStateDevice, mac: string): boolean {

    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Ubiquiti Inc.");

    // Update the model information for this device. The resolution always answers something a user recognizes, so there is nothing to guard here.
    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model, this.controller.resolveDeviceModel(device));

    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.SerialNumber, serialForm(mac));

    if(device.firmware) {

      // Capture the version of the device firmware, ensuring we get major, minor, and patch levels if they exist.
      const versionRegex = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(.+))?$/;
      const match: Nullable<(string | undefined)[]> = versionRegex.exec(device.firmware);

      accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision,
        match ? (match[1] ?? "0") + "." + (match[2] ?? "0") + "." + (match[3] ?? "0") : device.firmware);
    }

    return true;
  }

  // The name every line this owner logs is prefixed with, which each concrete owner supplies.
  public abstract get name(): string;
}

export abstract class AccessDevice extends AccessBase {

  public accessory!: AccessAccessory;
  /* This device's Not Responding rule, bound once at construction from the availability verdict below and read afresh on every wrapped read and write, so a device the
   * plugin cannot vouch for refuses on the very next request and one that comes back answers on it. Every handler a subclass wires goes through it, which leaves
   * exactly one place that decides whether this device can answer at all, while the MQTT statement and the gate the door commands open with read that same verdict, so
   * what HomeKit is refused, what the broker holds, and what a command refuses on agree by construction. The error class comes from the runtime HAP namespace the plugin
   * holds, because homebridge-plugin-utils carries no HAP dependency of its own.
   */
  protected readonly answering: ReturnType<typeof notResponding>;
  public hints: AccessHints;
  // Every handler this device registered, by the event name it answers to. One map and one cleanup loop serve both the socket's packets and the webhook rail's
  // deliveries, because what teardown owes each of them is identical.
  protected listeners: Map<string, AccessListener>;
  /* This device's identity for everything that addresses it by name: the feature-option scope every read on this device resolves at, the debug gate, the
   * deviation log, and the MQTT topic tail.
   *
   * It is composed once from the admission record, so both halves of it - the hardware serial and an Enterprise port's qualifier - are frozen at adoption exactly
   * as the hardware identity below is, and no read pays for the composition. An identity recomposed from the live record would move under an accessory whose
   * HomeKit identity was frozen at adoption, which is the drift the capture exists to make impossible.
   */
  public readonly id: DecoratedSerial;
  /* This device's hardware identity, captured once from the record that admitted it into HomeKit.
   *
   * The stored record's own identity member is optional - the official API's inventory names a device by an identifier that is not always address-shaped - and the
   * observe loop below reassigns that record on every tick, so an identity re-read from it could move under an accessory whose HomeKit identity was frozen at
   * adoption. Every site that needs the hardware identity reads this captured value instead: the serial number characteristic and the accessory's own context.
   */
  public readonly mac: string;
  // The device's live projection into the client's reduced state, and - for lock-capable hardware - the command-bearing view of the same device. The two are separate
  // fields because unifi-access exports the hub view as a type alone, so there is no runtime narrowing from the base handle; adoption is the one place the concrete
  // view is known, and it hands both down.
  protected readonly hubProjection: AccessHubProjection | undefined;
  protected readonly projection: AccessDeviceProjection;
  /* This device's own lifetime, as the composition of the controller's terminal signal with this device's own controller, so plugin shutdown and single-device
   * removal each end it.
   */
  public readonly signal: AbortSignal;
  /* Every timer this device arms, bound to the lifetime above. cleanup() needs no call of its own: aborting the device controller drains the registry through the
   * composed signal. The same abort makes a later registration inert, which is the behavior we want at teardown...a relock armed by an unlock still in flight when
   * the plugin goes down has nothing left to relock for.
   */
  protected readonly timers: TimerRegistry;
  // The device's own configuration record, refreshed by the observe loop below and by nothing else.
  public uda: AccessStateDevice;
  // The controller half of the composed lifetime above. Aborted by cleanup(), which is what ends this device alone without disturbing its siblings.
  readonly #deviceController: AbortController;
  /* The parts held to the name the plugin owns for this device, keyed by service type and subtype (see #holdPartName). The registry assumes that any kind carrying a
   * subtype-less part beside subtyped ones, as LockMechanism does with the main door's lock beside a UA Gate's side door lock, is a kind HomeKit names with Name
   * alone: homebridge-plugin-utils makes room for a subtype-less service by detaching and re-adding its subtyped siblings, which clears every listener a detached
   * sibling carries, and a sibling of such a kind carries no watch to lose.
   */
  readonly #ownedParts: Map<string, OwnedPart>;

  /* The constructor captures this device's identity, lifetime, and projection, and starts the loop that keeps its record current. A subclass configures itself from
   * its own constructor once this returns.
   *
   * The admission record is the narrowed record membership admitted this device on, and it exists as an argument of its own because the projection's own record
   * cannot carry that narrowing: the projection reads through to live state, where a record's hardware identity is optional. Adoption is the one moment the
   * identity is established, so it is captured here and never read from the live record again.
   */
  constructor(controller: AccessController, projection: AccessDeviceProjection, accessory: AccessAccessory, admission: AccessStateDevice & { mac: string },
    hubProjection?: AccessHubProjection) {

    super(controller);

    this.#deviceController = new AbortController();
    this.#ownedParts = new Map();
    // The predicate closes over this device rather than capturing a value, so every wrapped handler consults the verdict as it stands at that moment.
    this.answering = notResponding({ errorClass: this.hap.HapStatusError, unavailable: () => !this.isAvailable });
    // Every hint at its neutral default, so the object is a complete and honest description of a device nothing has been configured for yet. configureHints() then
    // states each one the user's settings actually decide.
    this.hints = { hasSideDoor: false, logEvents: new Set(), nameOverride: null, nameOwned: false, syncName: false };
    this.hubProjection = hubProjection;
    this.id = deviceSerial(admission);
    this.listeners = new Map();
    this.mac = admission.mac;
    this.projection = projection;
    this.signal = composeSignals(controller.signal, this.#deviceController.signal);
    // Every deadline this device arms reads the platform's clock, so a device timer and a controller timer share one timeline rather than each finding their own.
    this.timers = new TimerRegistry({ clock: this.platform.clock, signal: this.signal });
    this.uda = projection.config;

    this.accessory = accessory;

    /* Register this device's final word, its retained offline, which the client states at plugin shutdown inside its graceful end while the broker session still
     * holds. Once that end begins, the client admits a publish only under the very signal it hands the word, so the word publishes on the client directly under
     * that signal: this device's own publish composes its lifetime into the signal and would be refused, and the controller's chokepoint returns nothing for the
     * end to wait on. The word skips the change gate, because the broker has to hold offline whatever this device last stated, and the publish's promise is
     * returned so the end waits on it within its grace. The registration lives as long as this device does, so a device removed mid-run, whose removal already
     * stated offline, says nothing more at shutdown.
     */
    const mqtt = this.controller.mqtt;

    mqtt?.onEnd(async (signal: AbortSignal): Promise<void> => mqtt.publish(mqttTopic(this.id, mqttTopics.availability.topic), MQTT_AVAILABILITY_OFFLINE,
      { retain: true, signal }), { signal: this.signal });

    /* Observe our own record and keep everything downstream of it current. The loop is the only writer of uda after construction and the reducer's merge is its only
     * source, so a partial update from either notification dialect lands as a merge rather than as a truncating whole-record assignment.
     *
     * A yield whose record has left the state is skipped in its entirety - no statement, no characteristic writes, no delivery - so a device inside its removal grace
     * never emits an update about a record that is gone.
     */
    this.controller.spawnLoop(this.name + " updates", async () => {

      for await (const projection of this.projection.observe({ signal: this.signal })) {

        const record = projection.peek();

        if(!record) {

          continue;
        }

        this.uda = record;

        // State availability on this device's own topic, the one statement of it wherever it is triggered from.
        this.publishAvailability();

        /* Sync the controller's name for this device into HomeKit, if configured to do so. homebridge-plugin-utils writes only the names that differ, the information
         * service's cut to HomeKit's length limit as that service carries them, so a yield whose names all match writes and saves nothing, a name past that limit
         * included. The rename line is logged only when the accessory's display name moved: the plugin alone writes that name and the Home app never touches it, so
         * a move means the controller's name for the device changed. On a yield where the accessory's rename wrote anything, every part held to the owned name
         * follows it to the new name, each written where it differs, and the save that rename marked carries the parts' names with it. A part whose name drifted
         * while the accessory's did not is set right when the device is next adopted, where every part is first held.
         */
        if(this.hints.syncName) {

          const name = this.homeKitName;
          const previousName = this.accessory.displayName;

          if(this.renameAccessory(name)) {

            if(this.accessory.displayName !== previousName) {

              this.log.info("Detected a name change on the controller; updating the HomeKit name to %s.", this.accessory.displayName);
            }

            for(const { service, suffix } of this.#ownedParts.values()) {

              setServiceName(service, name + suffix);
            }
          }
        }

        /* Deliver the update to the accessory's own handlers, post-fold, through the same chokepoint the wire bridge uses. Doing it from here rather than from the raw
         * rail is what guarantees the handler sees the record as the update left it: the raw rail fires before the reducer folds, so a handler reading through to
         * state from there would race the very change it was told about.
         */
        this.controller.events.emitPacket(this.#updatePacket());
      }
    });
  }

  /* State this device's availability on its own topic, read from the same verdict every wrapped handler refuses on, so what HomeKit is refused and what the broker holds
   * cannot disagree. The controller's connection observer calls it whenever the controller's half may have moved and this device's own record loop calls it on every
   * delivery, so every scope the verdict spans reaches the broker through one statement. An outage writes nothing to HomeKit: a refusal is answered on the next read, so
   * nothing here pushes to a service. The statement is retained, so a subscriber attaching mid-session reads the last one without waiting for the next, and it composes
   * with the plugin-level statement the client makes: a device is available only when both read online. A subclass's broker-session restatement opens with it.
   *
   * It is change-gated because the record loop states it on every delivery. The client remembers what it last delivered on the topic and forgets it at every broker
   * session, so a delivery that leaves the verdict where it stood publishes nothing, and the first statement after an outage always goes out. Nothing here keeps a copy
   * of its own, because the client's change gate is what remembers the last statement it delivered.
   */
  public publishAvailability(): void {

    const payload: MqttAvailabilityPayload = this.isAvailable ? MQTT_AVAILABILITY_ONLINE : MQTT_AVAILABILITY_OFFLINE;

    this.mqttPublish(mqttTopics.availability, payload, { ifChanged: true, retain: true });
  }

  /* Refresh whatever per-device state a broken notification stream may have left stale. The controller's connection observer calls this on every completed recovery,
   * because a recovery relaunches the stream without replaying the packets the gap swallowed - so anything a device maintains from that rail may be standing on a
   * reading the controller has since moved past.
   *
   * The base keeps no such state beyond the availability publishAvailability above already restates, and a device class that does keep some overrides this.
   */
  public onConnectionRestored(): void {

    // Deliberately empty rather than unimplemented: there is nothing at this layer the recovery could have staled.
  }

  // The update packet this device delivers to its own handlers once its record has folded. The two trailing members are what the packet type requires, and both carry
  // the wire's own values: every captured frame reports an empty receiver and does not save to history.
  #updatePacket(): AccessEventPacket {

    // eslint-disable-next-line camelcase
    return { data: this.uda, event: ACCESS_DEVICE_UPDATE_EVENT, event_object_id: this.uda.unique_id, receiver_id: "", save_to_history: false };
  }

  // Configure device-specific settings.
  protected configureHints(): boolean {

    const customName = this.getFeatureValue("Device.Name");

    this.hints.nameOverride = resolveNameOverride(customName);
    this.hints.syncName = this.hasFeature("Device.SyncName");

    // Whether the plugin owns this device's name is decided once, through homebridge-plugin-utils' family naming rule over the custom name and SyncName just read.
    // Its fallback is the name the accessory carries, and a fallback never moves whether the rule answers null.
    this.hints.nameOwned = ownedName({ fallback: this.accessoryName, override: this.hints.nameOverride, sync: this.hints.syncName }) !== null;

    /* Inform the user if we've opted for something other than the defaults. homebridge-plugin-utils' logFeature resolves the option itself and speaks only on a
     * deviation, so it needs no guard of its own...and the scope pair handed to it is the pair every read on this device resolves at, which is what keeps what the
     * user is told and what the plugin does answering one question. It writes through the logger of the level that set the option, so a global setting is said once
     * rather than once per device. The label is a noun phrase because logFeature composes the sentence around it.
     */
    this.platform.featureOptions.logFeature({ controller: { id: this.controller.id, log: this.controller.log }, device: { id: this.id, log: this.log },
      label: "Device name synchronization", log: this.platform.log, option: "Device.SyncName" });

    /* The custom name is announced as the name HomeKit carries, as HomeKit's naming rules clean it, rather than through logFeature, which would announce the value
     * as stored. A value HomeKit can carry nothing of is refused by the rule above, and a refusal the user would otherwise never see is said once, here.
     */
    if(this.hints.nameOverride !== null) {

      this.log.info("Custom HomeKit name set to %s.", this.homeKitName);
    } else if(customName?.length) {

      this.log.warn("The custom name \"%s\" leaves nothing HomeKit can display, so it is not applied.", customName);
    }

    return true;
  }

  // Configure the device information details for HomeKit.
  public configureInfo(): boolean {

    /* Name the accessory as HomeKit should carry it while the plugin owns the name, a custom name the user set or name syncing, and hold it there: the information
     * service's watch puts the owned name back the moment the Home app renames the accessory's tile, reading the owned name afresh on each rename, so a controller
     * rename under SyncName reaches the next restore. With neither set the user owns the name, so the accessory keeps the name it carries, a Home app rename
     * included, and nothing watches it. The rename writes only the names that differ, so a steady start writes and saves nothing. This runs once per device object,
     * so the information service carries one watch, which ends with the device's signal; it sits outside the part registry because the information service is never
     * removed while the device stands.
     */
    if(this.hints.nameOwned) {

      this.renameAccessory(this.homeKitName);

      const info = this.accessory.getService(this.hap.Service.AccessoryInformation);

      if(info) {

        watchServiceName({ log: this.log, name: () => this.ownedHomeKitName, service: info, signal: this.signal });
      }
    }

    return this.setInfo(this.accessory, this.uda, this.mac);
  }

  /* Reconcile a part's presence on this device's accessory from one verdict, through homebridge-plugin-utils' gate with the accessory supplied and the part's name
   * composed: a part is created as this device's name as the accessory carries it, followed by the suffix the part declares. The answer is the library's own, so a
   * caller narrows the service from it exactly as it would from the library's. A service the gate attaches or removes changes what Homebridge's accessory cache
   * holds, so the wrapper marks the accessory for the next save, and every answer goes to #holdPartName, which holds the part to the name the plugin owns or lets go
   * of one the verdict removed...every service gate on the accessory passes through here, which is what lets one mark and one hold serve them all, whichever pass
   * runs the gate.
   */
  protected validService<T extends Service>({ suffix = "", ...options }: AccessServiceOptions<T>): ValidServiceResult<T> {

    const validated = validService({ ...options, accessory: this.accessory, name: this.accessoryName + suffix });

    if(presenceChanged(validated.transition)) {

      this.platform.persistence.persist(this.accessory);
    }

    this.#holdPartName({ service: validated.service, serviceType: options.serviceType, subtype: options.subtype, suffix });

    return validated;
  }

  /* Hold a part named from this device to the name the plugin owns, or let go of one a verdict took off the accessory, each time the service gate answers for it.
   * Nothing is held while the user owns the device's name, so with neither a custom name nor SyncName this costs one test of the hint. A held part is renamed to the
   * owned name followed by its suffix when it is first held, marking the accessory for the next save when that wrote anything, and watched so a rename in the Home
   * app is put back at once; a kind HomeKit names with Name alone gives the Home app nothing to rename, so it is renamed and never watched. A reconcile pass that
   * hands back the service already held, the steady state, costs one lookup and writes nothing.
   *
   * An entry ends when a verdict removes its part, when another instance takes its key, and when the device's signal aborts, which ends every watch with the
   * device's retirement, a construction that fails, and the plugin's shutdown. A part leaves the accessory only through the service gate's verdict while the device
   * stands, which is what lets this hold release every watch a removal ends; a removal made anywhere else would leave its watch registered on the device's signal.
   * Ownership and every suffix are fixed for the device, and a controller rename moves only the owned name, which each watch reads afresh and the record loop
   * writes, so no entry needs anything more. An access method switch is held only once the reader's access method model seeds, since no pass reconciles a switch
   * before then, so a switch the accessory was restored with on a reader that never seeds is never held.
   */
  #holdPartName({ service, serviceType, subtype, suffix }: { service: Nullable<Service>; serviceType: { readonly UUID: string }; subtype?: string;
    suffix: string; }): void {

    if(!this.hints.nameOwned) {

      return;
    }

    const key = partKey({ UUID: serviceType.UUID, subtype });
    const held = this.#ownedParts.get(key);

    if(held?.service === service) {

      return;
    }

    held?.watch?.[Symbol.dispose]();

    if(!service) {

      this.#ownedParts.delete(key);

      return;
    }

    if(setServiceName(service, this.homeKitName + suffix)) {

      this.platform.persistence.persist(this.accessory);
    }

    this.#ownedParts.set(key, { service, suffix, watch: service.testCharacteristic(this.hap.Characteristic.ConfiguredName) ?
      watchServiceName({ log: this.log, name: () => this.#ownedPartName(suffix), service, signal: this.signal }) : null });
  }

  // The name the plugin owns for a part named from this device, the owned name followed by the part's suffix, or null while the user owns the device's name.
  #ownedPartName(suffix: string): Nullable<string> {

    const owned = this.ownedHomeKitName;

    return (owned === null) ? null : (owned + suffix);
  }

  // Clean up this device: release its event handlers, state it offline on its availability topic, and end its lifetime, which drains its timers and releases its
  // MQTT registrations.
  public cleanup(): void {

    for(const [ eventName, handler ] of this.listeners) {

      this.controller.events.off(eventName, handler);
    }

    this.listeners.clear();

    /* State offline as this device's last word on its availability topic, before its lifetime ends. The statement is retained, so without it the broker would go on
     * answering online for a device that is gone. It goes through the controller's chokepoint rather than this device's own publish, because a publish bound to a
     * lifetime about to abort is withdrawn with it...the client's own lifetime still governs it, so a plugin shutting down cancels it all the same.
     *
     * It is change-gated like every other availability statement, because only a change-gated publish writes the client's memory of the topic: an ungated offline
     * would leave online remembered there, and the online a device re-adopted under this identity states would find it unchanged and never be sent.
     */
    this.controller.mqttPublish(mqttTopic(this.id, mqttTopics.availability.topic), MQTT_AVAILABILITY_OFFLINE, { ifChanged: true, retain: true });
    this.#deviceController.abort();
  }

  // Register a handler for one of the controller's notification-socket events, storing it for later cleanup. The socket's vocabulary is an open set of dynamic
  // strings - event names, device identities, door identities - so the event stays a plain string here.
  protected registerListener(event: string, handler: (packet: AccessEventPacket) => void): void {

    this.#register(event, handler);
  }

  /* Register a handler for one of the webhook deliveries this plugin consumes.
   *
   * The event name and its payload are linked at the type level, so a handler written for an unlock cannot be registered against a doorbell outcome. That link is
   * affordable here and not on the socket registration above because the delivery vocabulary is a closed set the plugin states for itself, where the socket's is
   * an open one the controller keeps extending.
   *
   * @param event   - Which delivery to listen for.
   * @param handler - The handler, receiving exactly the delivery that name carries.
   */
  protected registerDeliveryListener<K extends AccessConsumedWebhookEventName>(event: K, handler: (delivery: AccessConsumedWebhookDelivery<K>) => void): void {

    this.#register(ACCESS_WEBHOOK_EVENT_PREFIX + event, handler);
  }

  // The one registration statement both kinds of handler pass through: remember it so cleanup can find it, then attach it.
  #register(event: string, handler: AccessListener): void {

    this.listeners.set(event, handler);
    this.controller.events.on(event, handler);
  }

  /* Publish on one of this device's own topics. The identity, the catalog entry, and this device's lifetime meet here and nowhere else, so a publish site names
   * only what it says and on which topic. The lifetime travels as the publish's own signal: a message still in flight when this device is removed is cancelled
   * rather than delivered, and one issued after the removal is refused before it reaches the broker, each at debug, because a removed device has nothing left
   * to announce. The controller's chokepoint is what states whether MQTT is configured at all.
   *
   * A caller's own options - retention and the change gate - travel with the publish, and the lifetime is never one of them: it is this device's, always.
   *
   * @param entry   - The catalog entry naming the topic tail.
   * @param payload - The payload to publish.
   * @param init    - The client's per-publish options other than the signal, which this device supplies.
   */
  protected mqttPublish(entry: MqttTopicEntry, payload: string, init: Omit<MqttPublishInit, "signal"> = {}): void {

    this.controller.mqttPublish(mqttTopic(this.id, entry.topic), payload, { ...init, signal: this.signal });
  }

  /* Register a getter on one of this device's own topics. The topic is composed exactly as mqttPublish composes it, and the registration is bound to this
   * device's lifetime: the client releases the handler when that lifetime ends, and drops the broker subscription where the handler was the last one on its
   * topic, so a device removed mid-run takes its subscriptions with it and one re-adopted under the same identity never answers beside a retired instance.
   * Plugin shutdown ends the client itself, which clears every registration at once. The entry's label is the word the client's own log lines name the value
   * by. The call stays direct on the client rather than going through the controller: registering is synchronous and returns no promise, so there is no outcome
   * for a chokepoint to route.
   *
   * A registration that should end before the device does - a topic answering for a service the record can withdraw - hands its own lifetime, which is composed
   * with the device's so that either end releases it, and the client drops the broker subscription with the last handler on the topic.
   *
   * @param entry    - The catalog entry naming the topic tail and the label.
   * @param getValue - The getter answering the topic's current value.
   * @param lifetime - An optional lifetime shorter than the device's own, for a registration that ends with what it answers for.
   */
  protected mqttSubscribeGet(entry: MqttTopicEntry, getValue: MqttGetHandler, lifetime?: AbortSignal): void {

    this.controller.mqtt?.subscribeGet(mqttTopic(this.id, entry.topic), entry.label, getValue, { signal: composeSignals(this.signal, lifetime) });
  }

  /* Register a setter on one of this device's own topics, composed exactly as the getter above and bound to this device's lifetime, with the same optional
   * shorter lifetime for a registration that ends with what it commands.
   *
   * @param entry    - The catalog entry naming the topic tail and the label.
   * @param setValue - The setter receiving the topic's incoming value.
   * @param lifetime - An optional lifetime shorter than the device's own, for a registration that ends with what it commands.
   */
  protected mqttSubscribeSet(entry: MqttTopicEntry, setValue: MqttSetHandler, lifetime?: AbortSignal): void {

    this.controller.mqtt?.subscribeSet(mqttTopic(this.id, entry.topic), entry.label, setValue, { signal: composeSignals(this.signal, lifetime) });
  }

  /* Register a restatement the client runs each time it establishes a broker session, the first one included, bound to this device's lifetime exactly as the
   * getter above is: the client releases the registration when that lifetime ends, so a device removed mid-run restates nothing on the next session. Nothing is
   * replayed across an outage, so this is where a device says again what it holds. A registration made while a session is already held runs from the next one.
   *
   * @param handler - The restatement to run on each new session.
   */
  protected mqttOnConnect(handler: MqttConnectHandler): void {

    this.controller.mqtt?.onConnect(handler, { signal: this.signal });
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getFloat(option, this.id, this.controller.id);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.id, this.controller.id);
  }

  // Utility function to return a configuration parameter on a device.
  public getFeatureValue(option: string): Nullable<string | undefined> {

    return this.platform.featureOptions.value(option, this.id, this.controller.id);
  }

  /* Utility function to return the values a list-valued configuration parameter selects on a device, read through homebridge-plugin-utils' own list grammar. A
   * domain narrows the read to what this device offers and answers in the domain's own spelling; without one the stored entries answer as the user named them.
   *
   * An option enabled at an explicit scope with nothing stored reads as its registered default rather than as the empty list. That is what a hand-written
   * `Enable.Hub.Sensors.<device>` means - the user turned the list on for that hub and named nothing - and reading it as an empty selection would silently
   * withhold every member. A selection the user emptied on purpose is a different reading and still answers empty.
   */
  public getFeatureValueList(option: string, domain?: readonly string[]): readonly string[] {

    return this.platform.featureOptions.valueList({ controller: this.controller.id, defaultWhenUnset: true, device: this.id, domain, option });
  }

  // Utility for checking whether a feature option is enabled on a device.
  public hasFeature(option: string): boolean {

    return this.platform.featureOptions.test(option, this.id, this.controller.id);
  }

  // Whether a name matches any reserved service subtype, compared case-insensitively.
  public isReservedName(name: string | undefined): boolean {

    return name === undefined ? false : Object.values(AccessReservedNames).map(x => x.toUpperCase()).includes(name.toUpperCase());
  }

  /* Whether the plugin can vouch for this device, composed over the scopes that each gate it. The controller's verdict gates every device at once: an outage freezes a
   * record's flags at whatever they last said, so the record cannot be trusted on its own while the controller is lost. The device's own record gates it from there, and
   * it is read live from the projection rather than from uda, which keeps its last value through a removal delay, so a device whose record has left the state refuses
   * at once. A controller reboot adds no term of its own: the plugin induces none, and one that happens anyway reads as an ordinary loss.
   *
   * This is the plugin's single availability verdict. Every handler answers by it through the rule bound above, and so do the MQTT statement and the gate the door
   * commands open with, so what HomeKit is refused, what the broker holds, and what an operation refuses on answer one question. unifi-access deliberately ships no
   * composition of its own, because last-known device state is all it can honestly own...composing the verdict is the consumer's business, and this is where the
   * consumer does it.
   */
  public get isAvailable(): boolean {

    return this.controller.isAvailable && recordAvailable(this.projection.peek());
  }

  /* The name this device's log lines are prefixed with: the device alone, in the form this family of plugins shares. The controller half is left out deliberately -
   * a device line is about the device, and the controller-scoped lines are where the controller names itself.
   */
  public override get name(): string {

    return this.controller.getDeviceName(this.uda);
  }

  /* A device answers at its own identity alongside the controller's, so a Log.Debug entry suffixed with this device turns on its debug lines alone while its siblings
   * stay quiet, and a controller-suffixed entry still reaches it. The engine always consults the device scope ahead of the controller's, which is what lets a device
   * entry outrank the controller entry that would otherwise answer for the whole controller.
   */
  protected override debugEnabled(): boolean {

    return this.platform.featureOptions.test("Log.Debug", this.id, this.controller.id);
  }

  /* The name the plugin applies to this device's accessory in HomeKit, and the device's own name the rule passed over to reach it, through the one name rule the
   * accessory is minted under, so the mint, every configure pass and the record loop cannot name a device differently. The custom name the user set comes first
   * where HomeKit can carry it, so it holds through a rename on the controller. Adoption reads the whole answer, to tell the user when the controller's name for
   * the device has nothing HomeKit can display.
   */
  protected get homeKitNaming(): AccessDeviceDisplayName {

    return deviceDisplayName(this.uda, { override: this.hints.nameOverride });
  }

  /* The name the plugin applies to this device's accessory in HomeKit. It is the name to apply rather than the name HomeKit carries, which accessoryName below
   * reads: with neither a custom name nor name synchronization in force nothing applies this one, so the two part once the controller's name for the device moves
   * on, or a custom name is cleared. The rule always answers a name HomeKit can carry, so homebridge-plugin-utils never refuses the write, and a refused write can
   * never read as a change on every update.
   */
  protected get homeKitName(): string {

    return this.homeKitNaming.name;
  }

  // The name the plugin owns for this device's accessory, or null while the user owns it: homeKitName above while the nameOwned hint holds. Every holder of an owned
  // name reads this afresh on each rename it puts back, so a controller rename under SyncName reaches the next restore.
  protected get ownedHomeKitName(): Nullable<string> {

    return this.hints.nameOwned ? this.homeKitName : null;
  }

  // Utility function to return the current accessory name of this device: the name HomeKit carries, where homeKitName above is the name the plugin applies. The
  // information service's Name characteristic is the primary source and is always present, and the name the plugin applies stands in where it is not.
  public get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string | undefined) ??
      this.homeKitName;
  }

  /* Apply a name to this device's accessory, answering whether anything was written. homebridge-plugin-utils owns every write a rename reaches: both display names
   * through Homebridge's own setter, and the information service's configured name beside its name through the per-service rule, each only where it differs. A
   * name with nothing left once HomeKit's naming rules are applied is refused rather than applied blank. A rename that wrote anything changed what Homebridge's
   * accessory cache holds, so the accessory is marked for the next save.
   */
  protected renameAccessory(name: string): boolean {

    if(!setAccessoryName(this.accessory, name)) {

      return false;
    }

    this.platform.persistence.persist(this.accessory);

    return true;
  }
}
