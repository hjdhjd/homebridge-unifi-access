/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-device.ts: Base class for all UniFi Access devices.
 */
import { ACCESS_DEVICE_UPDATE_EVENT, ACCESS_WEBHOOK_EVENT_PREFIX } from "./access-events.ts";
import type { API, Characteristic, CharacteristicValue, HAP, WithUUID } from "homebridge";
import type { AccessDevice as AccessDeviceProjection, AccessHub as AccessHubProjection } from "unifi-access";
import type { AccessEventPacket, AccessStateDevice } from "unifi-access";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { TimerRegistry, debugGatedLog, prefixedLog, sanitizeName } from "homebridge-plugin-utils";
import { deviceSerial, serialForm } from "./access-policy.ts";
import type { ACCESS_WEBHOOK_EVENTS } from "./settings.ts";
import type { AccessAccessory } from "./access-types.ts";
import type { AccessController } from "./access-controller.ts";
import type { AccessListener } from "./access-events.ts";
import type { AccessPlatform } from "./access-platform.ts";
import { AccessReservedNames } from "./access-types.ts";
import type { AccessWebhookEvent } from "unifi-access";
import type { DecoratedSerial } from "./access-policy.ts";

/* Device-specific options and settings. What lives here is the user's stated preference, resolved once at configuration time...never a cached reading of what the
 * hardware reports, which every gate derives fresh from the evidence in hand so that a change in what the hardware says reaches the accessory on its own.
 *
 * The side-door pair is the exception the UA Gate earns: that hardware drives two doors, and which of them a hint speaks for is not something a shared reading can
 * express.
 */
// The deliveries this plugin consumes, named by the settings constant so the registration a controller asks for and the handler that receives it agree on the
// vocabulary by construction rather than by two literals happening to match.
export type AccessConsumedWebhookEventName = typeof ACCESS_WEBHOOK_EVENTS[keyof typeof ACCESS_WEBHOOK_EVENTS];

// The delivery a consumed event name carries, extracted from the library's own union so the payload type follows the name with nothing restated here.
export type AccessConsumedWebhookDelivery<K extends AccessConsumedWebhookEventName> = Extract<AccessWebhookEvent, { event: K }>;

export interface AccessHints {

  hasSideDoor: boolean;
  hasWiringSideDoorDps: boolean;
  logDoorbell: boolean;
  logDps: boolean;
  logLock: boolean;
  logRel: boolean;
  logRen: boolean;
  logRex: boolean;
  syncName: boolean;
}

export abstract class AccessBase {

  public readonly api: API;
  protected readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
  public readonly controller: AccessController;
  public readonly platform: AccessPlatform;

  // The constructor initializes key variables and calls configureDevice().
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
     * moment it speaks...an owner consulted before its identity exists resolves at global scope, the only scope that can name it.
     */
    this.log = debugGatedLog(prefixedLog(this.platform.log, () => this.name), () => this.debugEnabled());
  }

  /* Whether this owner's debug lines speak. The base answers at the controller's scope alone, because an owner that is the controller itself has no device identity to
   * resolve against, and a controller-suffixed Log.Debug entry turns on that controller and everything it manages.
   */
  protected debugEnabled(): boolean {

    return this.platform.featureOptions.test("Log.Debug", undefined, this.controller.id);
  }

  /* Configure the device information for HomeKit.
   *
   * The hardware identity arrives as its own argument rather than being read from the record, because the record's identity member is optional and the accessory's
   * is not: an accessory's serial number is frozen at adoption and every cache in the field is keyed by it, so it is the captured identity that belongs here and
   * never whatever the live record happens to carry now.
   */
  protected setInfo(accessory: AccessAccessory, device: AccessStateDevice, mac: string): boolean {

    // Update the manufacturer information for this device.
    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Ubiquiti Inc.");

    // Update the model information for this device. The resolution always answers something a user recognizes, so there is nothing to guard here.
    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model, this.controller.resolveDeviceModel(device));

    // Update the serial number for this device.
    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.SerialNumber, serialForm(mac));

    // Update the firmware revision for this device.
    if(device.firmware) {

      // Capture the version of the device firmware, ensuring we get major, minor, and patch levels if they exist.
      const versionRegex = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(.+))?$/;
      const match: Nullable<(string | undefined)[]> = versionRegex.exec(device.firmware);

      // Update our firmware revision.
      accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision,
        match ? (match[1] ?? "0") + "." + (match[2] ?? "0") + "." + (match[3] ?? "0") : device.firmware);
    }

    return true;
  }

  // Utility function to return the fully enumerated name of this device.
  public get name(): string {

    return this.controller.name;
  }
}

export abstract class AccessDevice extends AccessBase {

  public accessory!: AccessAccessory;
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
  // fields because the library exports the hub view as a type alone, so there is no runtime narrowing from the base handle; adoption is the one place the concrete
  // view is known, and it hands both down.
  protected readonly hubProjection: AccessHubProjection | undefined;
  protected readonly projection: AccessDeviceProjection;
  /* This device's own lifetime, as the composition of the controller's terminal signal with this device's own controller, so plugin shutdown and single-device
   * removal each end it. Public because the controller's own delivery loops address a configured device through its public surface alone.
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

  /* The constructor initializes key variables and calls configureDevice().
   *
   * The admission record is the narrowed record membership admitted this device on, and it exists as an argument of its own because the projection's own record
   * cannot carry that narrowing: the projection reads through to live state, where a record's hardware identity is optional. Adoption is the one moment the
   * identity is established, so it is captured here and never read from the live record again.
   */
  constructor(controller: AccessController, projection: AccessDeviceProjection, accessory: AccessAccessory, admission: AccessStateDevice & { mac: string },
    hubProjection?: AccessHubProjection) {

    // Call the constructor of our base class.
    super(controller);

    this.#deviceController = new AbortController();
    // Every hint at its neutral default, so the object is a complete and honest description of a device nothing has been configured for yet. configureHints() then
    // states each one the user's settings actually decide.
    this.hints = { hasSideDoor: false, hasWiringSideDoorDps: false, logDoorbell: false, logDps: false, logLock: false, logRel: false, logRen: false,
      logRex: false, syncName: false };
    this.hubProjection = hubProjection;
    this.id = deviceSerial(admission);
    this.listeners = new Map();
    this.mac = admission.mac;
    this.projection = projection;
    this.signal = AbortSignal.any([ controller.signal, this.#deviceController.signal ]);
    this.timers = new TimerRegistry({ signal: this.signal });
    this.uda = projection.config;

    // Set the accessory.
    this.accessory = accessory;

    /* Observe our own record and keep everything downstream of it current. The loop is the only writer of uda after construction and the reducer's merge is its only
     * source, so a partial update from either notification dialect lands as a merge rather than as a truncating whole-record assignment.
     *
     * A yield whose record has left the state is skipped in its entirety - no refresh, no characteristic writes, no delivery - so a device inside its removal grace
     * never emits an update about a record that is gone.
     */
    this.controller.spawnLoop(this.name + " updates", async () => {

      for await (const projection of this.projection.observe({ signal: this.signal })) {

        const record = projection.peek();

        if(!record) {

          continue;
        }

        this.uda = record;

        // If we have services on the accessory associated with the Access device that have a StatusActive characteristic set, update our availability state.
        this.updateServices(this.hap.Characteristic.StatusActive, this.isOnline);

        // Sync names, if configured to do so.
        if(this.hints.syncName && this.uda.alias && (this.accessoryName !== sanitizeName(this.uda.alias))) {

          this.log.info("Name change detected. A restart of Homebridge may be needed in order to complete name synchronization with HomeKit.");
          this.configureInfo();
        }

        /* Deliver the update to the accessory's own handlers, post-fold, through the same chokepoint the wire bridge uses. Doing it from here rather than from the raw
         * rail is what guarantees the handler sees the record as the update left it: the raw rail fires before the reducer folds, so a handler reading through to
         * state from there would race the very change it was told about. The two trailing members are what the packet type requires, and both mirror what every
         * captured wire frame carries.
         */
        this.controller.events.emitPacket(this.#updatePacket());
      }
    });
  }

  /* Write a value to every service on this accessory that reports the given characteristic. The one sweep-and-write statement in the plugin: the observe loop above
   * projects availability through it, and a device's own delivery paths project whatever else is a property of the device rather than of one service. Filtering on
   * the characteristic rather than on a service list is what keeps a service added mid-run dressed without anyone maintaining a roster.
   *
   * The parameter is an intersection because the two HAP calls below ask for different halves of the same class: the lookup wants the static UUID and the write
   * wants a zero-argument constructor. A concrete characteristic satisfies both, and naming both is what lets one parameter reach both calls without a cast.
   */
  protected updateServices(characteristic: WithUUID<typeof Characteristic> & (new () => Characteristic), value: CharacteristicValue): void {

    for(const service of this.accessory.services.filter(x => x.testCharacteristic(characteristic))) {

      service.updateCharacteristic(characteristic, value);
    }
  }

  // The update packet this device delivers to its own handlers once its record has folded. The two trailing members are what the packet type requires, and both carry
  // the wire's own values: every captured frame reports an empty receiver and does not save to history.
  #updatePacket(): AccessEventPacket {

    // eslint-disable-next-line camelcase
    return { data: this.uda, event: ACCESS_DEVICE_UPDATE_EVENT, event_object_id: this.uda.unique_id, receiver_id: "", save_to_history: false };
  }

  // Configure device-specific settings.
  protected configureHints(): boolean {

    this.hints.syncName = this.hasFeature("Device.SyncName");

    /* Inform the user if we've opted for something other than the defaults. The shared primitive resolves the option itself and speaks only on a deviation, so it
     * needs no guard of its own...and the scope pair handed to it is the pair every read on this device resolves at, which is what keeps what the user is told
     * and what the plugin does answering one question. The label is a noun phrase because the primitive composes the sentence around it.
     */
    this.platform.featureOptions.logFeature("Device.SyncName", "Device name synchronization", this.log, this.id, this.controller.id);

    return true;
  }

  // Configure the device information details for HomeKit.
  public configureInfo(): boolean {

    // Sync the Access name with HomeKit, if configured.
    if(this.hints.syncName && this.uda.alias) {

      this.accessoryName = this.uda.alias;
    }

    return this.setInfo(this.accessory, this.uda, this.mac);
  }

  // Cleanup our event handlers and any other activities as needed.
  public cleanup(): void {

    for(const [ eventName, handler ] of this.listeners) {

      this.controller.events.off(eventName, handler);
    }

    this.listeners.clear();
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

  // Utility for checking whether a feature option is enabled on a device.
  public hasFeature(option: string): boolean {

    return this.platform.featureOptions.test(option, this.id, this.controller.id);
  }

  // Utility function for reserved identifiers for switches.
  public isReservedName(name: string | undefined): boolean {

    return name === undefined ? false : Object.values(AccessReservedNames).map(x => x.toUpperCase()).includes(name.toUpperCase());
  }

  // Utility function to determine whether or not a device is currently online.
  public get isOnline(): boolean {

    return ([ "is_adopted", "is_connected", "is_managed", "is_online" ] as const).every(key => this.uda[key]);
  }

  /* The name this device's log lines are prefixed with: the device alone, in the form this family of plugins shares. The controller half is left out deliberately -
   * a device line is about the device, and the controller-scoped lines are where the controller names itself.
   */
  public override get name(): string {

    return this.controller.getDeviceName(this.uda);
  }

  /* A device answers at its own identity alongside the controller's, so a Log.Debug entry suffixed with this device turns on its debug lines alone while its siblings
   * stay quiet, and a controller-suffixed entry still reaches it. The device is handed over first because the engine walks the scopes in the order it is given them,
   * and device-before-controller is what lets a device entry outrank the controller entry that would otherwise answer for the whole controller.
   */
  protected override debugEnabled(): boolean {

    return this.platform.featureOptions.test("Log.Debug", this.id, this.controller.id);
  }

  // Utility function to return the current accessory name of this device.
  public get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string | undefined) ??
      this.uda.alias;
  }

  // Utility function to set the current accessory name of this device.
  public set accessoryName(name: string) {

    const cleanedName = sanitizeName(name);

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = cleanedName;
    this.accessory._associatedHAPAccessory.displayName = cleanedName;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, cleanedName);
  }
}
