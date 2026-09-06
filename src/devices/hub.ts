/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hub.ts: Unified hub and reader device class for UniFi Access.
 */
import { ACCESS_API_PATH_PREFIX, AccessCapabilityError, AccessClient, isHub, isReader, isTamperCapable, tamperState } from "unifi-access";
import { ACCESS_UNLOCK_ACTOR, ACCESS_WEBHOOK_EVENTS } from "../settings.ts";
import type { AccessConsumedWebhookDelivery, AccessHints } from "./device.ts";
import type { AccessDevice as AccessDeviceProjection, AccessDoorStateEntry, AccessEventPacket, AccessHub as AccessHubProjection, AccessStateDevice,
  AccessStateDoor, OfficialApi } from "unifi-access";
import type { AccessMethodKey, DoorServiceType } from "../policy.ts";
import type { CharacteristicValue, Service } from "homebridge";
import type { MqttTopicEntry, Nullable } from "homebridge-plugin-utils";
import { accessMethodChoices, accessMethodValuesFromConfigRows, accessMethodValuesFromOfficialSettings, accessMethodWriteFollowup, accessMethodWriteVerdict,
  accessMethods, composeAccessMethodUpdate, describeUnlock, deviceHasCapability, discoverDoorLocations, doorbellOutcome, doorbellReaderId, doorbellRingAllowed,
  doorbellTriggerAction, dpsSensorEligible, lockCommandRule, resolveDoorService, ultraInputMode, unlockAttribution } from "../policy.ts";
import { acquireService, capabilityGate, formatErrorMessage, guardedDispatch, updateServices, validService } from "homebridge-plugin-utils";
import { ACCESS_DEVICE_UPDATE_EVENT } from "../controller/events.ts";
import type { AccessAccessory } from "../types.ts";
import type { AccessController } from "../controller/controller.ts";
import { AccessDevice } from "./device.ts";
import { AccessReservedNames } from "../types.ts";
import { mqttTopics } from "../mqtt.ts";

// Device types that use the /configs API endpoint instead of /settings for access method changes.
const configsApiDeviceTypes = ["UVC G6 Entry"];

/* The access method state a reader's switches read, one model per device serving both client identities. The values map is keyed by the catalog's configs
 * vocabulary and holds whether each method is enabled. Seeding is what gates switch existence: an unseeded device keeps whatever services it has and creates
 * none, because absence of knowledge is not knowledge of absence, while a seeded device creates and retires switches from what the model actually holds.
 */
type AccessMethodState = { readonly phase: "seeding" } | { readonly phase: "seeded"; readonly values: Map<AccessMethodKey, boolean> } |
  { readonly phase: "unseeded" };

// The one unseeded state every initialization and reset shares. A transition always replaces the whole field and no site mutates this object, so one instance
// serves every device.
const ACCESS_METHOD_UNSEEDED: AccessMethodState = { phase: "unseeded" };

/* Access v2 event data so that we can detect access method changes. The library's dialect translation keeps access_method off the canonical record payload by
 * design - the field has no bootstrap counterpart to reconcile against - so the raw packet rail is the designed consumption path and this local type is the honest
 * read of it. The values are typed as plain strings because the wire carries more than the "yes"/"no" pair (key names echoed back as values, among others), and
 * the handler's own explicit value filter is what makes the loose cast safe.
 */
interface AccessEventDeviceUpdateV2 {

  access_method?: Partial<Record<AccessMethodKey, string>>;
}

/* The dry contact inputs that share one shape: a wiring-evidence gate, a state reading taken from one table, and an MQTT tail of their own. Each input's
 * HomeKit-facing name and the catalog entry its MQTT topic tail comes from sit here together, so that configuration and live updates cannot drift on either. The
 * entry is named rather than its tail spelled, so the catalog stays the one place a topic is written. The label is carried in the title case a service name wants;
 * the log lines derive the other casings they need from it, so each input is spelled here exactly once.
 *
 * The door position sensor is deliberately not one of them. All three of the things that shape a terminal input differ for it - where its eligibility comes from,
 * where its state comes from, and how it reaches HomeKit - so it is configured and updated on its own rather than forced through a loop that would have to special
 * case it at every step.
 */
const terminalInputs = [

  { input: "Rel", label: "Remote Release", topic: mqttTopics.rel },
  { input: "Ren", label: "Request to Enter Sensor", topic: mqttTopics.ren },
  { input: "Rex", label: "Request to Exit Sensor", topic: mqttTopics.rex }
] as const satisfies readonly { input: string; label: string; topic: MqttTopicEntry }[];

// The inputs themselves, derived from the table so the names are spelled in one place and every table keyed by them stays complete.
type SensorInput = typeof terminalInputs[number]["input"];

// The HomeKit-facing name of the door position sensor. It sits beside the table above rather than in it, because everything else about it diverges.
const DPS_LABEL = "Door Position Sensor";

// An input label as a sentence opens it: the first word's capital kept and the rest lowered. This is what lets one spelling in the table above serve a service name,
// a mid-sentence mention, and a sentence-leading one.
function sentenceCase(label: string): string {

  return label.charAt(0) + label.slice(1).toLowerCase();
}

// Define the sensor wiring - the per-model wiring-key pairs whose live circuit detection says an input is actually connected. The per-device-type inconsistency is
// the controller's own; a model naming no pair for an input simply offers no wiring evidence about it.
const sensorWiring: Record<SensorInput, Record<string, string[]>> = {

  Rel: {

    UAH: [ "wiring_state_rel-neg", "wiring_state_rel-pos" ]
  },
  Ren: {

    UAH: [ "wiring_state_ren-neg", "wiring_state_ren-pos" ]
  },
  Rex: {

    "UA-Hub-Door-Mini": [ "wiring_state_d1-button-neg", "wiring_state_d1-button-pos" ],
    UAH: [ "wiring_state_rex-neg", "wiring_state_rex-pos" ]
  }
};

// The configuration row each model reports an input's live reading under. The per-device-type inconsistency is the controller's own, exactly as it is for the wiring
// table above, and a model naming no row for an input simply offers no reading of it.
const sensorStateRows: Record<SensorInput, Record<string, string>> = {

  Rel: {

    UAH: "input_state_rel"
  },
  Ren: {

    UAH: "input_state_ren"
  },
  Rex: {

    "UA-Hub-Door-Mini": "input_d1_button",
    "UA-ULTRA": "input_d1_button",
    UAH: "input_state_rex"
  }
};

// The hint that says whether an input's readings are announced in the log, named from the same input list the tables above are keyed by so a new input cannot be
// added without a hint to go with it.
type LogHintKey = Extract<keyof AccessHints, `log${SensorInput}`>;

/* A garage door's travel while it is running: the direction it is moving in, or the halt that interrupted one. A halt remembers the travel it interrupted, because
 * a single-trigger operator resumes the opposite direction on its next operation whichever direction HomeKit asked for.
 */
type DoorTravel = { phase: "opening" | "closing" } | { lastDirection: "opening" | "closing"; phase: "stopped" };

// Where a garage door stands: still, or running one of the travels above.
type DoorTransition = { phase: "idle" } | DoorTravel;

/* What a door command needs before it can dispatch: the verb its lines name, the door as the user hears it, and the control surface the command goes through.
 * Carrying the surface here is what makes it non-optional where the command dispatches, so a command body cannot express a state the preamble already refused.
 * A gate's commands address a door by identity as well, which the gate form adds, so a gate path receives that identity by type and re-checks nothing.
 */
interface DoorCommandTarget { action: string; doorName: string; hub: AccessHubProjection }
interface GateDoorTarget extends DoorCommandTarget { doorId: string }

/* One door this hub drives: the identity the client's door-state map keys its reading by, and whether it is the side door of a UA Gate. Carrying the two together
 * is what lets one enumeration answer for hardware that drives a single door and for hardware that drives two, so every reader takes the side-door question from
 * the same place it took the identity.
 */
interface DrivenDoor { isSideDoor: boolean; locationId: string }

// Constants for timing.
const AUTO_LOCK_DELAY_MS = 5000;
// How long we wait before putting a characteristic back after the command behind it was refused. The pause lets HomeKit's own write settle first, so the controller
// sees the correction as a fresh value rather than as a race against the write it just made.
const CHARACTERISTIC_REVERT_DELAY_MS = 50;
// How long a dispatched doorbell ring or cancel waits before settling the trigger switch back onto the mirrored ring state: long enough for the controller's own
// ring notification to arrive and win, short enough that a ring the notification stream never confirms is corrected while the user is still looking at the switch.
const DOORBELL_TRIGGER_RECONCILE_DELAY_MS = 5000;
// How long a UA Gate is given to travel when no duration has been configured for it. A gate's motion is short and much the same from one installation to the next,
// where a garage door's travel time varies with the door, so a default serves the one and not the other.
const GATE_TRANSITION_DURATION_MS = 5000;
// The key the main door's transition timer is tracked under. It is stated once so the arm, the re-arm, and the cancel can never name different timers.
const DOOR_TRANSITION_TIMER_KEY = "door-transition";

export class AccessHub extends AccessDevice {

  private _hkDpsState: CharacteristicValue;
  private _hkLockState: CharacteristicValue;
  private _hkSideDoorDpsState: CharacteristicValue;
  private _hkSideDoorLockState: CharacteristicValue;
  private readonly doorbellGuardFilter: readonly string[];
  private doorbellRingRequestId: string | null;
  private lockDelayInterval: number | undefined;
  private mainDoorLocationId: string | undefined;
  private sideDoorLocationId: string | undefined;
  // The tamper reading we last projected, or undefined until the record has told us anything. Holding it is what lets a genuine change be told from a first sighting.
  private tamperVerdict: boolean | undefined;
  /* Whether an access method refresh is still out. It bounds the refresh to one in flight per device and is read nowhere else: the seed gets its launch-exactly-once
   * from its own phase transition, and a refresh running over an already-seeded model has no such transition to lean on.
   */
  #accessMethodRefreshInFlight: boolean;
  // What we know about this device's access methods, and the gate every switch's existence and every switch's reading run through.
  #accessMethodState: AccessMethodState;
  // Whether a door-state delivery is still applying its readings, which is what holds the opener's own update until both of them have landed.
  #doorStateApplying: boolean;
  // Where the main door's travel stands. Only the main door has an opener, so only the main door runs a machine.
  #doorTransition: DoorTransition;
  // The access method values the last applied configuration-row fold produced, or undefined until one has applied. Holding it is what lets a record restating
  // rows we have already folded be told from one carrying news.
  #foldedConfigValues: Map<AccessMethodKey, boolean> | undefined;

  // Create an instance.
  constructor(controller: AccessController, projection: AccessDeviceProjection, accessory: AccessAccessory, admission: AccessStateDevice & { mac: string },
    hubProjection?: AccessHubProjection) {

    super(controller, projection, accessory, admission, hubProjection);

    // The neutral readings a door is assumed to hold before anything has been heard about it. configureDevice() settles them from what the controller has actually
    // established, so the assumption never has to be restated anywhere else.
    this._hkDpsState = this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    this._hkLockState = this.hubLockState;
    this._hkSideDoorDpsState = this.hubSideDoorDpsState;
    this._hkSideDoorLockState = this.hubSideDoorLockState;
    this.doorbellGuardFilter = this.getFeatureValueList("Hub.Doorbell.DoorGuards");
    this.lockDelayInterval = this.getFeatureNumber("Hub.LockDelayInterval") ?? undefined;
    this.mainDoorLocationId = undefined;
    this.sideDoorLocationId = undefined;
    this.doorbellRingRequestId = null;
    this.tamperVerdict = undefined;
    // Nothing has been heard about this device's access methods yet, which configureDevice() settles below from whichever rail can answer for it, and no refresh has
    // been asked for.
    this.#accessMethodRefreshInFlight = false;
    this.#accessMethodState = ACCESS_METHOD_UNSEEDED;
    // A door we have not been asked to move is standing still, which is the only honest reading before anything has been commanded.
    this.#doorStateApplying = false;
    this.#doorTransition = { phase: "idle" };
    this.#foldedConfigValues = undefined;

    // If we attempt to set the delay interval to something invalid, then assume we are using the default unlock behavior.
    if((this.lockDelayInterval !== undefined) && (this.lockDelayInterval < 0)) {

      this.lockDelayInterval = undefined;
    }

    this.configureHints();
    this.configureDevice();
  }

  // Configure device-specific settings for this device.
  protected override configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    this.hints.hasSideDoor = (this.uda.device_type === "UGT") && this.hasFeature("Hub.SideDoor");
    this.hints.hasWiringSideDoorDps = this.hints.hasSideDoor && this.hasFeature("Hub.SideDoor.DPS");
    this.hints.logDoorbell = this.hasFeature("Log.Doorbell");
    this.hints.logDps = this.hasFeature("Log.DPS");
    this.hints.logLock = this.hasFeature("Log.Lock");
    this.hints.logRel = this.hasFeature("Log.REL");
    this.hints.logRen = this.hasFeature("Log.REN");
    this.hints.logRex = this.hasFeature("Log.REX");

    return true;
  }

  // The HomeKit service the door is presented through, resolved from the configured choice against this hub's hardware on every read.
  private get doorServiceType(): DoorServiceType {

    return resolveDoorService({ choice: this.getFeatureValue("Hub.Door.Service"), deviceType: this.uda.device_type });
  }

  // Convert lock string value to HomeKit LockCurrentState. The parameter is a plain string because the door state map's own vocabulary is deliberately open, and this
  // is already total over anything it can carry: a value we don't recognize falls through to secured, which is the safe reading of an unknown lock.
  private toLockState(lockValue: string): CharacteristicValue {

    return [ "unlock", "unlocked" ].includes(lockValue) ? this.hap.Characteristic.LockCurrentState.UNSECURED : this.hap.Characteristic.LockCurrentState.SECURED;
  }

  // Convert DPS string value to HomeKit ContactSensorState. Total over any vocabulary for the same reason toLockState is, falling through to contact detected.
  private toDpsState(dpsValue: string): CharacteristicValue {

    return dpsValue === "open" ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  // Check if a lock state represents "locked".
  private isLocked(state: CharacteristicValue): boolean {

    return state === this.hap.Characteristic.LockCurrentState.SECURED;
  }

  // Check if a DPS state represents "closed" (contact detected).
  private isClosed(state: CharacteristicValue): boolean {

    return state === this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  // Discover main and side door location IDs for UA Gate hubs. This allows us to receive remote_unlock events for each door. The heuristic itself is the policy
  // module's shared statement; this method binds it to the live topology snapshot, gates the side arm on the user's side-door preference, and seeds the door
  // states behind the result.
  private discoverDoorIds(): void {

    const doors: AccessStateDoor[] = [...this.controller.client.state.snapshot().doors.values()];

    if(doors.length === 0) {

      this.log.warn("No doors found in Access API. Door event handling may not work correctly.");

      return;
    }

    const discovered = discoverDoorLocations({ device: this.uda, doors: doors, sideDoorEligible: this.hints.hasSideDoor });

    this.mainDoorLocationId = discovered.mainDoorLocationId;
    this.sideDoorLocationId = discovered.sideDoorLocationId;

    // Initialize door states from what the controller has already told us about each door.
    this.initializeDoorStates();
  }

  /* Seed our door states from the client's door state map, which every connect mode populates. The door topology records carry no status of their own - position and
   * lock live in the door state map, keyed by the door's own identity - so this is where the answer is. A door the controller has said nothing about, or one whose
   * entry is silent on a member, falls back to closed and secured, which is what we have always assumed before hearing otherwise.
   *
   * Every seed here reaches HomeKit rather than the backing field alone. This runs after the services are configured, and the relay rows they were built from can
   * disagree with what the door state map says - so a characteristic left holding the record's reading would render a stale door until that door next moved. The
   * locks go through their setters, whose early return on an agreeing reading makes the two sources agreeing cost nothing; the side door's position has no accessor pair,
   * so it takes the file's own idiom for that field - the assignment followed by an explicit push. Adoption stays silent throughout, with no MQTT tail and no log
   * line, because a reading we are seeing for the first time is not a transition anyone observed.
   */
  private initializeDoorStates(): void {

    // Find and initialize main door state.
    if(this.mainDoorLocationId) {

      const mainDoor = this.#doorEntry(this.mainDoorLocationId);

      this.hkDpsState = this.toDpsState(mainDoor?.dps ?? "close");
      this.hkLockState = this.toLockState(mainDoor?.lock ?? "lock");

      // Update the door service.
      if(this.doorServiceType === "GarageDoorOpener") {

        this.updateDoorServiceState(false);
      }
    }

    // Find and initialize side door state.
    if(this.sideDoorLocationId) {

      const sideDoor = this.#doorEntry(this.sideDoorLocationId);

      this._hkSideDoorDpsState = this.toDpsState(sideDoor?.dps ?? "close");
      this.setContactSensorState(AccessReservedNames.CONTACT_DPS_SIDE, this._hkSideDoorDpsState);
      this.hkSideDoorLockState = this.toLockState(sideDoor?.lock ?? "lock");
    }
  }

  // Initialize and configure the light accessory for HomeKit.
  private configureDevice(): boolean {

    this._hkLockState = this.hubLockState;
    this._hkSideDoorDpsState = this.hubSideDoorDpsState;
    this._hkSideDoorLockState = this.hubSideDoorLockState;

    /* Seed our door state from what the controller has established about the door we drive, before any service is configured against it. A door the controller has
     * said nothing about, or one whose entry is silent on a member, falls back to closed and secured...what we have always assumed before hearing otherwise. This
     * is the one place that assumption is spelled out for a single-door hub.
     *
     * A UA Gate seeds through initializeDoorStates instead, from each of the two doors it drives.
     */
    if(this.uda.device_type !== "UGT") {

      const entry = this.#doorStateEntry;

      this._hkDpsState = this.toDpsState(entry?.dps ?? "close");
      this._hkLockState = this.toLockState(entry?.lock ?? "lock");
    }

    /* Adopt whatever tamper reading our record arrived with, once, before any sensor is configured against it. Adoption is silent: a reading we are seeing for the
     * first time is not a transition anyone observed. This is deliberately the only place the record is consulted for a baseline - the configure blocks below read
     * the field rather than the record, so their re-runs on each delivered update cannot re-seed it and mask a genuine change.
     */
    this.tamperVerdict = isTamperCapable(this.uda) ? tamperState(this.uda) : undefined;

    /* Clean out the context object in case it's been polluted somehow, then record what an accessory carries for the life of the pairing: the hardware it names,
     * the controller that created it, and the device identity it was minted under - the last being what tells a startup sweep that this accessory is the
     * identity's own rather than one created under an earlier form.
     */
    this.accessory.context = {};
    this.accessory.context.controller = this.controller.ownershipKey;
    this.accessory.context.id = this.id;
    this.accessory.context.mac = this.mac;

    // A door left on the default relock behavior is not a choice the user made, so it is said at debug level. A configured interval is a deviation, and says so.
    if(this.lockDelayInterval === undefined) {

      this.log.debug("The door lock relay will lock five seconds after unlocking in HomeKit.");
    } else {

      this.log.info("The door lock relay will remain unlocked %s after unlocking in HomeKit.",
        this.lockDelayInterval === 0 ? "indefinitely" : "for " + this.lockDelayInterval.toString() + " minutes");
    }

    if(this.hints.hasSideDoor) {

      if(this.lockDelayInterval === undefined) {

        this.log.debug("The side door lock relay will lock five seconds after unlocking in HomeKit.");
      } else {

        this.log.info("The side door lock relay will remain unlocked %s after unlocking in HomeKit.",
          this.lockDelayInterval === 0 ? "indefinitely" : "for " + this.lockDelayInterval.toString() + " minutes");
      }
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure access method switches, if we're a reader device.
    this.configureAccessMethodSwitches();

    // Configure the sensors connected to terminal inputs. This must be done before configuring the lock so that the DPS contact sensor exists when configuring a
    // GarageDoorOpener service, which derives its state from the DPS sensor.
    this.configureTerminalInputs();
    this.configureSideDoorTerminalInputs();

    // Configure the lock, if we're a hub device.
    this.configureLock();
    this.configureLockTrigger();

    // Configure the side door lock, if we're a UA Gate device.
    this.configureSideDoorLock();
    this.configureSideDoorLockTrigger();

    // Configure the doorbell, if we have one.
    this.configureDoorbell();
    this.configureDoorbellTrigger();

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    const handler = this.eventHandler.bind(this);

    this.registerListener(this.uda.unique_id, handler);
    this.registerListener("access.remote_view", handler);
    this.registerListener("access.remote_view.change", handler);

    // Listen for the two webhook deliveries this plugin consumes. They go through their own rail rather than the packet handler above, because a delivery and a socket
    // frame of the same name carry entirely different payloads.
    this.registerDeliveryListener(ACCESS_WEBHOOK_EVENTS.doorUnlock, (delivery) => this.handleUnlockDelivery(delivery));
    this.registerDeliveryListener(ACCESS_WEBHOOK_EVENTS.doorbellCompleted, (delivery) => this.handleDoorbellOutcome(delivery));

    // For UA Gate hubs, we discover door IDs and subscribe to their events. This is needed because remote_unlock events use the door's location_id as the
    // event_object_id, not the hub's device_id.
    if(this.uda.device_type === "UGT") {

      this.discoverDoorIds();

      // Subscribe to events for both doors.
      if(this.mainDoorLocationId) {

        this.registerListener(this.mainDoorLocationId, handler);
      }

      if(this.sideDoorLocationId) {

        this.registerListener(this.sideDoorLocationId, handler);
      }
    }

    return true;
  }

  // Configure the access method switches for HomeKit.
  private configureAccessMethodSwitches(): boolean {

    /* Switches are created and retired from what we actually know about this device's access methods, and never from what we have yet to hear. A record carrying
     * configuration rows answers synchronously, right here; a record carrying none is answered by the official settings read the dispatch below launches. Until one
     * of them has landed, every service the accessory already carries is left exactly as it is and none is created - absence of knowledge is not knowledge of
     * absence, and retiring a switch on a start where the read failed would take the automations behind it with it.
     */
    this.#foldConfigRows();

    if(this.#accessMethodState.phase !== "seeded") {

      this.#dispatchAccessMethodSeed();

      return true;
    }

    // The methods the user selected switches for, read afresh on every pass so a changed selection is what the next pass materializes or retires, and read
    // against the catalog's own spellings so a hand-written entry selects a method in whatever case it named it.
    const selected = this.getFeatureValueList("AccessMethod.Switches", accessMethodChoices().map(choice => choice.value));

    for(const accessMethod of accessMethods) {

      // Validate whether we should have this service enabled.
      if(!validService(this.accessory, this.hap.Service.Switch,
        isReader(this.uda) && this.hasCapability(accessMethod.capability) && selected.includes(accessMethod.choice), accessMethod.subtype)) {

        continue;
      }

      // Acquire the service.
      const service = acquireService(this.accessory, this.hap.Service.Switch, this.accessoryName + " " + accessMethod.name, accessMethod.subtype);

      if(!service) {

        this.log.error("Unable to add the %s access method switch.", accessMethod.name);

        continue;
      }

      // Retrieve the state when requested.
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.#accessMethodEnabled(accessMethod.key));

      // Set the state when requested. Writes route official-first with a read-back for certainty; reads answer from the access method state model, which the
      // record's configuration rows, the official settings read, and the v2 access method events each feed.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        const enabled = value === true;
        const official = this.controller.client.official;

        // This gate is what narrows the nullable reference for the parameter pass below...a narrowing cannot cross a method boundary, so the method takes it
        // already narrowed.
        if(official) {

          const verdict = await this.#writeAccessMethodOfficial(official, accessMethod, enabled);

          switch(accessMethodWriteFollowup({ transport: this.controller.client.transport !== null, verdict })) {

            case "complete":

              /* The switch already carries the value HomeKit wrote, and the model takes it too: a confirmed write is the freshest thing anyone knows about the
               * method, so a read arriving before the controller's own echo answers what the controller confirmed rather than the rows it has yet to restate. The
               * v2 access method events and the record rail keep the model current from there.
               */
              this.#foldMethodValue(accessMethod.key, enabled);

              return;

            case "decline":

              // The controller answered success while leaving the setting unchanged, which only the read-back can reveal. It answered and refused, so the raw
              // endpoint is not asked to second-guess it, and the switch reverts to the truth the read-back showed.
              this.log.error("The controller declined the %s access method change.", accessMethod.name);
              this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !enabled), CHARACTERISTIC_REVERT_DELAY_MS);

              return;

            case "fallback":

              // A thrown official error keeps controllers without the official settings surface working, and an absent verdict covers a method the official map
              // cannot see on this device while the raw endpoint still can.
              if(await this.#writeAccessMethodRaw(accessMethod, enabled)) {

                this.#foldMethodValue(accessMethod.key, enabled);

                return;
              }

              break;

            case "revert":

              // No path can carry the write, so the generic tail below surfaces the failure and puts the switch back.
              break;
          }
        } else if(this.controller.client.transport) {

          // Without an official path, the raw credential write carries the change on its own.
          if(await this.#writeAccessMethodRaw(accessMethod, enabled)) {

            this.#foldMethodValue(accessMethod.key, enabled);

            return;
          }
        } else {

          // This arm is type-totality rather than a served population: a connected client holds the official surface, a credential transport, or both. Both
          // getters are nullable by type, and the flow must be total over them.
          this.log.error("Changing an access method requires the official Access API or UniFi Access controller credentials.");
          this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !enabled), CHARACTERISTIC_REVERT_DELAY_MS);

          return;
        }

        // Nothing carried the write, so we surface the failure and revert our switch state.
        this.log.error("Unable to %s the %s access method.", enabled ? "activate" : "deactivate", accessMethod.name);
        this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !enabled), CHARACTERISTIC_REVERT_DELAY_MS);
      });

      // Initialize the switch from the same model its reads answer from, so what HomeKit is handed and what the handler would answer agree from the first pass.
      service.updateCharacteristic(this.hap.Characteristic.On, this.#accessMethodEnabled(accessMethod.key));
    }

    return true;
  }

  // Whether a method reads on. A model nothing has seeded answers off for every method, which is the same answer a seeded model gives for a method it holds no
  // entry for - a capability-gated method the device's own configuration never mentioned.
  #accessMethodEnabled(key: AccessMethodKey): boolean {

    const state = this.#accessMethodState;

    return (state.phase === "seeded") && (state.values.get(key) === true);
  }

  /* Fold the record's own configuration rows into the model, replacing it wholesale rather than merging it: a row the record has dropped must leave no entry
   * standing, exactly as the live row read this replaces would have answered off for it.
   *
   * The memo is what makes two writers of one model safe. A delivery whose rows translate to what the last applied fold already produced carries no access method
   * news, so it changes nothing, and the fresher knowledge the packet and write folds have put in the model survives it. The comparison is by value rather than by
   * array identity because the record's configs array offers no identity worth trusting: the periodic bootstrap refresh mints a fresh array on every tick an
   * unrelated field moved, and a websocket delta replaces it atomically whenever a terminal input row changes, since the access method rows share the one flat
   * array with them. What the memo holds is a copy rather than the model's own map, because the packet and write folds write into that map...a memo pointing at it
   * would absorb their writes and then read the next stale restatement as news, reverting the very value the memo exists to protect.
   */
  #foldConfigRows(): void {

    const rows = this.uda.configs;

    if(rows === undefined) {

      return;
    }

    const values = accessMethodValuesFromConfigRows({ methods: accessMethods, rows });

    if(this.#configRowsRestated(values)) {

      return;
    }

    this.#accessMethodState = { phase: "seeded", values };
    this.#foldedConfigValues = new Map(values);
  }

  // Whether a fresh translation of the configuration rows says anything the last applied fold did not. Equal is the same size and every entry matching, and it is
  // the size half that makes a row the record has dropped read as news rather than as a match.
  #configRowsRestated(values: ReadonlyMap<AccessMethodKey, boolean>): boolean {

    const memo = this.#foldedConfigValues;

    if(memo?.size !== values.size) {

      return false;
    }

    for(const [ key, value ] of values) {

      if(memo.get(key) !== value) {

        return false;
      }
    }

    return true;
  }

  // Fold one method's value into the model. A model nothing has seeded is left alone: one reading is not the whole truth, and the settings read its caller
  // triggers instead answers with all of it.
  #foldMethodValue(key: AccessMethodKey, enabled: boolean): void {

    const state = this.#accessMethodState;

    if(state.phase !== "seeded") {

      return;
    }

    state.values.set(key, enabled);
  }

  /* Launch the official settings read that seeds a device the record rail says nothing about, and launch it exactly once. Only an unseeded phase dispatches, and
   * the transition into seeding happens here, synchronously, ahead of any async work - so a burst of access method packets arriving while the read is in flight
   * finds a model that is already seeding and asks for nothing more. Only readers carry switches, so a plain hub never fetches settings it would project nowhere,
   * nor warns about them. Every caller folds the record's rows first, so an unseeded phase at this refusal already means a record that carried none.
   */
  #dispatchAccessMethodSeed(): void {

    const official = this.controller.client.official;

    if((this.#accessMethodState.phase !== "unseeded") || !official || !isReader(this.uda)) {

      return;
    }

    this.#accessMethodState = { phase: "seeding" };

    guardedDispatch({ handler: async (): Promise<void> => this.#seedAccessMethodState(), label: "access method seeding", log: this.log });
  }

  /* Read this device's access methods from the official settings surface and seed the model with them, which is what gives a reader on a token-only controller its
   * switches: no configuration rows reach us for it, and this read is the only other place that truth lives.
   *
   * Every write to the model is made only while the phase is still the seeding this dispatch started, because a faster path may have seeded it meanwhile - a record
   * that gained its rows mid-read is the device's own authority on them - so a slower answer never overwrites it and a failure never knocks it back to unseeded.
   * A failure creates nothing and retires nothing: we create on data and remove on data, and a controller that did not answer is neither.
   */
  async #seedAccessMethodState(): Promise<void> {

    try {

      const values = await this.#fetchAccessMethodValues();

      /* A client holding no official surface answers undefined here, and that is what keeps this method total on its own: a client that lost that surface between the
       * dispatch and this point simply has nothing to read, and the model goes back to unseeded for the next trigger to try again. It exits this way rather than
       * through the catch below, which belongs to a read that was actually attempted and refused.
       */
      if(!values) {

        this.#unseedOwnedSeeding();

        return;
      }

      if(this.#accessMethodState.phase === "seeding") {

        this.#accessMethodState = { phase: "seeded", values };
      }
    } catch(error) {

      this.#unseedOwnedSeeding();

      // A device on its way out has nothing to say about settings it will never project, so teardown passes in silence.
      if(this.signal.aborted) {

        return;
      }

      this.log.warn("Unable to read the access method settings from the controller. Access method switches will be configured once the controller answers.");
      this.log.debug("The access method settings read was refused: %s.", formatErrorMessage(error));
    }

    /* Materialize the switches the seed just made knowable. This sits outside the try deliberately: a failure inside the configure pass must not un-seed a model the
     * read legitimately established, and the guarded dispatch this runs under is that call's own backstop.
     */
    this.#materializeSeededSwitches();
  }

  /* Read this device's access methods from the official settings surface and translate them into the vocabulary the model is keyed by. The one fetch-and-translate
   * statement both the startup seed and the restore refresh run through, so the two can never drift on which surface they read or on how they read it.
   *
   * The official surface is read afresh here rather than carried in by a caller, and an absent one answers undefined rather than throwing, because what that absence
   * means belongs to the caller: the seed hands the model back for a later trigger, where the refresh keeps the values it already holds.
   *
   * @returns The values the settings state, or `undefined` where the client holds no official surface to read them from.
   */
  async #fetchAccessMethodValues(): Promise<Map<AccessMethodKey, boolean> | undefined> {

    /* A device torn down before this runs has nothing to read settings for, and asking the signal to throw is what puts that case and a read the teardown interrupts
     * on the same exit: both reach the caller as a throw, and what that means for the model is the caller's own to decide.
     */
    this.signal.throwIfAborted();

    const official = this.controller.client.official;

    if(!official) {

      return undefined;
    }

    const settings = await official.devices.fetchSettings(this.uda.unique_id, { signal: this.signal });

    return accessMethodValuesFromOfficialSettings({ methods: accessMethods, settings: settings.access_methods });
  }

  /* Materialize the switches a settled read has made knowable, and run the sweep beside them. The one statement of that settle-time pass, shared by the seed and the
   * refresh so what a completed read leaves HomeKit holding cannot differ between them.
   *
   * A model some faster path seeded while a read failed is materialized here too, which is the honest reading of a model that holds the truth however it arrived.
   */
  #materializeSeededSwitches(): void {

    if((this.#accessMethodState.phase !== "seeded") || this.signal.aborted) {

      return;
    }

    this.configureAccessMethodSwitches();
  }

  // Put the model back to unseeded, but only where this seed still owns the transition it started. A faster path that seeded the model meanwhile holds the truth,
  // and a read that failed or was torn down has nothing to say against it.
  #unseedOwnedSeeding(): void {

    if(this.#accessMethodState.phase === "seeding") {

      this.#accessMethodState = ACCESS_METHOD_UNSEEDED;
    }
  }

  /* Re-establish what a lost notification channel may have left stale on this device. A completed recovery relaunches that channel without replaying the packets the
   * gap swallowed, and a rowless reader's access methods reach us on no other rail, so this is where that model is asked again.
   *
   * The fold comes first because the dispatch below states that every caller folds the record's rows first: it takes whatever rows a late delivery carried, before the
   * fetch question is even asked, and it is what makes an unseeded phase at the dispatch's own refusal mean a record that genuinely carried none. The dispatch's
   * guards then make it a no-op for anything but an unseeded reader with an official surface, which is the startup seed getting another chance after a read that
   * failed.
   */
  public override onConnectionRestored(): void {

    this.#foldConfigRows();
    this.#dispatchAccessMethodSeed();

    /* Only a reader the record rail says nothing about has anything left to refresh, and only one refresh is ever out for a device. The latch is set here,
     * synchronously and ahead of any async work, so a second restore edge arriving while the read is in flight asks for nothing more...the staleness that edge
     * carried heals at the next recovery to complete.
     */
    if(!this.#rowlessSeededReader || this.#accessMethodRefreshInFlight) {

      return;
    }

    this.#accessMethodRefreshInFlight = true;

    guardedDispatch({ handler: async (): Promise<void> => this.#refreshAccessMethodValues(), label: "access method refresh", log: this.log });
  }

  /* Whether this device is a reader whose access methods only the official settings read can answer for: seeded, and carrying no configuration rows of its own. The
   * one named statement of the refresh's subject, read at the dispatch gate above and re-read where the fetch lands.
   *
   * The reader term mirrors the seed dispatch's own guard, which is what makes this predicate say exactly what its name says rather than leaning on an argument about
   * how two surfaces happen to line up.
   */
  get #rowlessSeededReader(): boolean {

    return (this.#accessMethodState.phase === "seeded") && (this.uda.configs === undefined) && isReader(this.uda);
  }

  /* Re-read a rowless seeded reader's access methods and restate its switches from what comes back. A method the user changed while the notification channel was down
   * reaches us on no rail at all otherwise, so this read is what closes that gap.
   *
   * A failed refresh keeps the values the model already holds, retires nothing, and warns about nothing: the create-on-data and remove-on-data posture the seed
   * established, carried into a refresh, where the values in hand are a better answer than none. The next recovery to complete tries again.
   */
  async #refreshAccessMethodValues(): Promise<void> {

    try {

      const values = await this.#fetchAccessMethodValues();

      // The subject is re-read here rather than assumed from dispatch time: rows that landed while the read was in flight are the device's own authority on its
      // methods, so a read that went out for a rowless device and came back to a rowful one has been overtaken and applies nothing.
      if(values && this.#rowlessSeededReader) {

        this.#accessMethodState = { phase: "seeded", values };
      }
    } catch(error) {

      // A device on its way out has nothing to say about settings it will never project, so teardown passes in silence.
      if(this.signal.aborted) {

        return;
      }

      this.log.debug("The access method refresh was refused: %s.", formatErrorMessage(error));
    } finally {

      this.#accessMethodRefreshInFlight = false;
    }

    // Restate the switches from whatever the model holds once the refresh has settled - this read's own answer, or fresher rows that landed while it was in flight.
    // It sits outside the landing guard above for exactly that reason.
    this.#materializeSeededSwitches();
  }

  /* Write an access method's state through the official Access API and read the settings back for certainty, because a method whose prerequisites the controller
   * lacks answers success with the setting unchanged and only a read-back can tell. The narrowed official reference arrives as a parameter: the caller's null check
   * cannot cross the method boundary, and a fresh getter read in here would be possibly null again. The fetched settings never leave this method...the verdict is
   * their only consumer.
   */
  async #writeAccessMethodOfficial(official: OfficialApi, accessMethod: typeof accessMethods[number],
    enabled: boolean): Promise<"absent" | "confirmed" | "declined" | "failed"> {

    try {

      await official.devices.updateSettings(this.uda.unique_id, composeAccessMethodUpdate({ enabled, keys: accessMethod.officialKeys }));

      const settings = await official.devices.fetchSettings(this.uda.unique_id);

      // The verdict is judged on the primary key, which is what the switch's own reads use.
      return accessMethodWriteVerdict({ enabled: enabled ? "yes" : "no", primaryKey: accessMethod.officialKeys[0], readBack: settings.access_methods });
    } catch(error) {

      this.log.debug("The access method write was refused: %s.", formatErrorMessage(error));

      return "failed";
    }
  }

  /* Write an access method's state through the Access application's own endpoints, which are credential surface: a client holding only an API token cannot reach
   * them at all. The G6 device class takes its writes on the configs endpoint under its own key set; every other class writes the settings endpoint under the
   * record's own key.
   */
  async #writeAccessMethodRaw(accessMethod: typeof accessMethods[number], enabled: boolean): Promise<boolean> {

    const entry = this.uda.configs?.find(entry => entry.key === accessMethod.key);
    const isConfigsApi = configsApiDeviceTypes.includes(this.uda.device_type);
    const transport = this.controller.client.transport;

    if(!entry || !transport) {

      return false;
    }

    const endpoint = isConfigsApi ? "/configs?is_camera=true" : "/settings";
    const keys = (isConfigsApi && ("configsApiKeys" in accessMethod)) ? accessMethod.configsApiKeys : [entry.key];
    const payload = keys.map(key => ({ key: key, tag: "open_door_mode", value: enabled ? "yes" : "no" }));

    try {

      await transport.request("https://" + this.controller.config.address + ACCESS_API_PATH_PREFIX + "/device/" + this.uda.unique_id + endpoint, {

        body: JSON.stringify(payload),
        method: "PUT"
      });

      return true;
    } catch(error) {

      this.log.debug("The access method write was refused: %s.", formatErrorMessage(error));

      return false;
    }
  }

  // Configure the doorbell service for HomeKit.
  private configureDoorbell(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Doorbell, this.hasCapability("door_bell") && this.hasFeature("Hub.Doorbell"))) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Doorbell, this.accessoryName, undefined, () => { this.log.info("Enabling the doorbell."); });

    if(!service) {

      this.log.error("Unable to add the doorbell.");

      return false;
    }

    service.setPrimaryService(true);

    return true;
  }

  /* Configure our contact sensors for HomeKit. Eligibility is what the hardware reports as wired, taken together with the user's feature option, so a sensor is
   * created on positive evidence and one already present survives a window in which the hardware reports none. Turning the option off always removes it.
   *
   * Re-running this is how a wiring change reaches HomeKit mid-run, so it is written to be silent on repeat: validService speaks only when a present service is
   * being removed, acquireService's callback only when one is created, and the initial writes below re-state the current reading rather than a fresh one.
   */
  private configureTerminalInputs(): boolean {

    this.configureDpsSensor();

    for(const { input, label } of terminalInputs) {

      const reservedId = AccessReservedNames[("CONTACT_" + input.toUpperCase()) as keyof typeof AccessReservedNames];
      const gate = capabilityGate({ capability: this.isWired(input), toggle: this.hasFeature("Hub." + input.toUpperCase()) });

      // Validate whether we should have this service enabled.
      if(!validService(this.accessory, this.hap.Service.ContactSensor, (hasService: boolean) => {

        const isValid = gate(hasService);

        if(!isValid && hasService) {

          this.log.info("Disabling the " + label.toLowerCase() + ".");
        }

        return isValid;
      }, reservedId)) {

        continue;
      }

      // Acquire the service.
      const service = acquireService(this.accessory, this.hap.Service.ContactSensor, this.accessoryName + " " + label, reservedId,
        () => { this.log.info("Enabling the " + label.toLowerCase() + "."); });

      if(!service) {

        this.log.error("Unable to add the " + label.toLowerCase() + ".");

        continue;
      }

      // Initialize the sensor state.
      service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.terminalInputState(input));
      this.dressAvailability(service);
      this.dressTamperState(service);
    }

    return true;
  }

  /* Dress a sensor service we have just acquired with its availability, in the two halves HomeKit needs from us.
   *
   * The write is what puts the optional characteristic on the service at all: HomeKit carries one only once something has written it, so without this the sweep that
   * keeps availability current would find no service to write to. The handler is what makes a read honest, answering from the live composition so HomeKit sees where
   * the device stands even when nothing has pushed since the composition last moved.
   *
   * A repeat configure pass registers the handler over the one the characteristic already holds, which is the same registration idiom the access method switches use.
   */
  private dressAvailability(service: Service): void {

    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.isReachable);
  }

  /* Dress a sensor service with the tamper characteristic, which is what puts the characteristic on the service at all: HomeKit carries an optional characteristic
   * only once something has written it. Every configure path calls this for the sensor it acquired, so on tamper-capable hardware every contact sensor carries the
   * characteristic from its creation - which is what lets the update handler's sweep reach all of them without keeping a roster - and reads normal until a verdict
   * says otherwise. Nothing established renders normal here: HomeKit has no third value, a status restored from the accessory cache with no reading behind it is
   * not one this plugin can assert, and the distinction between nothing said and no tampering lives in the held verdict and the status panel instead.
   *
   * It states the tracked verdict and never the record, so the per-update re-runs of the blocks that call it cannot move the baseline a genuine change is measured
   * against. Announcing a change is the update handler's job alone.
   */
  private dressTamperState(service: Service): void {

    if(!isTamperCapable(this.uda)) {

      return;
    }

    service.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.tamperVerdict ? this.hap.Characteristic.StatusTampered.TAMPERED :
      this.hap.Characteristic.StatusTampered.NOT_TAMPERED);
  }

  /* Configure the door position sensor. It stands apart from the loop above because its eligibility comes from the door-state model rather than a wiring-key pair,
   * its state is maintained by the door-state delivery rather than read off the record, and it reaches HomeKit through a manual getter that keeps its reading
   * available to a garage door service even when the sensor itself is disabled.
   *
   * The door-state delivery calls this too, so a change in wiring evidence re-gates the sensor on that rail as well rather than waiting for a device update. Like
   * the loop above, it is a no-op on repeat by construction.
   */
  private configureDpsSensor(): boolean {

    /* A UA Gate offers the sensor on the strength of the hardware being a gate, exactly as it always has: that hardware drives two doors, and the library derives
     * no topology facts for a device it cannot tell the doors of apart, so there is no evidence here to gate on and its own handlers own the state behind it.
     * Every other family answers from the evidence read.
     */
    const capability = (this.uda.device_type === "UGT") || this.dpsEvidence;
    const gate = capabilityGate({ capability, toggle: this.hasFeature("Hub.DPS") });

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.ContactSensor, (hasService: boolean) => {

      const isValid = gate(hasService);

      if(!isValid && hasService) {

        this.log.info("Disabling the " + DPS_LABEL.toLowerCase() + ".");
      }

      return isValid;
    }, AccessReservedNames.CONTACT_DPS)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.ContactSensor, this.accessoryName + " " + DPS_LABEL, AccessReservedNames.CONTACT_DPS,
      () => { this.log.info("Enabling the " + DPS_LABEL.toLowerCase() + "."); });

    if(!service) {

      this.log.error("Unable to add the " + DPS_LABEL.toLowerCase() + ".");

      return false;
    }

    // Initialize the sensor state from the projection the delivery path maintains, so a repeat call writes the reading we already hold rather than a fresh one.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this._hkDpsState);
    this.dressAvailability(service);
    this.dressTamperState(service);

    return true;
  }

  // Configure contact sensors for the side door terminal inputs on UA Gate hubs. The side door has its own dedicated DPS input separate from the main gate's DPS.
  private configureSideDoorTerminalInputs(): boolean {

    // We only configure side door terminal inputs for UA Gate hubs that have the side door enabled.
    if(!this.hints.hasSideDoor) {

      return false;
    }

    // Validate whether we should have this service enabled. We check the hasWiringSideDoorDps hint which already incorporates the feature option check.
    if(!validService(this.accessory, this.hap.Service.ContactSensor, (hasService: boolean) => {

      if(!this.hints.hasWiringSideDoorDps && hasService) {

        this.log.info("Disabling the side door position sensor.");
      }

      return this.hints.hasWiringSideDoorDps;
    }, AccessReservedNames.CONTACT_DPS_SIDE)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.ContactSensor, this.accessoryName + " Side Door Position Sensor",
      AccessReservedNames.CONTACT_DPS_SIDE, () => { this.log.info("Enabling the side door position sensor."); });

    if(!service) {

      this.log.error("Unable to add the side door position sensor.");

      return false;
    }

    // Initialize the sensor state from the current side door DPS state.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this._hkSideDoorDpsState);
    this.dressAvailability(service);
    this.dressTamperState(service);

    return true;
  }

  // Configure the door for HomeKit. Supports Lock and GarageDoorOpener service types.
  private configureLock(): boolean {

    // First, remove any previous service types that are no longer selected.
    const serviceTypes = [ this.hap.Service.LockMechanism, this.hap.Service.GarageDoorOpener ];
    const selectedService = this.doorServiceType === "GarageDoorOpener" ? this.hap.Service.GarageDoorOpener : this.hap.Service.LockMechanism;

    for(const serviceType of serviceTypes) {

      if(serviceType !== selectedService) {

        const oldService = this.accessory.getService(serviceType);

        if(oldService) {

          this.accessory.removeService(oldService);
        }
      }
    }

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, selectedService, isHub(this.uda))) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, selectedService, this.accessoryName, undefined,
      () => { this.log.info("Configuring door as %s service.", this.doorServiceType); });

    if(!service) {

      this.log.error("Unable to add the door.");

      return false;
    }

    // Configure based on service type.
    if(this.doorServiceType === "GarageDoorOpener") {

      this.configureGarageDoorService(service);
    } else {

      this.configureLockService(service, false);
    }

    // Initialize the state from the reading we already hold. Putting the backing value somewhere no reading can equal is what makes the setter below run its service
    // updates even when the state it is being given is the state we were already in.
    const lockState = this._hkLockState;

    this._hkLockState = -1;
    service.displayName = this.accessoryName;
    service.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName);
    this.hkLockState = lockState;

    service.setPrimaryService(true);

    return true;
  }

  // Configure a LockMechanism service.
  private configureLockService(service: ReturnType<typeof acquireService>, isSideDoor: boolean): void {

    if(!service) {

      return;
    }

    const lockStateGetter = isSideDoor ? (): CharacteristicValue => this.hkSideDoorLockState : (): CharacteristicValue => this.hkLockState;
    const lockCommand = isSideDoor ? async (lock: boolean): Promise<boolean> => this.hubSideDoorLockCommand(lock) :
      async (lock: boolean): Promise<boolean> => this.hubLockCommand(lock);

    service.getCharacteristic(this.hap.Characteristic.LockCurrentState).onGet(lockStateGetter);
    service.getCharacteristic(this.hap.Characteristic.LockTargetState).onGet(lockStateGetter);

    service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet(async (value: CharacteristicValue) => {

      // Check if this is just syncing state from an event (current state already matches target).
      const currentState = lockStateGetter();
      const targetLocked = value === this.hap.Characteristic.LockTargetState.SECURED;
      const currentlyLocked = currentState === this.hap.Characteristic.LockCurrentState.SECURED;

      // If state already matches, this is just a sync from an event - don't send command.
      if(targetLocked === currentlyLocked) {

        return;
      }

      if(!(await lockCommand(targetLocked))) {

        this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.LockTargetState,
          currentlyLocked ? this.hap.Characteristic.LockTargetState.SECURED : this.hap.Characteristic.LockTargetState.UNSECURED), CHARACTERISTIC_REVERT_DELAY_MS);
      }

      service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, lockStateGetter());
    });
  }

  // Configure a GarageDoorOpener service.
  private configureGarageDoorService(service: ReturnType<typeof acquireService>): void {

    if(!service) {

      return;
    }

    /* A service re-acquire registers the handlers below afresh, so any travel the machine was rendering belonged to a presentation of the door that no longer
     * exists. The door starts standing here, which also drains whatever timer that travel had armed.
     */
    this.#enterDoorTransition({ phase: "idle" });

    /* What the opener answers when HomeKit asks. A door mid-travel answers with the travel rather than with the evidence: the evidence lags the door, so answering
     * it here would put a controller's own read straight over the transitional state the write in front of it displayed.
     */
    const getDoorState = (): CharacteristicValue => {

      const travelling = this.#doorTransition;

      return (travelling.phase === "idle") ? this.#doorStateFromEvidence().current : this.#renderedTransition(travelling);
    };

    service.getCharacteristic(this.hap.Characteristic.CurrentDoorState).onGet(getDoorState);

    service.getCharacteristic(this.hap.Characteristic.TargetDoorState).onSet(async (value: CharacteristicValue) => {

      const isUaGate = this.uda.device_type === "UGT";
      const shouldClose = value === this.hap.Characteristic.TargetDoorState.CLOSED;
      const duration = this.doorTransitionDuration;
      const standing = this.#doorTransition;
      /* A door already travelling is halted by a write whichever direction that write named, because operating a door mid-travel is what stops it. A door standing
       * still - never moved, or halted and waiting - takes the direction the machine derives for it.
       */
      const halting = (standing.phase === "opening") || (standing.phase === "closing");
      const next: DoorTravel = halting ? { lastDirection: standing.phase, phase: "stopped" } : { phase: this.#resumedDoorDirection(shouldClose) };

      /* What HomeKit shows goes up as soon as the write lands, ahead of the command behind it, which is the responsiveness a door tile is expected to have. The
       * phase behind it takes only once that command comes back, so a command the controller refuses leaves the machine exactly where it stood.
       */
      if(duration > 0) {

        service.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.#renderedTransition(next));
      }

      /* Halting a gate is a command of its own, and the library scopes it to the hardware that has one. A client holding no path to carry it says so at debug and
       * the machine proceeds identically: the gate stands where its travel left it either way, and there is no second verb to reach for.
       */
      if(halting && isUaGate) {

        if(!this.hubProjection) {

          this.log.debug("Unable to halt the gate. This device has no door control surface.");
        } else {

          try {

            await this.hubProjection.stop({ doorId: this.mainDoorLocationId });
          } catch(error) {

            this.log.debug("Unable to halt the gate: %s.", formatErrorMessage(error));
          }
        }

        this.#enterDoorTransition(next);

        return;
      }

      // The command this write maps to on this hardware: a gate opens on its trigger and closes on the close command, both of which the shared lock command routes,
      // and a door hub's opener pulses its relay whichever direction was asked for.
      if(!(await (isUaGate ? this.hubLockCommand(shouldClose) : this.hubDoorPulseCommand()))) {

        // Revert target state on failure.
        this.timers.schedule(() => {

          service.updateCharacteristic(this.hap.Characteristic.TargetDoorState,
            shouldClose ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED);
          service.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, getDoorState());
        }, CHARACTERISTIC_REVERT_DELAY_MS);

        return;
      }

      // The door is moving, so the machine moves with it. A door with no travel time to model runs no machine at all and renders from the evidence instead.
      if(duration > 0) {

        this.#enterDoorTransition(next);
      }
    });

    // ObstructionDetected is required - we always report no obstruction.
    service.getCharacteristic(this.hap.Characteristic.ObstructionDetected).onGet(() => false);
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hasCapability("door_bell") && this.hasFeature("Hub.Doorbell.Trigger"),
      AccessReservedNames.SWITCH_DOORBELL_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.accessoryName + " Doorbell Trigger",
      AccessReservedNames.SWITCH_DOORBELL_TRIGGER, () => { this.log.info("Enabling the doorbell automation trigger."); });

    if(!service) {

      this.log.error("Unable to add the doorbell automation trigger.");

      return false;
    }

    // The switch mirrors ring truth: on while the doorbell is ringing, off while it is quiet.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.doorbellRingRequestId !== null);

    // The manual direction: with an official path the switch rings and cancels the doorbell, and without one it only reflects ring events. Whatever the outcome,
    // every write schedules exactly one wake that re-reads ring truth at fire time and settles the switch back onto the mirror...the controller's own ring and
    // cancel events stay the single owner of ring state, and the wake is a read of that state, never a second writer.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      const official = this.controller.client.official;
      const action = doorbellTriggerAction({ officialAvailable: official !== null, ringing: this.doorbellRingRequestId !== null, value: value === true });

      // The default wake converges HomeKit's optimistic cache back onto the mirror almost immediately; a dispatched ring or cancel earns the longer reconcile
      // window instead, so the controller's own notification can arrive and win first.
      let revertDelay = CHARACTERISTIC_REVERT_DELAY_MS;

      switch(action) {

        case "unavailable":

          this.log.error("Ringing the doorbell requires the official Access API, which needs an API token configured.");

          break;

        case "ring":
        case "cancel":

          // The decision already encodes that these arms exist only with an official path; this gate restates that precondition for the compiler, which cannot
          // correlate the decision's result with the getter's nullability across the function boundary.
          if(official) {

            // The controller's doorbell endpoint addresses the reader that carries the call surface, not the hub the trigger switch projects from.
            const readerId = doorbellReaderId({ devices: this.controller.client.state.snapshot().devices.values(), hubId: this.uda.unique_id });

            if(readerId === null) {

              this.log.error("Unable to %s the doorbell: no doorbell-capable reader is connected to this hub.", action);

              break;
            }

            try {

              if(action === "ring") {

                await official.devices.triggerDoorbell(readerId);
              } else {

                await official.devices.triggerDoorbell(readerId, { cancel: true });
              }

              revertDelay = DOORBELL_TRIGGER_RECONCILE_DELAY_MS;
            } catch(error) {

              this.log.error("Unable to %s the doorbell: %s.", action, formatErrorMessage(error));
            }
          }

          break;

        case "none":

          break;
      }

      this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, this.doorbellRingRequestId !== null), revertDelay);
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.accessoryName + " Doorbell Trigger");
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure a switch to automate lock and unlock events in HomeKit beyond what HomeKit might allow for a lock service that gets treated as a secure service.
  private configureLockTrigger(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, isHub(this.uda) && this.hasFeature("Hub.Lock.Trigger"),
      AccessReservedNames.SWITCH_LOCK_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.accessoryName + " Lock Trigger",
      AccessReservedNames.SWITCH_LOCK_TRIGGER, () => { this.log.info("Enabling the lock automation trigger."); });

    if(!service) {

      this.log.error("Unable to add the lock automation trigger.");

      return false;
    }

    // The trigger mirrors the lock: on while anything but secured, off while secured.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.hkLockState !== this.hap.Characteristic.LockCurrentState.SECURED);

    // The switch drives the lock through the hub lock command, and a refused command puts the switch back.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // If we are on, we are in an unlocked state. If we are off, we are in a locked state.
      if(!(await this.hubLockCommand(!value))) {

        // Revert our state.
        this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), CHARACTERISTIC_REVERT_DELAY_MS);
      }
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.accessoryName + " Lock Trigger");
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure the side door for HomeKit (UA Gate only) - always uses Lock service.
  private configureSideDoorLock(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.LockMechanism, this.hints.hasSideDoor, AccessReservedNames.LOCK_DOOR_SIDE)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.LockMechanism, this.accessoryName + " Side Door", AccessReservedNames.LOCK_DOOR_SIDE,
      () => { this.log.info("Configuring side door lock."); });

    if(!service) {

      this.log.error("Unable to add the side door.");

      return false;
    }

    // Configure the lock service.
    this.configureLockService(service, true);

    // Initialize the lock.
    this._hkSideDoorLockState = -1;
    service.displayName = this.accessoryName + " Side Door";
    service.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName + " Side Door");
    this.hkSideDoorLockState = this.hubSideDoorLockState;

    return true;
  }

  // Configure a switch to automate side door lock and unlock events in HomeKit beyond what HomeKit might allow for a lock service that gets treated as a secure service.
  private configureSideDoorLockTrigger(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.hasSideDoor && this.hasFeature("Hub.SideDoor.Lock.Trigger"),
      AccessReservedNames.SWITCH_LOCK_DOOR_SIDE_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.accessoryName + " Side Door Lock Trigger",
      AccessReservedNames.SWITCH_LOCK_DOOR_SIDE_TRIGGER, () => { this.log.info("Enabling the side door lock automation trigger."); });

    if(!service) {

      this.log.error("Unable to add the side door lock automation trigger.");

      return false;
    }

    // Trigger the lock state.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.hkSideDoorLockState !== this.hap.Characteristic.LockCurrentState.SECURED);

    // The switch drives the side door lock through the side door lock command, and a refused command puts the switch back.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // If we are on, we are in an unlocked state. If we are off, we are in a locked state.
      if(!(await this.hubSideDoorLockCommand(!value))) {

        // Revert our state.
        this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), CHARACTERISTIC_REVERT_DELAY_MS);
      }
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.accessoryName + " Side Door Lock Trigger");
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure the MQTT topics this device answers on and listens to.
  private configureMqtt(): boolean {

    // MQTT doorbell status.
    if(this.hasCapability("door_bell") && this.hasFeature("Hub.Doorbell")) {

      this.mqttSubscribeGet(mqttTopics.doorbell, () => {

        return this.doorbellRingRequestId !== null ? "true" : "false";
      });
    }

    // The remaining MQTT subscriptions are hub-specific (lock, DPS, side door).
    if(!isHub(this.uda)) {

      return true;
    }

    // MQTT DPS status.
    this.mqttSubscribeGet(mqttTopics.dps, () => {

      /* A UA Gate's door position comes from the location rail rather than a wired sensor, so the state we hold for it is the live answer. The sensor-evidence predicate
       * answers false for that hardware by design, and letting it speak here would report a gate whose position we know as unknown.
       */
      if((this.uda.device_type !== "UGT") && !this.dpsEvidence) {

        return "unknown";
      }

      switch(this.hkDpsState) {

        case this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED:

          return "false";


        case this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED:

          return "true";

        default:

          return "unknown";
      }
    });

    // MQTT lock status.
    this.mqttSubscribeGet(mqttTopics.lock, () => {

      switch(this.hkLockState) {

        case this.hap.Characteristic.LockCurrentState.SECURED:

          return "true";

        case this.hap.Characteristic.LockCurrentState.UNSECURED:

          return "false";

        default:

          return "unknown";
      }
    });

    // MQTT lock status.
    this.mqttSubscribeSet(mqttTopics.lock, (value: string) => {

      switch(value) {

        case "true":

          void this.hubLockCommand(true);

          break;

        case "false":

          void this.hubLockCommand(false);

          break;

        default:

          this.log.error("MQTT: Unknown lock set message received: %s.", value);

          break;
      }
    });

    // MQTT side door lock status (UA Gate only).
    if(this.hints.hasSideDoor) {

      this.mqttSubscribeGet(mqttTopics.sidedoorLock, () => {

        switch(this.hkSideDoorLockState) {

          case this.hap.Characteristic.LockCurrentState.SECURED:

            return "true";

          case this.hap.Characteristic.LockCurrentState.UNSECURED:

            return "false";

          default:

            return "unknown";
        }
      });

      this.mqttSubscribeSet(mqttTopics.sidedoorLock, (value: string) => {

        switch(value) {

          case "true":

            void this.hubSideDoorLockCommand(true);

            break;

          case "false":

            void this.hubSideDoorLockCommand(false);

            break;

          default:

            this.log.error("MQTT: Unknown side door lock set message received: %s.", value);

            break;
        }
      });

      // MQTT side door DPS status (UA Gate only).
      this.mqttSubscribeGet(mqttTopics.sidedoorDps, () => {

        if(!this.isSideDoorDpsWired) {

          return "unknown";
        }

        switch(this._hkSideDoorDpsState) {

          case this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED:

            return "false";

          case this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED:

            return "true";

          default:

            return "unknown";
        }
      });
    }

    return true;
  }

  // The client's live entry for one door, absent only where neither source had anything to say about that door.
  #doorEntry(locationId: string): AccessDoorStateEntry | undefined {

    return this.controller.client.doorStates.get(locationId);
  }

  /* The main door's own door-state entry, or `undefined` when nothing about that door has been established. The position evidence reads it, and so does the
   * construction seed of a hub that drives a single door.
   *
   * The removal-window guard lives in the door identity read alone, because a lookup on the client's map cannot throw: once the enumeration has answered there is
   * nothing left here for a departing device to raise, and a hub inside that window enumerates no doors at all. Hardware that drives no door - a reader alongside
   * a hub - enumerates none either and answers undefined for the same reason.
   */
  get #doorStateEntry(): AccessDoorStateEntry | undefined {

    const mainDoor = this.#drivenDoors.find(door => !door.isSideDoor);

    return mainDoor ? this.#doorEntry(mainDoor.locationId) : undefined;
  }

  /* The identity of the door this hub drives, read through a removal-window guard because the library's handle raises a ReferenceError once the device has left
   * controller state, which is the ordinary shape of a removal rather than a fault. This is the one place that guard lives, because a lookup on the client's
   * door-state map cannot throw once an identity has been resolved to read it under.
   */
  get #doorId(): string | undefined {

    try {

      return this.hubProjection?.doorId;
    } catch(error) {

      if(error instanceof ReferenceError) {

        return undefined;
      }

      throw error;
    }
  }

  /* Every door this hub drives, each under the identity the client's door-state map keys its reading by. This is the one statement of which doors a hub is
   * answerable for: the door-state refresh, the ownership check, and the construction seed all take their doors from here.
   *
   * A UA Gate answers from the two doors it discovered for itself, because the library derives no per-door facts for hardware whose doors it cannot tell apart.
   * A side door is enumerated wherever discovery resolved one, and discovery consults the user's side-door preference once, at construction, so no reader here
   * asks it again. Every other hub answers from the library's own published door resolution. A hub inside its removal grace enumerates nothing at all rather
   * than throwing, which is what the guarded identity read above makes true and which matters because every hub on a controller sees every delivery.
   */
  get #drivenDoors(): readonly DrivenDoor[] {

    if(this.uda.device_type === "UGT") {

      const doors: DrivenDoor[] = [];

      if(this.mainDoorLocationId) {

        doors.push({ isSideDoor: false, locationId: this.mainDoorLocationId });
      }

      if(this.sideDoorLocationId) {

        doors.push({ isSideDoor: true, locationId: this.sideDoorLocationId });
      }

      return doors;
    }

    const doorId = this.#doorId;

    return doorId ? [{ isSideDoor: false, locationId: doorId }] : [];
  }

  /* Which of this hub's doors a location identifies, or null when it identifies none of them.
   *
   * A hub inside its removal grace answers null rather than throwing, which matters because every hub on a controller sees every delivery and one hub's throw
   * would otherwise cost its siblings theirs.
   */
  #ownedDoor(locationId: string): Nullable<"main" | "side"> {

    const door = this.#drivenDoors.find(driven => driven.locationId === locationId);

    if(!door) {

      return null;
    }

    return door.isSideDoor ? "side" : "main";
  }

  /* Whether this hub has positive evidence of a wired door position sensor - the one predicate every consumer of that question reads. The family-by-family answer
   * is the policy module's shared eligibility statement; this getter binds it to the live record and the guarded door-state read.
   *
   * The Ultra's answer is eligibility - what the input is configured for - and never position. The position it reports is the stream's, so a window between a
   * just-flipped mode and the next door-state report closes on that report, with the sensor's conservative keep bridging it.
   */
  private get dpsEvidence(): boolean {

    return dpsSensorEligible({ device: this.uda, entry: this.#doorStateEntry });
  }

  /* Project this hub's live door state into HomeKit. The controller's door-state loop calls this once from what it finds on arrival, and again on every change the
   * client's model records.
   *
   * Every door the hub drives is read from the client's map under its own identity, which is how a UA Gate's two doors arrive through the same delivery as every
   * other hub's one, applied to the doors that discovery resolved for it rather than through a second resolution of their own.
   *
   * The entries we read update live from the notification stream: the wiring keys behind them are live circuit detection, and the stream reports a wiring
   * transition as it happens. A refresh only ever seeds a door it has never seen, so the stream is the sole corrector of an established entry once we are running.
   */
  public refreshDoorState(): void {

    for(const door of this.#drivenDoors) {

      const entry = this.#doorEntry(door.locationId);

      // Nothing established is nothing to project.
      if(!entry) {

        continue;
      }

      /* Re-gate the sensor before applying state, so a change in wiring evidence reaches HomeKit on this rail too rather than waiting on a device update. The
       * evidence that gates it is the main door's, which is the door the re-gate belongs to.
       */
      if(!door.isSideDoor) {

        this.configureDpsSensor();
      }

      this.applyDoorState(entry, door.isSideDoor);
    }
  }

  /* The registry key a door's pending auto-relock is tracked under. One door, one relock intent: a HomeKit unlock and a remote unlock arrive under the same key, so
   * the newest relock replaces whatever was pending rather than stacking beside it. The formula lives here alone so that an opening window and the close that ends
   * it can never name different timers, and so a typo collapsing the pair into a single key cannot let a side door's unlock cancel the main door's pending relock.
   */
  #relockTimerKey(isSideDoor: boolean): string {

    return isSideDoor ? "relock-side" : "relock-main";
  }

  /* How a gate's door announces itself: the name its own lines render it under, and the tail its lock topic hangs off. The window helpers below read their pair
   * from here, so the name a user hears and the topic a subscriber reads can never disagree about which door they are describing.
   *
   * @param isSideDoor - Whether the side door of a UA Gate is the door being announced.
   *
   * @returns The door's rendered name and its lock topic's catalog entry.
   */
  #doorAnnounceIdentity(isSideDoor: boolean): { doorName: string; topic: MqttTopicEntry } {

    const doorName = this.#doorCommandName(isSideDoor);

    return { doorName: doorName.charAt(0).toUpperCase() + doorName.slice(1), topic: isSideDoor ? mqttTopics.sidedoorLock : mqttTopics.lock };
  }

  /* The one voice a door's lock state is announced in: the topic a subscriber reads, and the line a user reads where they asked for it, both under the door's own
   * name. Every writer of that state speaks here, so whichever side observed a transition - the controller reporting it, a window of ours opening or ending, or a
   * remote unlock arriving - a user reads one vocabulary and a subscriber one topic.
   *
   * @param isSideDoor - Whether the side door of a UA Gate is the door being announced.
   * @param locked - Whether the door is being announced as locked.
   */
  #announceLockState(isSideDoor: boolean, locked: boolean): void {

    const { doorName, topic } = this.#doorAnnounceIdentity(isSideDoor);

    this.mqttPublish(topic, locked ? "true" : "false");

    if(this.hints.logLock) {

      this.log.info("%s %s.", doorName, locked ? "locked" : "unlocked");
    }
  }

  /* Settle a door on a reported lock state and announce the move, answering whether the door moved at all.
   *
   * A reported state moves the door only when it differs from what the door already reads, which is what lets two rails report one event and have it announced
   * once: whichever reaches here first settles the door and speaks, and the one behind it finds the door settled and stays silent. A report of a door locked
   * retires that door's pending relock as well.
   *
   * @param isSideDoor - Whether the side door of a UA Gate is the door being settled.
   * @param lockState - The lock state the door has been reported in.
   *
   * @returns Whether the door moved.
   */
  #applyLockState(isSideDoor: boolean, lockState: CharacteristicValue): boolean {

    if(lockState === (isSideDoor ? this.hkSideDoorLockState : this.hkLockState)) {

      return false;
    }

    /* A door the controller reports locked has nothing left for a pending relock of ours to do. Letting one survive would announce a close of our own over the
     * controller's fresher reading, so the rail's report of a closing retires the window the same way our own close command does.
     */
    if(this.isLocked(lockState)) {

      this.timers.clear(this.#relockTimerKey(isSideDoor));
    }

    if(isSideDoor) {

      this.hkSideDoorLockState = lockState;
    } else {

      this.hkLockState = lockState;
    }

    this.#announceLockState(isSideDoor, this.isLocked(lockState));

    return true;
  }

  /* Open a gate door's unlock window: the unlocked state, the announcement of it, and the relock that will end it.
   *
   * The controller reports nothing back over the event stream for a location command of ours, and a remote unlock is that same hardware window begun on the
   * controller's side instead, so each arrives here. That is what lets the lock topic and the log tell one story about the door whichever side opened it.
   *
   * Opening is deliberately unconditional on the state we hold. Each unlock act is its own announcement and arms the window afresh, so a door unlocked again while
   * its window stands extends that window rather than being swallowed by the state it is already in.
   *
   * The announcement goes through the shared helper, so a window of ours speaks about the door in the same voice the controller's own reports are spoken in.
   *
   * @param isSideDoor - Whether the side door of a UA Gate is the door unlocked.
   */
  #openGateLockWindow(isSideDoor: boolean): void {

    if(isSideDoor) {

      this.hkSideDoorLockState = this.hap.Characteristic.LockCurrentState.UNSECURED;
    } else {

      this.hkLockState = this.hap.Characteristic.LockCurrentState.UNSECURED;
    }

    this.#announceLockState(isSideDoor, false);

    this.timers.setTimeout(this.#relockTimerKey(isSideDoor), () => this.#closeGateLockWindow(isSideDoor), AUTO_LOCK_DELAY_MS);
  }

  /* End a gate door's unlock window: retire the relock, and settle and announce the door when a window was genuinely standing open.
   *
   * A window ends exactly once, whether the relock expires, a close command of ours lands, or the controller reports the door secured, so the announcement is
   * gated on the door actually standing unlocked. Whichever arrival settles the door speaks, and every later one finds it settled and stays silent. Clearing the
   * key first is safe from the relock's own callback, because a fired one-shot has already left the registry.
   *
   * The gate reads for UNSECURED rather than against SECURED because the lock services are reconfigured through a sentinel value that no reading equals, and a
   * "not secured" test would announce on that sentinel. Nothing is awaited between the read and the writes, so no other arrival can settle the door in between.
   *
   * The announcement goes through the shared helper, so a window of ours speaks about the door in the same voice the controller's own reports are spoken in.
   *
   * @param isSideDoor - Whether the side door of a UA Gate is the door whose window is ending.
   */
  #closeGateLockWindow(isSideDoor: boolean): void {

    this.timers.clear(this.#relockTimerKey(isSideDoor));

    if((isSideDoor ? this.hkSideDoorLockState : this.hkLockState) !== this.hap.Characteristic.LockCurrentState.UNSECURED) {

      return;
    }

    if(isSideDoor) {

      this.hkSideDoorLockState = this.hap.Characteristic.LockCurrentState.SECURED;
    } else {

      this.hkLockState = this.hap.Characteristic.LockCurrentState.SECURED;
    }

    this.#announceLockState(isSideDoor, true);
  }

  /* The name a door goes by mid-sentence in the lines its commands and its window helpers write. It stands on its own rather than inside the shared preamble below
   * because the announce identity reads it too, so the name a user hears in a refusal and in a window's lines can never disagree.
   *
   * @param isSideDoor - Whether the side door of a UA Gate is the target.
   *
   * @returns The door's name.
   */
  #doorCommandName(isSideDoor: boolean): string {

    return isSideDoor ? "side door" : ((this.uda.device_type === "UGT") ? "gate" : "door");
  }

  /* The one shape a door command's refusal takes: the verb, the door as the user hears it, and the reason the command cannot be carried. Every refusal a door
   * command makes is spoken here, so the voice cannot drift as commands are added.
   *
   * @param options - The verb the refusal names, the door's rendered name, and the reason, which carries its own terminal punctuation.
   */
  #refuseDoorCommand(options: { action: string; doorName: string; reason: string }): void {

    this.log.error("Unable to %s the %s. %s", options.action, options.doorName, options.reason);
  }

  /* The preamble every door command shares: name the door, resolve the control surface the command dispatches through, and refuse outright when the device cannot
   * be reached or carries no such surface. The surface travels in the answer rather than being re-checked by each caller, because TypeScript cannot carry a
   * narrowing of the optional handle across a function boundary...holding it in the target is what makes it non-optional where the command dispatches.
   *
   * @param options - The verb a refusal names, and whether the side door of a UA Gate is the target.
   *
   * @returns The resolved door, or `null` when the command was refused and the caller has nothing left to do.
   */
  #resolveDoorCommand(options: { action: string; isSideDoor: boolean }): DoorCommandTarget | null {

    const { action, isSideDoor } = options;
    const doorName = this.#doorCommandName(isSideDoor);

    /* A device we cannot reach has nothing to command, so we refuse here rather than dispatching into a controller that cannot carry it. The refusal names
     * reachability rather than the device's own state, because the composition it reads answers for the controller as well, and claiming a device is offline on the
     * strength of a controller outage would assert knowledge we do not have.
     */
    if(!this.isReachable) {

      this.#refuseDoorCommand({ action, doorName, reason: "The device cannot be reached." });

      return null;
    }

    /* The commands are only reachable through the hub view of this device. An absent one cannot happen through the adoption path, which resolves the hub view first
     * and falls back to the plain device view only for hardware carrying no hub capability - the same capability this class's lock service is gated on - but the
     * handle is optional at construction, so this is the honest boundary rather than dead code.
     */
    if(!this.hubProjection) {

      this.#refuseDoorCommand({ action, doorName, reason: "This device has no door control surface." });

      return null;
    }

    return { action, doorName, hub: this.hubProjection };
  }

  /* The preamble a UA Gate's commands take: the shared one above with the door's own identity added to it.
   *
   * The door is always named explicitly. A gate drives two doors and the handle's own resolution answers with whichever port binding the controller happened to
   * deliver first, so a command leaving the door unnamed would address whichever door that ordering put in front.
   *
   * @param options - The verb a refusal names, and whether the side door is the target.
   *
   * @returns The resolved door carrying its identity, or `null` when the command was refused.
   */
  #resolveGateDoor(options: { action: string; isSideDoor: boolean }): GateDoorTarget | null {

    const target = this.#resolveDoorCommand(options);

    if(!target) {

      return null;
    }

    const doorId = options.isSideDoor ? this.sideDoorLocationId : this.mainDoorLocationId;

    if(!doorId) {

      this.#refuseDoorCommand({ action: target.action, doorName: target.doorName, reason: "No door record was found for it." });

      return null;
    }

    return { ...target, doorId };
  }

  /* Every failed dispatch a door command makes, reported in one sentence shape so the verb and the door read the same way whichever command sent it.
   *
   * The attribution fallback is not one of these. It stays inside #dispatchUnlock because the refusal it answers is a retry rather than a failure, and nothing
   * arrives here until that retry has had its turn.
   *
   * @param target - The resolved door this command is addressed to.
   * @param send - The library call to make, given the control surface the target carries.
   *
   * @returns `true` when the controller accepted the command.
   */
  async #dispatchDoorCommand(target: DoorCommandTarget, send: (hub: AccessHubProjection) => Promise<void>): Promise<boolean> {

    try {

      await send(target.hub);
    } catch(error) {

      this.log.error("Unable to %s the %s: %s.", target.action, target.doorName, formatErrorMessage(error));

      return false;
    }

    return true;
  }

  /* Every unlock this plugin sends, naming itself as the actor behind it so the controller's activity history records the automation rather than the account the
   * client authenticated with. Attribution is something only the published API can express, so a client holding no path to it refuses the attributed unlock at
   * the library's own routing gate, before anything reaches the wire...that refusal is the library's statement that the attribution is unsayable here, and the
   * answer to it is the same unlock without the actor. The retry carries the caller's options exactly as given, so the door it names is the door it named.
   *
   * The refusal is caught by its own type alone. Every other failure is about the unlock rather than about the attribution, so it travels on to the caller's own
   * reporting untouched and is never retried behind the user's back.
   *
   * @param projection - The door control surface to dispatch on, resolved by the caller whose refusal names its own command.
   * @param options - What the unlock carries beyond the actor, or nothing at all for hardware that drives a single door.
   */
  async #dispatchUnlock(projection: AccessHubProjection, options?: { doorId: string }): Promise<void> {

    try {

      await projection.unlock({ ...options, actor: ACCESS_UNLOCK_ACTOR });
    } catch(error) {

      if(!(error instanceof AccessCapabilityError)) {

        throw error;
      }

      this.log.debug("The attributed unlock was refused, so it is being sent unattributed: %s.", formatErrorMessage(error));

      await projection.unlock(options);
    }
  }

  /* Close a UA Gate's door through the library's own close command, the verb that hardware answers for the closing direction. The unlock this hub's opening
   * direction sends opens a two-button gate whichever direction it was asked for, so every surface that asks a gate to lock arrives here instead.
   *
   * The controller reports nothing back over the event stream for a command of ours, so an accepted close hands the door to the window helper below rather than
   * waiting on an event that never arrives: without that, the write that asked for the close would push the door's stale unlocked state straight back at HomeKit.
   *
   * @param isSideDoor - Whether the side door is the door to close.
   *
   * @returns `true` when the controller accepted the close.
   */
  private async hubDoorCloseCommand(isSideDoor = false): Promise<boolean> {

    const target = this.#resolveGateDoor({ action: "close", isSideDoor });

    if(!target) {

      return false;
    }

    if(!(await this.#dispatchDoorCommand(target, hub => hub.close({ doorId: target.doorId })))) {

      return false;
    }

    /* A removal that overtook the close while it was in flight leaves nothing here to settle. The controller accepted the command, which is what the answer
     * reports, but the window helper would announce on behalf of a device that is gone, so it is not reached.
     */
    if(this.signal.aborted) {

      return true;
    }

    this.#closeGateLockWindow(isSideDoor);

    return true;
  }

  /* Pulse the relay a garage door opener hangs off on a door hub: a momentary unlock, which is the only motion that wiring has. Such an opener takes a single
   * input and answers every pulse of it the same way - it opens a closed door, closes an open one, halts one mid-travel, and reverses one that was halted - so
   * both directions of a HomeKit write dispatch this same pulse. No lock rule of any kind is involved: the configured lock delay governs the lock accessory, and
   * a rule that held the relay open would leave the door open rather than move it.
   *
   * A door hub drives one door and its handle resolves that door for itself, so the command carries no identity of its own while its lines still name the door.
   *
   * @returns `true` when the controller accepted the pulse.
   */
  private async hubDoorPulseCommand(): Promise<boolean> {

    const target = this.#resolveDoorCommand({ action: "operate", isSideDoor: false });

    if(!target) {

      return false;
    }

    return this.#dispatchDoorCommand(target, hub => this.#dispatchUnlock(hub));
  }

  /* Lock or unlock a hub's door: the one command every surface asking for either direction arrives at, whatever hardware stands behind it.
   *
   * @param isLocking - Whether the door is being locked rather than unlocked.
   * @param isSideDoor - Whether the side door of a UA Gate is the target.
   *
   * @returns `true` when the controller accepted the command.
   */
  private async hubDoorLockCommand(isLocking: boolean, isSideDoor = false): Promise<boolean> {

    /* A UA Gate answers the locking direction with a close. Routing it here rather than at each surface that asks for it means the lock accessory, the automation
     * triggers, the MQTT topics, and the garage door opener all reach that verb through the one path they already share.
     */
    if(isLocking && (this.uda.device_type === "UGT")) {

      return this.hubDoorCloseCommand(isSideDoor);
    }

    const action = isLocking ? "lock" : "unlock";

    /* A UA Gate is opened through the library's own unlock, which chooses the rail the client's identity can carry it on and absorbs the wire shape on our behalf.
     * Only the unlock direction reaches here, the close command above having taken the other one.
     */
    if(this.uda.device_type === "UGT") {

      const target = this.#resolveGateDoor({ action, isSideDoor });

      if(!target) {

        return false;
      }

      if(!(await this.#dispatchDoorCommand(target, hub => this.#dispatchUnlock(hub, { doorId: target.doorId })))) {

        return false;
      }

      // The same removal check the close command makes: an unlock the controller accepted is answered as such, but a device removed while it was in flight has no
      // window left to open and nothing to announce it on.
      if(this.signal.aborted) {

        return true;
      }

      this.#openGateLockWindow(isSideDoor);

      return true;
    }

    // For hub types other than UA Gate, we use the standard device unlock API. This is the lock accessory's own path: a garage door opener on this hardware is the
    // momentary pulse instead.
    const target = this.#resolveDoorCommand({ action, isSideDoor });

    if(!target) {

      return false;
    }

    // What this command should carry. Only a door hub consults it: a UA Gate is unlocked outright and relocked on a timer of our own, and it has already returned.
    const decision = lockCommandRule({ delayInterval: this.lockDelayInterval, isLocking });

    /* A relock is only ours to make where the relay carries a rule to reset, so a door on the default settings is told so rather than left to wonder. A garage door
     * opener never arrives here at all, its writes being the momentary pulse...this is the lock accessory's own refusal. It follows the preamble, so a door that
     * cannot be reached or carries no control surface is refused for the reason a user can act on rather than for its relay settings.
     */
    if(decision.kind === "refuse") {

      this.log.error("Unable to manually relock the %s when the lock relay is configured to the default settings.", target.doorName);

      return false;
    }

    // Execute the action the policy decided on: an unconfigured delay issues the plain momentary unlock, and every other decision goes as a lock rule.
    return this.#dispatchDoorCommand(target, hub => (decision.kind === "unlock") ? this.#dispatchUnlock(hub) : hub.setLockRule(decision.rule));
  }

  // Wrapper for door lock command.
  private async hubLockCommand(isLocking: boolean): Promise<boolean> {

    return this.hubDoorLockCommand(isLocking);
  }

  // Wrapper for side door lock command (for backwards compatibility).
  private async hubSideDoorLockCommand(isLocking: boolean): Promise<boolean> {

    return this.hubDoorLockCommand(isLocking, true);
  }

  // Return the current HomeKit DPS state that we are tracking for this hub. We read from the contact sensor service if it exists, otherwise we fall back to the
  // backing variable. This allows GarageDoorOpener to function correctly even when the DPS contact sensor is disabled.
  private get hkDpsState(): CharacteristicValue {

    const service = this.accessory.getServiceById(this.hap.Service.ContactSensor, AccessReservedNames.CONTACT_DPS);

    if(service) {

      return service.getCharacteristic(this.hap.Characteristic.ContactSensorState).value ?? this._hkDpsState;
    }

    return this._hkDpsState;
  }

  // Set the current HomeKit DPS state for this hub. We always update the backing variable and also update the contact sensor service if it exists.
  private set hkDpsState(value: CharacteristicValue) {

    this._hkDpsState = value;
    this.setContactSensorState(AccessReservedNames.CONTACT_DPS, value);
  }

  // Return the current HomeKit lock state that we are tracking for this hub.
  private get hkLockState(): CharacteristicValue {

    return this._hkLockState;
  }

  // Set the current HomeKit lock state for this hub.
  private set hkLockState(value: CharacteristicValue) {

    // If nothing is changed, we're done.
    if(this.hkLockState === value) {

      return;
    }

    // Update the lock state.
    this._hkLockState = value;

    // For Lock service type, update the service. For GarageDoorOpener on non-UA Gate hubs, also update the service since door state is derived from lock state. For UA
    // Gate with GarageDoorOpener, DPS events handle updates since it's a motorized gate with physical positions.
    if((this.doorServiceType === "Lock") || (this.uda.device_type !== "UGT")) {

      this.updateDoorServiceState(false);
    } else {

      // UA Gate with GarageDoorOpener: only update the lock trigger switch if enabled.
      this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_LOCK_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On,
        value !== this.hap.Characteristic.LockCurrentState.SECURED);
    }
  }

  /* How long this door's travel is modeled as taking, in milliseconds, or zero for a door whose travel is not modeled at all. It is read afresh at every write, so
   * a duration the user changes applies from the next transition; a transition already running keeps the timer it armed.
   *
   * A UA Gate with nothing configured falls back to the window that hardware is given, because its motion is short and much the same everywhere. Every other
   * family renders instantly until a duration has been configured for it, which is the setting's whole purpose.
   */
  private get doorTransitionDuration(): number {

    const configured = this.getFeatureNumber("Hub.Door.TransitionDuration") ?? undefined;

    if((configured !== undefined) && (configured > 0)) {

      return configured * 1000;
    }

    return (this.uda.device_type === "UGT") ? GATE_TRANSITION_DURATION_MS : 0;
  }

  /* Where the main door stands, as the pair of characteristics that describe it: the position HomeKit is shown and the target that agrees with it. Deriving both
   * from a single read is what keeps them from disagreeing, which two independent derivations eventually would.
   *
   * A UA Gate reads its position from the location rail, which is where that hardware reports it. Every other family reads the door position sensor wherever the
   * evidence says one is wired, and the lock relay otherwise, which is all a door with no sensor has to say about where it is.
   *
   * @returns The door state to show, and the target that matches it.
   */
  #doorStateFromEvidence(): { current: CharacteristicValue; target: CharacteristicValue } {

    const fromPosition = (this.uda.device_type === "UGT") || this.dpsEvidence;
    const closed = fromPosition ? this.isClosed(this.hkDpsState) : this.isLocked(this.hkLockState);

    return { current: closed ? this.hap.Characteristic.CurrentDoorState.CLOSED : this.hap.Characteristic.CurrentDoorState.OPEN,
      target: closed ? this.hap.Characteristic.TargetDoorState.CLOSED : this.hap.Characteristic.TargetDoorState.OPEN };
  }

  /* What a travel looks like on the characteristic. Only a running travel has a rendering of its own...a door standing still shows where the evidence puts it.
   *
   * @param travel - The travel being rendered.
   *
   * @returns The door state HomeKit is shown while that travel runs.
   */
  #renderedTransition(travel: DoorTravel): CharacteristicValue {

    switch(travel.phase) {

      case "closing":

        return this.hap.Characteristic.CurrentDoorState.CLOSING;

      case "opening":

        return this.hap.Characteristic.CurrentDoorState.OPENING;

      default:

        return this.hap.Characteristic.CurrentDoorState.STOPPED;
    }
  }

  /* Which way a write moves the door, from where the machine stands, for both hardware families in one place so the direction shown can never disagree with the
   * verb dispatched.
   *
   * A gate answers to two distinct verbs - the trigger opens it and the close command closes it - so it travels the way the write named, from a halt exactly as
   * from a standstill. A momentary operator answers to one input that carries no direction at all, so a pulse against a halted door reverses whatever travel the
   * halt interrupted, whichever direction HomeKit asked for.
   *
   * @param shouldClose - Whether the write asked for the closed position.
   *
   * @returns The travel the door now runs.
   */
  #resumedDoorDirection(shouldClose: boolean): "opening" | "closing" {

    if((this.#doorTransition.phase === "stopped") && (this.uda.device_type !== "UGT")) {

      return (this.#doorTransition.lastDirection === "closing") ? "opening" : "closing";
    }

    return shouldClose ? "closing" : "opening";
  }

  /* The one place the transition phase changes: the phase and the timer that ends it move together here, so a phase can never outlive its own expiry nor an expiry
   * outlive the phase that armed it. Registering under the key replaces whatever was armed there, which is what makes the newest travel's expiry the only live one
   * when writes overlap.
   *
   * The expiry is the guaranteed way out of every travel. A reading that agrees settles one sooner, and a door nobody hears from again still comes to rest.
   *
   * @param next - The phase to enter.
   */
  #enterDoorTransition(next: DoorTransition): void {

    this.#doorTransition = next;

    if(next.phase === "idle") {

      this.timers.clear(DOOR_TRANSITION_TIMER_KEY);

      return;
    }

    this.timers.setTimeout(DOOR_TRANSITION_TIMER_KEY, () => {

      this.#enterDoorTransition({ phase: "idle" });
      this.#updateGarageDoorState();
    }, this.doorTransitionDuration);
  }

  /* Put the door's own state on the opener, which is the one place that service is written outside a HomeKit write of its own.
   *
   * A door standing still shows the evidence. A door mid-travel meets each reading against the travel it is running: a closed reading settles every travel, because
   * a door reporting itself closed has arrived wherever it was going; an open reading settles only an opening, because a gate's position sensor reads open while
   * the gate is still closing and a door halted mid-travel reads open until it moves again. A reading that settles nothing leaves the phase and the characteristic
   * exactly as they were, and the travel's own expiry remains its way out.
   */
  #updateGarageDoorState(): void {

    // Held while a delivery applies its readings, so the opener renders once from the finished pair rather than once per reading.
    if(this.#doorStateApplying) {

      return;
    }

    const service = this.accessory.getService(this.hap.Service.GarageDoorOpener);

    if(!service) {

      return;
    }

    const evidence = this.#doorStateFromEvidence();
    const travelling = this.#doorTransition;

    if(travelling.phase !== "idle") {

      if((evidence.current !== this.hap.Characteristic.CurrentDoorState.CLOSED) && (travelling.phase !== "opening")) {

        return;
      }

      this.#enterDoorTransition({ phase: "idle" });
    }

    service.updateCharacteristic(this.hap.Characteristic.TargetDoorState, evidence.target);
    service.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, evidence.current);
  }

  // Update door service state based on configured service type.
  private updateDoorServiceState(isSideDoor: boolean): void {

    const serviceType = isSideDoor ? "Lock" : this.doorServiceType;
    const lockState = isSideDoor ? this.hkSideDoorLockState : this.hkLockState;
    const triggerSubtype = isSideDoor ? AccessReservedNames.SWITCH_LOCK_DOOR_SIDE_TRIGGER : AccessReservedNames.SWITCH_LOCK_TRIGGER;

    if(serviceType === "GarageDoorOpener") {

      // The opener renders from the door position sensor as well as the relay, and from the travel it may be running, so it has an update of its own rather than
      // one this reading composes.
      this.#updateGarageDoorState();
    } else {

      // The primary door has no subtype. The side door (UA Gate only) uses a subtype to distinguish it.
      const service = isSideDoor ? this.accessory.getServiceById(this.hap.Service.LockMechanism, AccessReservedNames.LOCK_DOOR_SIDE) :
        this.accessory.getService(this.hap.Service.LockMechanism);

      if(service) {

        service.updateCharacteristic(this.hap.Characteristic.LockTargetState, lockState === this.hap.Characteristic.LockCurrentState.UNSECURED ?
          this.hap.Characteristic.LockTargetState.UNSECURED : this.hap.Characteristic.LockTargetState.SECURED);
        service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, lockState);
      }
    }

    // Update the lock trigger switch if enabled.
    this.accessory.getServiceById(this.hap.Service.Switch, triggerSubtype)?.updateCharacteristic(this.hap.Characteristic.On,
      lockState !== this.hap.Characteristic.LockCurrentState.SECURED);
  }

  // Return the current HomeKit side door lock state that we are tracking for this hub.
  private get hkSideDoorLockState(): CharacteristicValue {

    return this._hkSideDoorLockState;
  }

  // Set the current HomeKit side door lock state for this hub.
  private set hkSideDoorLockState(value: CharacteristicValue) {

    // If nothing is changed, we're done.
    if(this.hkSideDoorLockState === value) {

      return;
    }

    // Update the lock state.
    this._hkSideDoorLockState = value;

    // Update the lock service state.
    this.updateDoorServiceState(true);
  }

  // Return the current state of the side door DPS on the UA Gate hub.
  private get hubSideDoorDpsState(): CharacteristicValue {

    // If we don't have the wiring connected for the side door DPS, we report our default closed state.
    if(!this.isSideDoorDpsWired) {

      return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    // Return our side door DPS state. If it's anything other than on, we assume it's open.
    return (this.uda.configs?.find(entry => entry.key === "input_door_dps")?.value === "on") ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED :
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  /* Return the state of the main gate's lock relay on a UA Gate hub. Only that hardware answers from its record here: every other family's lock reading comes from
   * the door-state model, and answering secured for them is the same safe reading an unrecognized lock value gets.
   */
  private get hubLockState(): CharacteristicValue {

    if(this.uda.device_type !== "UGT") {

      return this.hap.Characteristic.LockCurrentState.SECURED;
    }

    const lockRelay = this.uda.configs?.find(entry => entry.key === "output_oper1_relay");

    return (lockRelay?.value === "off") ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED;
  }

  // Return the current state of the side door relay lock on the UA Gate hub.
  private get hubSideDoorLockState(): CharacteristicValue {

    // Side door lock is only available on UA Gate.
    if(this.uda.device_type !== "UGT") {

      return this.hap.Characteristic.LockCurrentState.SECURED;
    }

    const lockRelay = this.uda.configs?.find(entry => entry.key === "output_oper2_relay");

    return (lockRelay?.value === "off") ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED;
  }

  /* What a terminal input reads: closed unless the input is wired and the row its model reports it under says anything but on. A model naming no row offers no
   * reading of that input at all, which renders as the same closed answer, so nothing downstream has to tell the two apart.
   *
   * @param input - The terminal input to read.
   *
   * @returns The contact sensor state the input's live reading renders as.
   */
  private terminalInputState(input: SensorInput): CharacteristicValue {

    const row = sensorStateRows[input][this.uda.device_type];

    if(!row || !this.isWired(input)) {

      return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    return (this.uda.configs?.find(relay => relay.key === row)?.value === "on") ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED :
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // Return the wiring state of the side door DPS on UA Gate hubs. The side door DPS uses different wiring keys than the main gate DPS.
  private get isSideDoorDpsWired(): boolean {

    // Side door DPS is only available on UA Gate.
    if(this.uda.device_type !== "UGT") {

      return false;
    }

    return this.isPairLive([ "wiring_state_door-dps-neg", "wiring_state_door-dps-pos" ]);
  }

  // Whether both halves of a wiring pair report a live circuit. Both must read on for the pair to mean anything: a single connected terminal is a half-wired sensor,
  // which is not a sensor. The one statement of that reading, so the two callers cannot come to differ on what counts as wired.
  private isPairLive(wires: string[]): boolean {

    return wires.every(wire => this.uda.configs?.some(e => (e.key === wire) && (e.value === "on")));
  }

  // Utility to check the wiring state of a given terminal input.
  private isWired(input: SensorInput): boolean {

    // The Ultra multiplexes its one terminal input and carries no wiring pair at all, so what that input is configured for is the only evidence its record offers.
    if(this.uda.device_type === "UA-ULTRA") {

      return (input === "Rex") && (ultraInputMode(this.uda) === "rex");
    }

    // Find the wiring keys for this model.
    const wires = sensorWiring[input][this.uda.device_type];

    if(!wires) {

      return false;
    }

    return this.isPairLive(wires);
  }

  // Utility to retrieve a contact sensor state.
  private getContactSensorState(name: AccessReservedNames): CharacteristicValue {

    return this.accessory.getServiceById(this.hap.Service.ContactSensor, name)?.getCharacteristic(this.hap.Characteristic.ContactSensorState).value ??
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // Utility to set a contact sensor state.
  private setContactSensorState(name: AccessReservedNames, value: CharacteristicValue): void {

    this.accessory.getServiceById(this.hap.Service.ContactSensor, name)?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, value);
  }

  // Whether this hub carries a capability the library names no predicate for - the doorbell and the access-method families - answered through the one predicate
  // the status feed and the settings page read too.
  private hasCapability(capability: string | readonly string[]): boolean {

    return deviceHasCapability(this.uda, capability);
  }

  /* Apply a door's reported state to HomeKit: the one place a door's position and lock reach their services, their MQTT tails, and their log lines.
   *
   * Both members are optional because the callers know different amounts. A UA Gate's location handlers carry a complete report every time; the door-state delivery
   * carries whatever the client's model has established. An ABSENT member updates nothing at all - not established is not a state, and writing a default for it
   * would manufacture a reading the controller never made.
   */
  private applyDoorState(doorState: { dps?: string; lock?: string }, isSideDoor: boolean): void {

    // Whether this delivery moved anything at all, which is what the opener's own update below reads.
    let changed = false;

    // Update lock state.
    if(doorState.lock !== undefined) {

      const newLockState = this.toLockState(doorState.lock);

      if(isSideDoor) {

        changed = this.#applyLockState(true, newLockState) || changed;
      } else {

        /* The opener renders from the position sensor and the relay together, so this delivery holds its update until the position reading below has landed as
         * well. Rendering from a half-applied pair would announce a state the door was never in, and would settle a running travel on the stale half of it.
         */
        this.#doorStateApplying = true;

        try {

          changed = this.#applyLockState(false, newLockState) || changed;
        } finally {

          this.#doorStateApplying = false;
        }
      }
    }

    // Update DPS state.
    if(doorState.dps !== undefined) {

      const newDpsState = this.toDpsState(doorState.dps);
      const currentDpsState = isSideDoor ? this._hkSideDoorDpsState : this.hkDpsState;

      if(newDpsState !== currentDpsState) {

        changed = true;

        const contactDetected = this.isClosed(newDpsState);

        if(isSideDoor) {

          this._hkSideDoorDpsState = newDpsState;
          this.setContactSensorState(AccessReservedNames.CONTACT_DPS_SIDE, newDpsState);
          this.mqttPublish(mqttTopics.sidedoorDps, contactDetected ? "false" : "true");

          if(this.hints.logDps) {

            this.log.info("Side door position sensor %s.", contactDetected ? "closed" : "open");
          }
        } else {

          this.hkDpsState = newDpsState;
          this.mqttPublish(mqttTopics.dps, contactDetected ? "false" : "true");

          if((this.doorServiceType === "GarageDoorOpener") || this.hints.logDps) {

            this.log.info("%s %s.", sentenceCase(DPS_LABEL), contactDetected ? "closed" : "open");
          }
        }
      }
    }

    /* One opener update per delivery, made now that both readings have landed. The opener belongs to the main door alone, and a delivery that told us nothing new
     * has nothing to tell it either: a travel settles on a reading that moved, or on its own expiry.
     */
    if(changed && !isSideDoor) {

      this.#updateGarageDoorState();
    }
  }

  // Handle remote unlock events.
  private handleRemoteUnlock(packet: AccessEventPacket): void {

    // For UA Gate hubs, determine which door was unlocked based on the event_object_id.
    if(this.uda.device_type === "UGT") {

      const door = this.#ownedDoor(packet.event_object_id);

      if(door === null) {

        return;
      }

      // The same hardware window a command of ours opens, begun on the controller's side instead, so it is settled and announced through the same helper.
      this.#openGateLockWindow(door === "side");
    } else {

      /* A hub other than a gate has no window of its own to open: its relock is the controller's own relay, reported back over the door-state rail. So the unlock
       * is applied here as one more reported reading, and an unlock the door-state rail has already delivered finds the door settled and stays silent rather than
       * announcing the same unlock a second time.
       */
      this.#applyLockState(false, this.hap.Characteristic.LockCurrentState.UNSECURED);
    }
  }

  /* Handle a device update, delivered once our own record has folded.
   *
   * Availability is deliberately absent from here: the spine's observe loop writes it from the same delivery, to every service that reports the characteristic, so
   * an arm here would be a second updater of one reading. Lock and door position are absent for the same reason - the door-state model carries both, and its
   * delivery owns them. The access method model is a reading this handler does own, under that same doctrine: the record restates its configuration rows on every
   * delivery, so this is where they reach the model, and the switches read the model rather than the rows.
   */
  private handleDeviceUpdate(): void {

    // A refresh restates the configuration rows, and folding them here is what keeps the model current when a bootstrap refresh moved a method with no v2 access
    // method event to announce it.
    this.#foldConfigRows();

    // Process any terminal input update events if our state has changed. Keying off whether the sensor exists is what replaces a cached eligibility reading: an
    // input with no service contributes nothing, and one created mid-run is picked up on the very next update.
    for(const { input, label, topic } of terminalInputs) {

      const reservedId = AccessReservedNames[("CONTACT_" + input.toUpperCase()) as keyof typeof AccessReservedNames];

      if(!this.accessory.getServiceById(this.hap.Service.ContactSensor, reservedId)) {

        continue;
      }

      const logKey = ("log" + input) as LogHintKey;
      const reading = this.terminalInputState(input);

      if(reading === this.getContactSensorState(reservedId)) {

        continue;
      }

      this.setContactSensorState(reservedId, reading);

      if(this.isWired(input)) {

        const contactDetected = this.isClosed(reading);

        this.mqttPublish(topic, contactDetected ? "false" : "true");

        if(this.hints[logKey]) {

          this.log.info("%s %s.", sentenceCase(label), contactDetected ? "closed" : "open");
        }
      }
    }

    // Project tampering ahead of the re-gate, so a sensor the re-gate creates on this delivery is dressed once, from the verdict this delivery established.
    this.projectTamperState();

    /* Re-derive every input's eligibility from the evidence this update brought with it. Running it unconditionally is what lets a wiring change or a multiplex flip
     * re-gate its services mid-run on any hub family rather than only on the one that happened to be checked for it, and the call is cheap and silent on repeat by
     * construction.
     */
    this.configureTerminalInputs();
  }

  /* Project tampering. The condition lives on this rail alone: the configure path adopts a baseline and dresses the sensors from it, and every change after that
   * arrives here, ahead of the delivery's re-gate. A reading that agrees with the one we hold is not a change, and nothing below describes anything but a change -
   * the characteristic, the topic, and the log alike - so a restated record moves none of them. A reading that is a change lands in the held verdict before the
   * re-gate runs, so a sensor the re-gate creates on this delivery is dressed once, from the verdict this delivery established.
   *
   * The characteristic and the topic both carry the condition itself, so each moves on every change, an adoption included. The characteristic reaches every
   * contact sensor through the library's sweep because every one of them carries it from creation, and the topic spells the reading's three answers as they are,
   * with unknown standing in for nothing established, so a subscriber holding unknown hears the reading return the moment it does. The log announces transitions
   * alone, because a reading seen for the first time is not one anybody observed. A reading the library withdraws - the console's tampering alert switched off,
   * so the hardware has stopped revising its tamper input - is a transition from a held verdict: a raised status clears, the change is said once, and the verdict
   * is forgotten so that the next reading to arrive is adopted on the log in silence exactly as a first sighting is.
   *
   * A raise and clear that both fall inside a connectivity gap is undetectable on any rail, since the controller keeps no tamper history and the notification
   * frames name no device...so what we project after a gap is simply where the hardware stands now.
   */
  private projectTamperState(): void {

    if(!isTamperCapable(this.uda)) {

      return;
    }

    const verdict = tamperState(this.uda);

    if(verdict === this.tamperVerdict) {

      return;
    }

    const held = this.tamperVerdict;

    this.tamperVerdict = verdict;
    updateServices(this.accessory, this.hap.Characteristic.StatusTampered, verdict ? this.hap.Characteristic.StatusTampered.TAMPERED :
      this.hap.Characteristic.StatusTampered.NOT_TAMPERED);
    this.mqttPublish(mqttTopics.tamper, String(verdict ?? "unknown"));

    // A first sighting is adopted without a word.
    if(held === undefined) {

      return;
    }

    // A security condition is worth a warning, its clearing a note, and its withdrawal a note that says why the status reads normal.
    switch(verdict) {

      case undefined:

        this.log.info("Tampering alerts are turned off on the controller, so the tamper status reads normal until they are turned on again.");

        break;

      case true:

        this.log.warn("Tampering detected.");

        break;

      case false:

        this.log.info("Tampering no longer detected.");

        break;
    }
  }

  // Handle device update v2 events.
  private handleDeviceUpdateV2(packet: AccessEventPacket): void {

    const data = packet.data as AccessEventDeviceUpdateV2;

    // Process access method updates. We only process entries with explicit "yes" or "no" values, ignoring any malformed entries that contain other values (e.g., key
    // names echoed back as values).
    if(data.access_method) {

      for(const [ key, value ] of Object.entries(data.access_method)) {

        if((value !== "yes") && (value !== "no")) {

          continue;
        }

        const accessMethod = accessMethods.find(entry => entry.key === key);

        if(accessMethod) {

          // The model takes the change before the switch is handed it, so what a switch reads and what it was pushed can never disagree. The catalog entry's own
          // key is the model's vocabulary, where the loop's is whatever the wire spelled.
          this.#foldMethodValue(accessMethod.key, value === "yes");
          this.accessory.getServiceById(this.hap.Service.Switch, accessMethod.subtype)?.updateCharacteristic(this.hap.Characteristic.On, value === "yes");
        }
      }

      /* An access method event on a device we know nothing about is the controller telling us it is answering, which makes a settings read worth another attempt.
       * The record's rows are folded first, in case a refresh has since brought them, and the dispatch owns every other condition on the launch. This packet's own
       * entries are deliberately not what seeds the model: the read answers for every method, where a packet speaks only for the ones that moved.
       */
      if(this.#accessMethodState.phase !== "seeded") {

        this.#foldConfigRows();
        this.#dispatchAccessMethodSeed();
      }
    }
  }

  // Handle doorbell ring events.
  private handleDoorbellRing(packet: AccessEventPacket): void {

    // Classify once at the head and read the typed payload from there. The classifier is pure and total, so a packet that isn't a ring simply doesn't match.
    const event = AccessClient.classifyPacket(packet);

    if(event?.kind !== "doorbellRing") {

      return;
    }

    if((event.payload.connected_uah_id !== this.uda.unique_id) || !this.hasCapability("door_bell")) {

      return;
    }

    /* The ring type declares door_guard_ids required because every capture carries it, but the library's runtime validator admits a ring on channel and device_id
     * alone, so the member can legally be absent at runtime and an unguarded read would throw out of the whole ring chain. The suppression exists because the type
     * says the fallback can never fire; the validator contract says otherwise.
     */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const guardIds = event.payload.door_guard_ids ?? [];

    // The discovery aid for configuring the door guard filter: every ring that reaches this point records the guard ids it carries.
    this.log.debug("Doorbell ring door guards: %s.", guardIds.join(", "));

    // An absent-or-empty guard list passes by the filter's own fail-open contract, so an unclassifiable ring can never be silenced.
    if(!doorbellRingAllowed({ filter: this.doorbellGuardFilter, guardIds })) {

      this.log.debug("Doorbell ring ignored: no door guard matched the configured filter.");

      return;
    }

    this.doorbellRingRequestId = event.payload.request_id;

    // Trigger the doorbell event in HomeKit.
    this.accessory.getService(this.hap.Service.Doorbell)?.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
      ?.sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

    // Update our doorbell trigger, if needed.
    this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, true);

    // Publish to MQTT.
    this.mqttPublish(mqttTopics.doorbell, "true");

    if(this.hints.logDoorbell) {

      this.log.info("Doorbell ring detected.");
    }
  }

  /* Publish and log who unlocked one of this hub's doors, from a webhook delivery.
   *
   * Ownership is the door alone. The hub that drives a door owns that door's unlocks, and the reader that presented the credential never publishes them, so one
   * physical unlock reaches exactly one accessory rather than every accessory that took part in it.
   *
   * Nothing here touches HomeKit state. The notification socket owns lock state and already reports the transition; this rail carries the attribution that socket
   * has no room for, which is why an attributed unlock produces the socket's line and this one rather than either replacing the other.
   */
  private handleUnlockDelivery(delivery: AccessConsumedWebhookDelivery<typeof ACCESS_WEBHOOK_EVENTS.doorUnlock>): void {

    const door = this.#ownedDoor(delivery.data.location.id);

    if(door === null) {

      return;
    }

    const attribution = unlockAttribution(delivery);
    const topic = (door === "side") ? mqttTopics.sidedoorUnlock : mqttTopics.unlock;

    this.mqttPublish(topic, JSON.stringify(attribution));

    // The sentence is composed rather than formatted in place, because the door's name is whatever an administrator called it and has no business being read as a
    // format string.
    if(this.hints.logLock) {

      this.log.info("%s", describeUnlock({ attribution, door: delivery.data.location.name }));
    }
  }

  /* Log how a doorbell call ended, from a webhook delivery.
   *
   * Ownership is the hub the ringing reader hangs off, keyed exactly as the notification socket's own ring is: the delivery names the reader that rang and that
   * reader's record names its hub. The delivery's own host member reads empty on every capture, so the connection is the only thing that names the hub at all.
   *
   * There is no MQTT topic for an outcome. A call ending is a fact about the call rather than about the door, and the doorbell topic already carries the ring and
   * its cancellation.
   */
  private handleDoorbellOutcome(delivery: AccessConsumedWebhookDelivery<typeof ACCESS_WEBHOOK_EVENTS.doorbellCompleted>): void {

    if(delivery.data.device?.connected_hub_id !== this.uda.unique_id) {

      return;
    }

    if(this.hints.logDoorbell) {

      this.log.info("Doorbell call ended: %s", doorbellOutcome(delivery.data.object.reason_code));
    }
  }

  // Handle doorbell cancel events.
  private handleDoorbellCancel(packet: AccessEventPacket): void {

    const event = AccessClient.classifyPacket(packet);

    if(event?.kind !== "doorbellCancel") {

      return;
    }

    if(this.doorbellRingRequestId !== event.payload.remote_call_request_id) {

      return;
    }

    this.doorbellRingRequestId = null;

    // Update our doorbell trigger, if needed.
    this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, false);

    // Publish to MQTT.
    this.mqttPublish(mqttTopics.doorbell, "false");

    if(this.hints.logDoorbell) {

      this.log.info("Doorbell ring cancelled.");
    }
  }

  // Handle hub-related events.
  private eventHandler(packet: AccessEventPacket): void {

    switch(packet.event) {

      case "access.data.device.remote_unlock":

        this.handleRemoteUnlock(packet);

        break;

      case ACCESS_DEVICE_UPDATE_EVENT:

        this.handleDeviceUpdate();

        break;

      case "access.data.v2.device.update":

        this.handleDeviceUpdateV2(packet);

        break;

      case "access.remote_view":

        this.handleDoorbellRing(packet);

        break;

      case "access.remote_view.change":

        this.handleDoorbellCancel(packet);

        break;

      default:

        break;
    }
  }
}
