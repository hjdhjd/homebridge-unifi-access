/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hub.ts: Unified hub and reader device class for UniFi Access.
 */
import { ACCESS_DEVICE_UPDATE_EVENT, ACCESS_REMOTE_UNLOCK_EVENT } from "../controller/events.ts";
import { ACCESS_UNLOCK_ACTOR, ACCESS_WEBHOOK_EVENTS } from "../settings.ts";
import { AccessAbortedError, AccessCapabilityError, AccessClient, AccessDeclinedError, accessMethodStates, deviceAccessMethodStates, isHub, isReader,
  isTamperCapable, portBindings, tamperState, terminalInput } from "unifi-access";
import type { AccessDevice as AccessDeviceProjection, AccessDoorStateEntry, AccessEventPacket, AccessHub as AccessHubProjection, AccessMethod, AccessStateDevice,
  AccessStateDoor, AccessTerminalInput, AccessTerminalInputFacts } from "unifi-access";
import type { AcquireServiceResult, Nullable } from "homebridge-plugin-utils";
import type { CharacteristicValue, Service } from "homebridge";
import type { DoorServiceType, HubSensorName, LogEventName } from "../policy.ts";
import { accessMethodChoices, accessMethods, describeUnlock, deviceHasCapability, discoverDoorLocations, doorbellOutcome, doorbellReaderId, doorbellRingAllowed,
  doorbellTriggerAction, dpsSensorEligible, gateDoorRelayKey, hubSensorChoices, lockCommandRule, logEventChoices, resolveDoorService,
  unlockAttribution } from "../policy.ts";
import { capabilityGate, findService, formatErrorMessage, getServiceName, guardedDispatch, presenceChanged, updateServices,
  validCharacteristic } from "homebridge-plugin-utils";
import type { AccessAccessory } from "../types.ts";
import type { AccessConsumedWebhookDelivery } from "./device.ts";
import type { AccessController } from "../controller/controller.ts";
import { AccessDevice } from "./device.ts";
import { AccessReservedNames } from "../types.ts";
import { mqttTopics } from "../mqtt.ts";

/* The access method state a reader's switches read, one model per device serving both client identities. The values map is keyed by the library's name for each
 * method and holds whether each method is enabled. Seeding is what gates switch existence: an unseeded device keeps whatever services it has and creates none,
 * because absence of knowledge is not knowledge of absence, while a seeded device creates and retires switches from what the model actually holds.
 *
 * The unseeded and seeding phases carry whether the current streak of refused settings reads has been announced: the refusal that opens a streak warns, and every
 * retry inside it inherits the mark and stays silent. A seeded model carries no such member, so reaching seeded ends the streak by construction.
 */
type AccessMethodState = { readonly phase: "seeding"; readonly refused: boolean } | { readonly phase: "seeded"; readonly values: Map<AccessMethod, boolean> } |
  { readonly phase: "unseeded"; readonly refused: boolean };

// The unseeded state every device starts from, with nothing read and no refusal announced. A transition always replaces the whole field and no site mutates this
// object, so one instance serves every device.
const ACCESS_METHOD_UNSEEDED: AccessMethodState = { phase: "unseeded", refused: false };

/* The dry contact inputs that share one shape: a wiring-evidence gate, a state reading, and an MQTT tail of their own. Each input's HomeKit-facing name and the
 * catalog key its MQTT topic is read by sit here together, so that configuration and live updates cannot drift on either. The key is named rather than the tail
 * spelled, so the catalog stays the one place a topic is written, and the key is what the hub's publish and payload reader take. The library's own name for the
 * terminal sits beside the HomeKit name, so the reading, the option, and the topic of one input are spelled together. The label is carried in the title case a
 * service name wants; the log lines derive the other casings they need from it, so each input is spelled here exactly once.
 *
 * The member is the name this input answers to in each of the hub's pick lists and the suffix its reserved subtype is composed from, typed against the policy
 * module's own member names so a spelling that names no member is a compile error here rather than a sensor that silently never appears.
 *
 * The door position sensor is deliberately not one of them. Every one of the things that shape a terminal input differs for it - where its eligibility comes from,
 * where its state comes from, and how it reaches HomeKit - so it is configured and updated on its own rather than forced through a loop that would have to special
 * case it at every step.
 */
const terminalInputs = [

  { label: "Remote Release", member: "REL", terminal: "rel", topic: "rel" },
  { label: "Request to Enter Sensor", member: "REN", terminal: "ren", topic: "ren" },
  { label: "Request to Exit Sensor", member: "REX", terminal: "rex", topic: "rex" }
] as const satisfies readonly { label: string; member: HubSensorName & LogEventName; terminal: AccessTerminalInput; topic: AccessStateTopic }[];

// A catalog key naming a terminal input's topic, read off the table above so an input added there is a topic the hub answers for.
type AccessTerminalTopic = (typeof terminalInputs)[number]["topic"];

/* A catalog key naming a topic a hub publishes on: every entry but the availability statement, which the device base states for itself, and telemetry, which is
 * the controller's raw feed, published under the controller's own identity rather than a device's. A topic added to the catalog lands here by default, which is
 * what makes it fail compilation in the table below and in the hub's answer to whether the topic's control exists, until its kind and its control are decided.
 */
type AccessHubTopic = Exclude<keyof typeof mqttTopics & string, "availability" | "telemetry">;

/* Whether each hub topic reports held state rather than a momentary event. A topic reporting held state is restated when a broker session begins, while a
 * momentary topic - a ring and its end, an unlock and who performed it - never is, because a replayed event is the event happening a second time. The record names
 * every hub topic, so a topic added to the catalog fails compilation here until its kind is decided, and the held state topics' type is read off it.
 */
const HELD_STATE = { doorbell: false, dps: true, lock: true, rel: true, ren: true, rex: true, sidedoorDps: true, sidedoorLock: true, sidedoorUnlock: false,
  tamper: true, unlock: false } as const satisfies Readonly<Record<AccessHubTopic, boolean>>;

// A hub topic reporting held state, which the hub's payload reader answers for and a broker session restates.
type AccessStateTopic = { [K in AccessHubTopic]: (typeof HELD_STATE)[K] extends true ? K : never }[AccessHubTopic];

// A hub topic reporting a momentary event, whose payload is the event itself rather than a reading the hub holds.
type AccessMomentaryTopic = Exclude<AccessHubTopic, AccessStateTopic>;

// The held state topics in the table's own order, resolved once for every hub, which is what a broker session walks.
const HELD_STATE_TOPICS = (Object.keys(HELD_STATE) as AccessHubTopic[]).filter((key): key is AccessStateTopic => HELD_STATE[key]);

// A hub topic the catalog gives a get or a set, which a subscriber can ask or command rather than only hear, read off the catalog's own entries.
type AccessAnsweredTopic = { [K in AccessHubTopic]: (typeof mqttTopics)[K] extends { readonly get: string } | { readonly set: string } ? K : never }[AccessHubTopic];

/* The whole sensor member table, as the domain every read of the selection is taken against. It is the WHOLE table and never a per-model narrowing, so an
 * unconfigured hub of any model - one no table names included - carries every sensor its wiring supports, and the capability evidence alone decides. The narrowing
 * to a model is the settings page's job alone.
 */
const HUB_SENSOR_DOMAIN = hubSensorChoices().map(choice => choice.value);

// The HomeKit-facing name of the door position sensor. It sits beside the table above rather than in it, because everything else about it diverges.
const DPS_LABEL = "Door Position Sensor";

// The HomeKit-facing name of the side door position sensor, beside the main door's for the same reason.
const SIDE_DOOR_DPS_LABEL = "Side Door Position Sensor";

/* Which pass a configure path is running as. At adoption, the services the accessory arrived carrying - restored from Homebridge's accessory cache with the values
 * they last held and none of their handlers - have been dressed by nobody, so every service the pass acquires is dressed: its handlers, its primary marking, and its
 * starting values. On every later pass, the re-gate a device update or a door-state delivery runs, those services were dressed at adoption, so only a service the
 * pass creates is. The pass states the one fact the library cannot know: the transition a service helper answers tells a created service from a found one, and only
 * the caller knows whether a found service was dressed already.
 */
interface ConfigurePass {

  readonly initialized: boolean;
}

// An input label as a sentence opens it: the first word's capital kept and the rest lowered. This is what lets one spelling in the table above serve a service name,
// a mid-sentence mention, and a sentence-leading one.
function sentenceCase(label: string): string {

  return label.charAt(0) + label.slice(1).toLowerCase();
}

// A sentence that continues one already opened: its first character lowered. The library glosses a doorbell outcome as a complete sentence of its own, and the
// line carrying it names the call ahead of a colon, so the gloss has to read as the rest of that sentence rather than as a second one starting mid-line.
function lowerFirst(text: string): string {

  return text.charAt(0).toLowerCase() + text.slice(1);
}

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
// How long a UA Gate's unlock window stays open before the auto-relock settles the lock back to secured. The controller reports no relock event of its own for
// a UA Gate the way it does for other hub types, so this borrows the gate's own default travel duration as the closest available estimate of when the gate
// has swung shut again.
const AUTO_LOCK_DELAY_MS = 5000;
// How long we wait before putting a characteristic back after the command behind it was refused. The pause lets HomeKit's own write settle first, so the HomeKit
// client sees the correction as a fresh value rather than as a race against the write it just made.
const CHARACTERISTIC_REVERT_DELAY_MS = 50;
// How long a dispatched doorbell ring or cancel waits before settling the trigger switch back onto the mirrored ring state: long enough for the controller's own
// ring notification to arrive and win, short enough that a ring the notification stream never confirms is corrected while the user is still looking at the switch.
const DOORBELL_TRIGGER_RECONCILE_DELAY_MS = 5000;
// How long a UA Gate is given to travel when no duration has been configured for it. A gate's motion is short and much the same from one installation to the next,
// where a garage door's travel time varies with the door, so a default serves the one and not the other.
const GATE_TRANSITION_DURATION_MS = 5000;
// The key the main door's transition timer is tracked under. It is stated once so the arm, the re-arm, and the cancel can never name different timers.
const DOOR_TRANSITION_TIMER_KEY = "door-transition";

/* One UniFi Access hub or reader as a HomeKit accessory: its door presentation, sensors, triggers, access method switches, doorbell, and MQTT surface, all driven
 * from the controller's live state.
 */
export class AccessHub extends AccessDevice {

  private _hkDpsState: CharacteristicValue;
  private _hkLockState: CharacteristicValue;
  private _hkSideDoorDpsState: CharacteristicValue;
  private _hkSideDoorLockState: CharacteristicValue;
  private readonly doorbellGuardFilter: readonly string[];
  // The request id of the ring that is standing, or null while the doorbell is quiet; the trigger switch and the get topic mirror it, and only a cancel naming it
  // ends the ring.
  private doorbellRingRequestId: string | null;
  // The configured relock hold in minutes: undefined leaves the door on the default momentary unlock, and 0 holds it unlocked indefinitely.
  private lockDelayInterval: number | undefined;
  // The tamper reading we last projected, or undefined until the record has told us anything. Holding it is what lets a genuine change be told from a first sighting.
  private tamperVerdict: boolean | undefined;
  /* Whether an access method refresh is still out. It bounds the refresh to one in flight per device and is read nowhere else: the seed gets its one read at a time
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
  #foldedConfigValues: Map<AccessMethod, boolean> | undefined;
  /* The doors a UA Gate drives, as discovery last resolved them - the one value every reader of a gate's identities takes. Discovery alone writes it and every
   * reader reaches it through #drivenDoors, and it is held as the enumeration itself rather than as the two identities behind it so the door-state delivery every
   * hub on the controller receives reads it without building one.
   */
  #gateDoors: readonly DrivenDoor[];
  /* Which pass the next switch loop runs as. The loop's first seeded run is the switches' adoption whatever call reached it, because a record carrying configuration
   * rows seeds synchronously at construction and one carrying none seeds from the settings read, so the pass is held here rather than read from the call site. It
   * flips once the loop has run, and it dies with the instance, so a hub re-adopted on the same accessory dresses every switch again - which is what the handlers
   * require, being closures over this instance.
   */
  #switchPass: ConfigurePass;
  /* Whether each held state topic's evidence was present when the topic was last weighed: at adoption, and at every publish of it. Holding it is what lets
   * evidence that moves while the reading stays put still reach the topic, because the payload says unknown without that evidence, and a reading that never moves
   * would otherwise never tell a subscriber the evidence went or came back.
   */
  #topicEvidence: Map<AccessStateTopic, boolean>;
  /* The lifetime each answered topic's get and set registrations were made under, held exactly while the topic's control exists. The reconcile opens one when the
   * control appears and aborts it when the control goes, so a topic answers exactly while HomeKit shows what it describes, and the device's own end releases
   * every registration through the composed signal without anything here having to touch it.
   */
  #topicLifetimes: Map<AccessAnsweredTopic, AbortController>;

  // Create an instance.
  constructor(controller: AccessController, projection: AccessDeviceProjection, accessory: AccessAccessory, admission: AccessStateDevice & { mac: string },
    hubProjection?: AccessHubProjection) {

    super(controller, projection, accessory, admission, hubProjection);

    // The readings a door starts from before the door-state map is consulted: the main position is assumed closed, and the locks and the side door's position are
    // read from the record's relay and terminal rows where the hardware carries them, and secured or closed otherwise. The door-state map settles them afterwards,
    // through configureDevice() for a single-door hub and through initializeDoorStates() for a UA Gate.
    this._hkDpsState = this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    this._hkLockState = this.hubLockState;
    this._hkSideDoorDpsState = this.hubSideDoorDpsState;
    this._hkSideDoorLockState = this.hubSideDoorLockState;
    this.doorbellGuardFilter = this.getFeatureValueList("Hub.Doorbell.DoorGuards");
    this.lockDelayInterval = this.getFeatureNumber("Hub.LockDelayInterval") ?? undefined;
    this.doorbellRingRequestId = null;
    this.tamperVerdict = undefined;
    // Nothing has been heard about this device's access methods yet, which configureDevice() settles below from whichever rail can answer for it, and no refresh has
    // been asked for.
    this.#accessMethodRefreshInFlight = false;
    this.#accessMethodState = ACCESS_METHOD_UNSEEDED;
    this.#doorStateApplying = false;
    // A door we have not been asked to move is standing still, which is the only honest reading before anything has been commanded.
    this.#doorTransition = { phase: "idle" };
    this.#foldedConfigValues = undefined;
    this.#gateDoors = [];
    // No switch loop has run on this instance, so the first one is the switches' adoption.
    this.#switchPass = { initialized: false };
    // No topic's evidence has been weighed until configureDevice() adopts it below.
    this.#topicEvidence = new Map();
    // Nothing answers on any topic until the adoption pass has found the controls the topics describe.
    this.#topicLifetimes = new Map();

    // If we attempt to set the delay interval to something invalid, then assume we are using the default unlock behavior.
    if((this.lockDelayInterval !== undefined) && (this.lockDelayInterval < 0)) {

      this.lockDelayInterval = undefined;
    }

    /* A construction that fails part way has already started this device's record loop and registered its final word, each bound to a lifetime only cleanup()
     * ends, and nothing holds the instance to call it. Ending that lifetime before the failure leaves here is what keeps the adoption the next membership change
     * retries from standing a second live instance beside this one on the same accessory.
     */
    try {

      this.configureHints();
      this.configureDevice();
    } catch(error) {

      this.cleanup();

      throw error;
    }
  }

  /* Configure device-specific settings for this device.
   *
   * This runs once, from the constructor, so what lands here is the settings a hub reads at adoption and keeps for the life of the accessory: the side door's own
   * setting, and which event categories are announced in the log. The sensor selection is deliberately not among them - it is read at the gate instead, for the
   * reason the helper below states.
   */
  protected override configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    this.hints.hasSideDoor = (this.uda.device_type === "UGT") && this.hasFeature("Hub.SideDoor");

    /* The cast states what the engine already guarantees: a domain-narrowed read answers members of the domain it was handed and nothing else, and the domain
     * here is the member table those names are derived from. Holding the selection as a set of the member type is what lets every logging site below name its
     * category as a literal the compiler checks.
     */
    this.hints.logEvents = new Set(this.getFeatureValueList("Log.Events", logEventChoices().map(choice => choice.value)) as readonly LogEventName[]);

    /* A selection the user emptied is a deviation from the default that nothing else in the log would state, so the hub states it here, once, at the one read of
     * the list. A narrowed selection needs no summary: each category that is still on announces itself as it speaks.
     */
    if(!this.hints.logEvents.size) {

      this.log.info("No event categories enabled.");
    }

    return true;
  }

  /* The contact sensors the user has selected, read afresh on every call against the whole member table.
   *
   * This is never cached in a hint. The gates that consume it read it on every configure pass - at adoption and again on every device update - so there is one
   * reading of the selection and no cached copy of it to go stale.
   *
   * @returns The selected member names, in the table's own order.
   */
  #selectedSensors(): readonly string[] {

    return this.getFeatureValueList("Hub.Sensors", HUB_SENSOR_DOMAIN);
  }

  /* Whether this device's model offers any contact sensor at all, read through the same list the settings page narrows its own picker with, so the hub and the
   * page agree on what a model carries rather than each deciding for itself.
   *
   * The model is resolved rather than read off the record, because a record the official API answers with carries a device type and no display model of its own,
   * and a bare read would answer that every token-reached hub offers nothing.
   *
   * @returns True when the model drives at least one member of the sensor table.
   */
  #offersSensors(): boolean {

    // eslint-disable-next-line camelcase
    return hubSensorChoices({ capabilities: this.uda.capabilities, display_model: this.controller.resolveDeviceModel(this.uda) }).length > 0;
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

  /* The doors a UA Gate drives, resolved from the record's published port bindings and the live topology through the policy module's shared statement, with the
   * side arm gated on the user's side-door preference. It answers the doors whose identity this resolution moved, so the caller can seed exactly those, and a
   * topology the client has not learned yet leaves the last resolution standing rather than withdrawing every door behind it.
   *
   * The policy is handed the roles this resolution last landed on, on every pass past adoption and never on adoption itself. It keeps them through a record carrying no
   * relay data, and such a record binding no known door moves nothing and fills nothing. The instance holds them and nothing persists them, so a restart adopts and
   * guesses afresh. A first pass that finds no doors returns before reaching the policy, so a later pass finding doors on a record saying nothing leaves the roles vacant
   * until a record binds a known door or carries relay data...that is the cost of a silent record never choosing a door, and a role such a record leaves empty refuses
   * rather than guesses.
   *
   * A role whose occupant changed - a door moved into it, or the role withdrawn outright - takes the relock window opened for the door that left with it. A window
   * of ours belongs to the door it was opened for, and one left standing would relock whichever door now holds the role, or services standing at their last
   * reading. The registry's clear does nothing to an unarmed key, so the construction pass retires nothing.
   *
   * A door identity moving mid-run is a lifecycle event, which is what earns each one a line. Construction announces no door: its previous enumeration is the empty
   * seed, so every door it resolves counts as moved, and an adoption is not a transition anyone observed. A pass that moved a role, adoption included, also says
   * what the bindings were and what they resolved to, so a field report carries its own evidence. An adoption that resolved no role says the same, because it moved
   * nothing and would otherwise leave the gate silent until its first refused command. Roles the bindings named are said at debug level. Roles that were guessed
   * are said as a warning, because a guessed door can be the wrong one and only the user can tell.
   *
   * @param options - The pass this discovery is running as.
   *
   * @returns The doors whose identity this discovery moved.
   */
  private discoverDoorIds({ initialized }: ConfigurePass): readonly DrivenDoor[] {

    const doors: AccessStateDoor[] = [...this.controller.client.state.snapshot().doors.values()];

    if(doors.length === 0) {

      if(!initialized) {

        this.log.warn("The controller reports no doors, so this hub's door events cannot be matched to a door.");
      }

      return [];
    }

    const discovered = discoverDoorLocations({ device: this.uda, doors: doors,
      held: initialized ? { mainDoorLocationId: this.#gateDoor(false), sideDoorLocationId: this.#gateDoor(true) } : undefined,
      sideDoorEligible: this.hints.hasSideDoor });
    const previous = this.#gateDoors;
    const next: DrivenDoor[] = [];

    if(discovered.mainDoorLocationId) {

      next.push({ isSideDoor: false, locationId: discovered.mainDoorLocationId });
    }

    if(discovered.sideDoorLocationId) {

      next.push({ isSideDoor: true, locationId: discovered.sideDoorLocationId });
    }

    this.#gateDoors = next;

    const moved: DrivenDoor[] = [];
    let changed = false;

    for(const isSideDoor of [ false, true ]) {

      const departing = previous.find(door => door.isSideDoor === isSideDoor);
      const arriving = next.find(door => door.isSideDoor === isSideDoor);

      if(departing?.locationId === arriving?.locationId) {

        continue;
      }

      changed = true;
      this.timers.clear(this.#relockTimerKey(isSideDoor));

      const role = isSideDoor ? "side door" : "main door";

      if(!arriving) {

        if(initialized) {

          this.log.warn("The controller no longer reports a door for the gate's " + role + "; its accessories keep the last state they showed.");
        }

        continue;
      }

      moved.push(arriving);

      if(initialized) {

        // Every role names a door the topology carries, so the find always answers here and the identity beside it exists only for the type.
        this.log.info("The gate's " + role + " is now " + (doors.find(door => door.unique_id === arriving.locationId)?.name ?? arriving.locationId) + ".");
      }
    }

    /* The bindings are read here rather than handed back by the policy, which answers with the door identities and what decided them, and only on a pass that
     * moved a role or an adoption that resolved none. Each binding renders as the name the controller wrote beside it, its port, and its door, with an absent name or
     * port said as such, and each line below carries that one rendering.
     */
    if(changed || (!initialized && !next.length)) {

      const bindings = portBindings(this.uda).map(binding => (binding.name ?? "unnamed") + " on " + (binding.port ?? "an unnamed port") + " bound to " + binding.doorId);
      const renderedBindings = bindings.length ? bindings.join(", ") : "none";
      const mainDoor = next.find(door => !door.isSideDoor)?.locationId;
      const sideDoor = next.find(door => door.isSideDoor)?.locationId;

      if(discovered.basis === "guess") {

        // The warning names every door by its topology name and identity, so a user can check each one against the controller, and by its identity alone where
        // the topology has not learned it.
        const describeDoor = (locationId?: string): string => {

          if(!locationId) {

            return "no door";
          }

          const name = doors.find(door => door.unique_id === locationId)?.name;

          return name ? (name + " (" + locationId + ")") : locationId;
        };

        this.log.warn("Unable to tell this gate's doors apart from its port bindings, so its main door was matched to %s and its side door to %s. If both are " +
          "right, there is nothing to do. The port bindings are %s, the device's door is %s, and its location is %s.", describeDoor(mainDoor), describeDoor(sideDoor),
        renderedBindings, describeDoor(this.uda.door?.unique_id), describeDoor(this.uda.location_id));
      } else {

        this.log.debug("Gate doors resolved from the port bindings (%s) to main door %s and side door %s.", renderedBindings, mainDoor ?? "none", sideDoor ?? "none");
      }
    }

    return moved;
  }

  /* Seed our door states from the client's door state map, which every connect mode populates. The door topology records carry no status of their own - position and
   * lock live in the door state map, keyed by the door's own identity - so this is where the answer is. A door the controller has said nothing about, or one whose
   * entry is silent on a member, falls back to closed and secured, the safe reading before anything has been heard.
   *
   * Every seed here reaches HomeKit rather than the backing field alone. This runs after the services are configured, and the relay rows they were built from can
   * disagree with what the door state map says - so a characteristic left holding the record's reading would render a stale door until that door next moved. The
   * locks go through their setters, whose early return on an agreeing reading makes the two sources agreeing cost nothing; the side door's position has no accessor pair,
   * so it takes the file's own idiom for that field - the assignment followed by an explicit push. Adoption stays silent throughout, with no MQTT tail and no log
   * line, because a reading we are seeing for the first time is not a transition anyone observed. A pass past adoption states each moved door's lock topic and writes no
   * log line, because a subscriber still holds the reading of the door that left the role.
   *
   * It seeds exactly the doors it is handed, which is every door a gate drives at construction and whichever doors a rebind moved afterwards.
   *
   * @param doors - The doors to seed.
   * @param pass  - The pass this seed is running as.
   */
  private initializeDoorStates(doors: readonly DrivenDoor[], { initialized }: ConfigurePass): void {

    for(const door of doors) {

      const entry = this.#doorEntry(door.locationId);

      if(door.isSideDoor) {

        this._hkSideDoorDpsState = this.toDpsState(entry?.dps ?? "close");
        this.setContactSensorState(AccessReservedNames.CONTACT_DPS_SIDE, this._hkSideDoorDpsState);
        this.hkSideDoorLockState = this.toLockState(entry?.lock ?? "lock");
      } else {

        this.hkDpsState = this.toDpsState(entry?.dps ?? "close");
        this.hkLockState = this.toLockState(entry?.lock ?? "lock");

        // Update the door service.
        if(this.doorServiceType === "GarageDoorOpener") {

          this.updateDoorServiceState(false);
        }
      }

      if(initialized) {

        this.#publishTopic({ key: door.isSideDoor ? "sidedoorLock" : "lock" });
      }
    }
  }

  /* Every evidence-gated and capability-gated service this hub offers, configured from the record as it stands. It runs once at construction and again on every
   * device update, so a capability appearing or disappearing, a port rebound in Access whose record carries its relay data, and a wiring change all reach HomeKit
   * without a restart.
   *
   * A UA Gate re-resolves its doors first, so every service below reads the current enumeration, and the doors that moved are seeded last, once their services
   * exist. The order within is the construction order the position sensor's dependency fixes: the terminal inputs before the lock, so the position sensor exists
   * when a garage door opener derives its state from it. Each path is silent on repeat by construction, so a pass over a record that did not change costs a
   * handful of service lookups and feature option reads, and writes nothing.
   *
   * The topics a subscriber can ask or command follow the services last, once every control this pass could move stands where the pass left it.
   *
   * @param pass - The pass these paths are running as.
   */
  #configureServices(pass: ConfigurePass): void {

    const rebound = (this.uda.device_type === "UGT") ? this.discoverDoorIds(pass) : [];

    this.configureTerminalInputs(pass);
    this.configureSideDoorTerminalInputs(pass);
    this.configureLock(pass);
    this.configureLockTrigger(pass);
    this.configureSideDoorLock(pass);
    this.configureSideDoorLockTrigger(pass);
    this.configureDoorbell(pass);
    this.configureDoorbellTrigger(pass);
    this.initializeDoorStates(rebound, pass);
    this.#reconcileTopicAnswers();
  }

  // Initialize and configure the hub or reader accessory for HomeKit.
  private configureDevice(): void {

    this._hkLockState = this.hubLockState;
    this._hkSideDoorDpsState = this.hubSideDoorDpsState;
    this._hkSideDoorLockState = this.hubSideDoorLockState;

    /* Seed our door state from what the controller has established about the door we drive, before any service is configured against it. A door the controller has
     * said nothing about, or one whose entry is silent on a member, falls back to closed and secured, the safe reading before anything has been heard. This
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

    // Adopt the evidence behind each held state topic the same silent way, so the first rail to move that evidence is weighed against what adoption found.
    for(const key of HELD_STATE_TOPICS) {

      this.#topicEvidence.set(key, this.#evidencePresent(key));
    }

    /* Clean out the context object in case it's been polluted somehow, then record what an accessory carries for the life of the pairing: the hardware it names,
     * the controller that created it, and the device identity it was minted under - the last being what tells a startup sweep that this accessory is the
     * identity's own rather than one created under an earlier form. The record is written through the persistence, which marks the accessory for the next save as
     * it writes, and the save window that mark opens or joins carries whatever the rest of adoption sets up on the accessory with it.
     */
    this.accessory.context = {};
    this.platform.persistence.persist(this.accessory, { controller: this.controller.ownershipKey, id: this.id, mac: this.mac });

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

    /* Tell the user, once at adoption, when the controller's name for this device has nothing HomeKit can display and the accessory carries the name the rule fell
     * back to in its place. The name weighed is the information service's as homebridge-plugin-utils reads it, the configured name where the service carries one
     * and its name otherwise, never adding a configured name the service lacks. That is what tells the fallback apart from a Home app rename written into the
     * configured name, which exists once a plugin rename has written one, while the name beside it stays on the fallback. An accessory carrying any other name is
     * left unwarned, because the line would describe a name it does not carry, and the record loop never warns, so a rename later in the run does not repeat it. A
     * custom name the user set names the device ahead of the controller's name, so the rule passes nothing over and the line, which points the user at that
     * setting, never speaks while one is in force.
     */
    const { name, passedOver } = this.homeKitNaming;

    if((passedOver !== null) && (getServiceName(this.accessory.getService(this.hap.Service.AccessoryInformation)) === name)) {

      this.log.warn("The name \"%s\" leaves nothing HomeKit can display, so this device is named %s until a Name set in the plugin's settings replaces it.",
        passedOver, name);
    }

    // Configure access method switches, if we're a reader device.
    this.configureAccessMethodSwitches();

    // The service pass, run here as adoption: nothing has dressed anything on this accessory yet, so every service the pass acquires is dressed from what we hold.
    this.#configureServices({ initialized: false });

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    const handler = this.eventHandler.bind(this);

    this.registerListener(this.uda.unique_id, handler);
    this.registerListener("access.remote_view", handler);
    this.registerListener("access.remote_view.change", handler);

    // Listen for each webhook delivery this plugin consumes. Deliveries go through their own rail rather than the packet handler above, because a delivery and a socket
    // frame of the same name carry entirely different payloads.
    this.registerDeliveryListener(ACCESS_WEBHOOK_EVENTS.doorUnlock, (delivery) => this.handleUnlockDelivery(delivery));
    this.registerDeliveryListener(ACCESS_WEBHOOK_EVENTS.doorbellCompleted, (delivery) => this.handleDoorbellOutcome(delivery));

    /* Every hub subscribes to remote unlocks by event name. The controller delivers them under the identity of the door for a gate and under the identity of the hub
     * that performed the unlock for everything else, and the rail emits each packet under its event name and under that identity alike - so the subscription is by
     * name for every family, ownership is settled at delivery from the identity the packet names, and the general packet handler leaves this event alone, which is
     * what keeps the rail's second emission under this hub's own identity from being a second delivery.
     */
    this.registerListener(ACCESS_REMOTE_UNLOCK_EVENT, (packet) => this.handleRemoteUnlock(packet));

    /* State this device's availability once adoption is complete. Neither trigger that restates it reaches a device at adoption: the record loop yields on the first
     * change after it starts rather than on the record it starts from, and the controller's connection observer walks on a transition alone, so a device adopted
     * mid-session would otherwise withhold the statement until its record next moved.
     */
    this.publishAvailability();
  }

  // Configure the access method switches for HomeKit.
  private configureAccessMethodSwitches(): void {

    /* Switches are created and retired from what we actually know about this device's access methods, and never from what we have yet to hear. A record carrying
     * configuration rows answers synchronously, right here; a record carrying none is answered by the official settings read the dispatch below launches. Until one
     * of them has landed, every service the accessory already carries is left exactly as it is and none is created - absence of knowledge is not knowledge of
     * absence, and retiring a switch on a start where the read failed would take the automations behind it with it.
     */
    this.#foldConfigRows();

    if(this.#accessMethodState.phase !== "seeded") {

      this.#dispatchAccessMethodSeed();

      return;
    }

    // The methods the user selected switches for, read afresh on every pass so a changed selection is what the next pass materializes or retires, and read
    // against the catalog's own spellings so a hand-written entry selects a method in whatever case it named it.
    const selected = this.getFeatureValueList("AccessMethod.Switches", accessMethodChoices().map(choice => choice.value));
    const { initialized } = this.#switchPass;

    for(const accessMethod of accessMethods) {

      // Validate whether we should have this service enabled.
      const { service, transition } = this.validService({ serviceType: this.hap.Service.Switch, subtype: accessMethod.subtype, suffix: " " + accessMethod.name,
        validate: isReader(this.uda) && this.hasCapability(accessMethod.capability) && selected.includes(accessMethod.choice) });

      if(!service) {

        continue;
      }

      /* The handlers are registered the first time this hub holds the switch: they read the model live and are closures over this instance, so a repeat pass
       * registers nothing on a switch already standing. A switch this pass attached was dressed by nobody, whichever pass this is.
       */
      if(!initialized || (transition === "attached")) {

        // Retrieve the state when requested, through the device's Not Responding rule like every reader.
        service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.#accessMethodEnabled(accessMethod.method)));

        /* Set the state when requested. The library routes the write - the official settings write and its read-back first, the Access application's own endpoints
         * where the client holds credentials - and reads answer from the access method state model, which the record's configuration rows and the official
         * settings read feed.
         */
        service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(async (value: CharacteristicValue) => {

          const enabled = value === true;

          try {

            await this.projection.setAccessMethod(accessMethod.method, enabled, { signal: this.signal });
          } catch(error) {

            /* A device on its way out has nothing to put back and no one to tell, so teardown passes in silence. The abort is tested ahead of every other arm,
             * because a decline the controller answered after teardown began is still teardown's to swallow.
             */
            if(this.signal.aborted || (error instanceof AccessAbortedError)) {

              return;
            }

            // The controller answered success while leaving the setting unchanged, which only the read-back can reveal, so the switch reverts to that truth. Any
            // other failure means no path carried the write, and the cause is noted for whoever needs the detail.
            if(error instanceof AccessDeclinedError) {

              this.log.error("The controller declined the %s access method change.", accessMethod.name);
            } else {

              this.log.error("Unable to %s the %s access method.", enabled ? "activate" : "deactivate", accessMethod.name);
              this.log.debug("The access method write was refused: %s.", formatErrorMessage(error));
            }

            this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !enabled), CHARACTERISTIC_REVERT_DELAY_MS);

            return;
          }

          /* The switch already carries the value HomeKit wrote, and the model takes it too: a completed write is the freshest thing anyone knows about the method,
           * so a read arriving before the controller's own echo answers what the write established rather than the rows the record has yet to restate. The
           * record's rows keep the model current from there.
           */
          this.#foldMethodValue(accessMethod.method, enabled);
        }));
      }

      /* Initialize the switch from the same model its reads answer from, so what HomeKit is handed and what the handler would answer agree from the first pass. The
       * push runs on every pass, dressed or not: it is the restatement a completed refresh and a device update deliver to HomeKit, which the read handler alone
       * cannot, because a client sees a pushed value and re-reads only when it asks for one.
       */
      service.updateCharacteristic(this.hap.Characteristic.On, this.#accessMethodEnabled(accessMethod.method));
    }

    // Every switch this pass left standing is dressed, so the next pass is a repeat.
    this.#switchPass = { initialized: true };
  }

  // Whether a method reads on. A model nothing has seeded answers off for every method, which is the same answer a seeded model gives for a method it holds no
  // entry for - a capability-gated method the device's own configuration never mentioned.
  #accessMethodEnabled(method: AccessMethod): boolean {

    const state = this.#accessMethodState;

    return (state.phase === "seeded") && (state.values.get(method) === true);
  }

  /* Fold the record's own configuration rows into the model, replacing it wholesale rather than merging it: a row the record has dropped must leave no entry
   * standing, so the method it named reads off.
   *
   * A record carrying no rows at all is left alone rather than read, because the library's reader answers it exactly as it answers an empty row set. Only the empty
   * set is a census that listed the device's configuration and mentioned no method; a rowless record has said nothing, and reading it would seed an empty model
   * that keeps the settings read which answers for the device from ever going out.
   *
   * The memo is what makes the record's fold and the write fold safe together. A delivery whose rows translate to what the last applied fold already produced
   * carries no access method news, so it changes nothing, and the fresher knowledge a write has folded into the model survives it. The comparison is by value
   * rather than by array identity because the record's configs array offers no identity worth trusting: the periodic bootstrap refresh mints a fresh array on
   * every tick an unrelated field moved, and a websocket delta replaces it atomically whenever a terminal input row changes, since the access method rows share
   * the one flat array with them. What the memo holds is a copy rather than the model's own map, because the write fold writes into that map...a memo pointing at
   * it would absorb that write and then read the next stale restatement as news, reverting the very value the memo exists to protect.
   */
  #foldConfigRows(): void {

    if(this.uda.configs === undefined) {

      return;
    }

    const values = this.#accessMethodValues(deviceAccessMethodStates(this.uda));

    if(this.#configRowsRestated(values)) {

      return;
    }

    this.#accessMethodState = { phase: "seeded", values };
    this.#foldedConfigValues = new Map(values);
  }

  // Whether a fresh translation of the configuration rows only restates what the last applied fold produced. Equal is the same size and every entry matching, and
  // it is the size half that makes a row the record has dropped read as news rather than as a restatement.
  #configRowsRestated(values: ReadonlyMap<AccessMethod, boolean>): boolean {

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

  // Fold one method's value into the model. Only a seeded model holds values to fold into, which is what the phase check narrows to: one reading is not the whole
  // truth, so a model nothing has seeded waits for a read that answers with all of it.
  #foldMethodValue(method: AccessMethod, enabled: boolean): void {

    const state = this.#accessMethodState;

    if(state.phase !== "seeded") {

      return;
    }

    state.values.set(method, enabled);
  }

  /* Launch the official settings read that seeds a device the record rail says nothing about, and launch it one read at a time. Only an unseeded phase dispatches,
   * and the transition into seeding happens here, synchronously, ahead of any async work - so a run of device updates arriving while the read is in flight finds
   * a model that is already seeding and asks for nothing more. Only readers carry switches, so a plain hub never fetches settings it would project nowhere, nor
   * warns about them. Every caller folds the record's rows first, so an unseeded phase at this guard already means a record that carried none.
   *
   * The seeding phase carries the unseeded phase's announcement forward, which is what keeps a retry inside a streak the seed has already warned about silent.
   */
  #dispatchAccessMethodSeed(): void {

    const official = this.controller.client.official;

    if((this.#accessMethodState.phase !== "unseeded") || !official || !isReader(this.uda)) {

      return;
    }

    this.#accessMethodState = { phase: "seeding", refused: this.#accessMethodState.refused };

    guardedDispatch({ handler: async (): Promise<void> => this.#seedAccessMethodState(), label: "access method seeding", log: this.log });
  }

  /* Read this device's access methods from the official settings surface and seed the model with them, which is what gives a reader on a token-only controller its
   * switches: no configuration rows reach us for it, and this read is the only other place that truth lives.
   *
   * Every write to the model is made only while the phase is still the seeding this dispatch started, because a faster path may have seeded it meanwhile - a record
   * that gained its rows mid-read is the device's own authority on them - so a slower answer never overwrites it and a failure never knocks it back to unseeded.
   * A failure creates nothing and retires nothing: we create on data and remove on data, and a controller that did not answer is neither.
   *
   * A refusal warns only where it opens a streak: this seed still owns its transition, and nothing earlier in the streak was announced. A refusal the rows overtook
   * has no switches left to promise, and a retry inside an announced streak would only repeat what the user already read. The cause of every refusal outside
   * teardown is noted at debug, announced or not, for whoever needs the detail.
   */
  async #seedAccessMethodState(): Promise<void> {

    try {

      const values = await this.#fetchAccessMethodValues();

      /* A client holding no official surface answers undefined here, and that is what keeps this method total on its own: a client that lost that surface between the
       * dispatch and this point simply has nothing to read, and the model goes back to unseeded for the next trigger to try again. It exits this way rather than
       * through the catch below, which belongs to a read that was actually attempted and refused, so the streak's announcement goes back exactly as it was found.
       */
      if(!values) {

        this.#unseedOwnedSeeding(false);

        return;
      }

      if(this.#accessMethodState.phase === "seeding") {

        this.#accessMethodState = { phase: "seeded", values };
      }
    } catch(error) {

      // A device on its way out has nothing to say about settings it will never project, so teardown passes in silence.
      if(this.signal.aborted) {

        return;
      }

      const seeding = this.#unseedOwnedSeeding(true);

      // Only the refusal that opens a streak warns: the seeding phase this seed left is the one it still owned, and it carried no announcement yet.
      if(seeding?.refused === false) {

        this.log.warn("Unable to read the access method settings from the controller. Access method switches will be configured once the controller answers.");
      }

      this.log.debug("The access method settings read was refused: %s.", formatErrorMessage(error));
    }

    /* Materialize the switches the seed just made knowable. This sits outside the try deliberately: a failure inside the configure pass must not un-seed a model the
     * read legitimately established, and the guarded dispatch this runs under is that call's own backstop.
     */
    this.#materializeSeededSwitches();
  }

  /* Read this device's access methods from the official settings surface, through the library's reader of that surface. The one fetch-and-read statement every
   * seed and refresh runs through, so they can never drift on which surface they read or on how they read it.
   *
   * The official surface is read afresh here rather than carried in by a caller, and an absent one answers undefined rather than throwing, because what that absence
   * means belongs to the caller: the seed hands the model back for a later trigger, where the refresh keeps the values it already holds.
   *
   * @returns The values the settings state, or `undefined` where the client holds no official surface to read them from.
   */
  async #fetchAccessMethodValues(): Promise<Map<AccessMethod, boolean> | undefined> {

    /* A device torn down before this runs has nothing to read settings for, and asking the signal to throw is what puts that case and a read the teardown interrupts
     * on the same exit: both reach the caller as a throw, and what that means for the model is the caller's own to decide.
     */
    this.signal.throwIfAborted();

    const official = this.controller.client.official;

    if(!official) {

      return undefined;
    }

    const settings = await official.devices.fetchSettings(this.uda.unique_id, { signal: this.signal });

    return this.#accessMethodValues(accessMethodStates(settings));
  }

  /* The model's map of one library reading, built by walking the catalog: each method the reading establishes, and no entry for one it leaves out. Every reading
   * the model takes - the record's rows and the official settings alike - comes through here, so they can never differ on how a reading becomes model values.
   *
   * @param states - The library's reading, by method name.
   *
   * @returns A fresh map holding each method the reading establishes, in the catalog's order.
   */
  #accessMethodValues(states: Partial<Readonly<Record<AccessMethod, boolean>>>): Map<AccessMethod, boolean> {

    const values = new Map<AccessMethod, boolean>();

    for(const { method } of accessMethods) {

      const value = states[method];

      if(value !== undefined) {

        values.set(method, value);
      }
    }

    return values;
  }

  /* Materialize the switches a settled read has made knowable, and run the sweep beside them. The one statement of that pass, shared by the seed, the refresh, and
   * the device update, so what a completed read or a delivery leaves HomeKit holding cannot differ between them. The pass is silent on repeat by construction: a
   * switch is dressed the first time this hub holds it, and created and retired from what the model holds.
   *
   * A model some faster path seeded while a read failed is materialized here too, which is the honest reading of a model that holds the truth however it arrived.
   */
  #materializeSeededSwitches(): void {

    if((this.#accessMethodState.phase !== "seeded") || this.signal.aborted) {

      return;
    }

    this.configureAccessMethodSwitches();
  }

  /* Put the model back to unseeded, but only where this seed still owns the transition it started. A faster path that seeded the model meanwhile holds the truth,
   * and a read that failed has nothing to say against it. The streak's announcement goes back with the model: a refusal marks it, and an exit that was no refusal
   * keeps whatever the seeding phase carried, so a streak stays announced until a seeded model ends it.
   *
   * @param refused - Whether this seed ended on a refused read, which marks the streak announced for every retry behind it.
   *
   * @returns The seeding phase this seed left, or `undefined` where a faster path took the transition from this seed, which is what the caller's warning reads.
   */
  #unseedOwnedSeeding(refused: boolean): Extract<AccessMethodState, { phase: "seeding" }> | undefined {

    const state = this.#accessMethodState;

    if(state.phase !== "seeding") {

      return undefined;
    }

    this.#accessMethodState = { phase: "unseeded", refused: refused || state.refused };

    return state;
  }

  /* Re-establish what a lost notification channel may have left stale on this device. A completed recovery relaunches that channel without replaying the packets the
   * gap swallowed, and a reader whose rows no census restates has no other rail to catch up on, so this is where that model is asked again.
   *
   * The fold comes first because the dispatch below states that every caller folds the record's rows first: it takes whatever rows a late delivery carried, before the
   * fetch question is even asked, and it is what makes an unseeded phase at the dispatch's own guard mean a record that genuinely carried none. The dispatch's
   * guards then make it a no-op for anything but an unseeded reader with an official surface, which is the startup seed getting another chance after a read that
   * failed.
   */
  public override onConnectionRestored(): void {

    this.#foldConfigRows();
    this.#dispatchAccessMethodSeed();

    /* Only a reader whose rows no census restates has anything left to refresh, and only one refresh is ever out for a device. The latch is set here,
     * synchronously and ahead of any async work, so a second restore edge arriving while the read is in flight asks for nothing more...the staleness that edge
     * carried heals at the next recovery to complete.
     */
    if(!this.#unrestatedSeededReader || this.#accessMethodRefreshInFlight) {

      return;
    }

    this.#accessMethodRefreshInFlight = true;

    guardedDispatch({ handler: async (): Promise<void> => this.#refreshAccessMethodValues(), label: "access method refresh", log: this.log });
  }

  /* Whether this device is a seeded reader whose configuration rows no census restates, which leaves the official settings read as the only thing that can catch its
   * model up after a gap: a record carrying no rows of its own, or any reader on a client connected with an API token alone, whose census carries no rows and so
   * never restates the ones a device update brought. The one named statement of the refresh's subject, read at the dispatch gate above and re-read where the
   * fetch lands.
   *
   * The reader term mirrors the seed dispatch's own guard, which is what makes this predicate say exactly what its name says rather than leaning on an argument
   * about how the configuration-rows surface and the official-settings surface happen to line up.
   */
  get #unrestatedSeededReader(): boolean {

    return (this.#accessMethodState.phase === "seeded") && ((this.uda.configs === undefined) || (this.controller.client.capabilities.mode === "token")) &&
      isReader(this.uda);
  }

  /* Re-read the access methods of a seeded reader whose rows no census restates, and restate its switches from what comes back. A method the user changed while the
   * notification channel was down reaches us on no rail at all otherwise, so this read is what closes that gap.
   *
   * A failed refresh keeps the values the model already holds, retires nothing, and warns about nothing: the create-on-data and remove-on-data posture the seed
   * established, carried into a refresh, where the values in hand are a better answer than none. The next recovery to complete tries again.
   */
  async #refreshAccessMethodValues(): Promise<void> {

    // The row fold this read goes out over. A fold that applies always holds a fresh memo and a restatement never does, so the landing below can tell rows that
    // arrived while the read was in flight from rows it already knew.
    const folded = this.#foldedConfigValues;

    try {

      const values = await this.#fetchAccessMethodValues();

      /* The subject is re-read here rather than assumed from dispatch time, and the answer applies only where no row fold applied while the read was in flight:
       * rows that landed meanwhile are the device's own authority on its methods, on every client, so a read they overtook applies nothing.
       */
      if(values && this.#unrestatedSeededReader && (this.#foldedConfigValues === folded)) {

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

  /* Configure the doorbell service for HomeKit. The door is the accessory's primary service and the doorbell never is: the lock configure path is the one place a
   * service is marked primary. A doorbell restored from the accessory cache can still carry the marking an earlier run gave it, and HAP never records a restored
   * service as the accessory's primary, so the door's marking demotes nothing and the door and the doorbell would each serialize as primary. The dressing pass
   * therefore takes the marking off a doorbell that carries one, and leaves a doorbell that carries none untouched, because a marking change is a configuration
   * change HomeKit is told about. A repeat pass finds the doorbell dressed and leaves it.
   */
  private configureDoorbell({ initialized }: ConfigurePass): void {

    if(this.hasCapability("door_bell")) {

      this.announceFeature({ kindLabel: "Doorbells", label: "Doorbell", option: "Hub.Doorbell" });
    }

    // Validate whether we should have this service enabled.
    const { service, transition } = this.validService({ serviceType: this.hap.Service.Doorbell,
      validate: this.hasCapability("door_bell") && this.hasFeature("Hub.Doorbell") });

    if(!service) {

      return;
    }

    if(initialized && (transition !== "attached")) {

      return;
    }

    if(service.isPrimaryService) {

      service.setPrimaryService(false);
    }
  }

  /* Configure our contact sensors for HomeKit. Eligibility is what the hardware reports as wired, taken together with the user's feature option, so a sensor is
   * created on positive evidence and one already present survives a window in which the hardware reports none. Turning the option off always removes it.
   *
   * Re-running this is how a wiring change reaches HomeKit mid-run, so it is written to be silent on repeat: the gate's callback speaks only when a present service is
   * being removed, the settling helper only when one is created, and a sensor is dressed only the first time this hub holds it - at adoption, or at its creation on
   * a later pass.
   */
  private configureTerminalInputs({ initialized }: ConfigurePass): void {

    this.configureDpsSensor({ initialized });

    // The selection is resolved once for the whole pass and each input tests its own membership, rather than the option being resolved again for every input.
    const selected = this.#selectedSensors();

    /* The same statement for a sensor selection the user emptied, made at adoption alone. The settings are fixed when the plugin starts, so every later pass finds the
     * same selection adoption already stated, and repeating the line on every device update would say nothing the user has not already read. A device that offers no
     * sensor in the settings page has nothing to state, so the model's own list is what the line is gated on...read through the same resolver the settings page and the
     * model characteristic read, because a record from the official API carries a device type and no display model at all.
     *
     * The list is read last in the condition, so a device update - which always carries an initialized pass - and a user on the default selection both settle the
     * gate without walking the member table.
     */
    if(!initialized && !selected.length && this.#offersSensors()) {

      this.log.info("No sensors enabled.");
    }

    for(const { label, member, terminal } of terminalInputs) {

      const facts = terminalInput(this.uda, terminal);
      // The cast holds because every member of the terminal input table has a CONTACT_ reserved subtype of the same name.
      const reservedId = AccessReservedNames[("CONTACT_" + member) as keyof typeof AccessReservedNames];
      const gate = capabilityGate({ capability: facts.wired === true, toggle: selected.includes(member) });

      // Validate whether we should have this service enabled. A true verdict acquires the sensor, creating it where the accessory carries none.
      const { service, transition } = this.validService({ serviceType: this.hap.Service.ContactSensor, subtype: reservedId, suffix: " " + label,
        validate: (hasService: boolean) => {

          const isValid = gate(hasService);

          if(!isValid && hasService) {

            this.log.info("Disabling the " + label.toLowerCase() + ".");
          }

          return isValid;
        } });

      if(!service) {

        continue;
      }

      // Dress the sensor with the input's own reading the first time this hub holds it.
      this.#settleSensor({ initialized, label, reading: this.#contactReading(facts), service, transition });
    }
  }

  /* Settle a contact sensor its gate answered: announce one this pass attached, reconcile its tamper characteristic, and dress it the first time this hub holds it.
   * The transition the gate answers tells a created sensor from one found on the accessory, and the pass tells whether a found sensor is one an earlier pass
   * dressed: restored from the accessory cache, it carries the values it last held and none of its handlers, so adoption dresses it exactly as a creation does. The
   * dressing is the only writer of a sensor's starting values, with the tamper attach below the one exception; every change after it reaches the sensor through the
   * reading's own writers and the tamper sweep alone.
   *
   * The gate's own answer is what this reads rather than a second lookup, because a lookup after the gate would find the sensor the gate just created and answer
   * it as kept, and a sensor created on a device update would go undressed.
   *
   * @param options - The pass this settling runs as, the sensor's label, the reading it is dressed with, and the sensor and transition its gate answered.
   */
  #settleSensor({ initialized, label, reading, service, transition }: ConfigurePass & AcquireServiceResult & { label: string; reading: CharacteristicValue }): void {

    // A sensor this pass attached was dressed by nobody, whichever pass this is.
    const dressing = !initialized || (transition === "attached");

    if(transition === "attached") {

      this.log.info("Enabling the " + label.toLowerCase() + ".");
    }

    /* The tamper characteristic's presence follows the capability in both directions on every pass: the library attaches it where the hardware reports tampering and
     * removes it where the hardware stopped, so a sensor dressed before the capability arrived gains the characteristic and one carried from a cache the hardware
     * does not back loses it. The transition the call answers is what decides the one write below, and the accessory is marked for the next save whenever the
     * characteristic comes or goes, since that changes what Homebridge's accessory cache holds.
     */
    const tamper = validCharacteristic({ characteristic: this.hap.Characteristic.StatusTampered, service, validate: isTamperCapable(this.uda) });

    if(presenceChanged(tamper)) {

      this.platform.persistence.persist(this.accessory);
    }

    /* No contact sensor carries Status Active, because no fact about a sensor could drive it: reachability is No Response's to say, and nothing here can be switched off.
     * A sensor restored from the cache can still carry one, so it comes off on every pass, the accessory marked for the next save when it does.
     */
    if(presenceChanged(validCharacteristic({ characteristic: this.hap.Characteristic.StatusActive, service, validate: false }))) {

      this.platform.persistence.persist(this.accessory);
    }

    if(dressing) {

      this.#dressSensor(service, reading);
    }

    /* The tamper status is written, and its reader registered, from the held verdict whenever this pass put the characteristic on the sensor, or the sensor is
     * being dressed and the characteristic already stands - which is a sensor restored from the cache on capable hardware. So a standing sensor whose
     * characteristic stood already keeps what the tamper sweep last wrote, a sensor carrying none has nothing to write, and no sensor is written twice for one event.
     */
    if((tamper === "attached") || (dressing && (tamper === "kept"))) {

      service.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.#tamperRendering(this.tamperVerdict));
      service.getCharacteristic(this.hap.Characteristic.StatusTampered).onGet(this.answering(() => this.#tamperRendering(this.tamperVerdict)));
    }
  }

  /* Dress a sensor the first time this hub holds it: its reading. The reading's handler answers the stored reading through the device's Not Responding rule, so a sensor
   * the plugin cannot vouch for refuses its reading rather than showing the last one, and that refusal is all an outage shows on a sensor. The tamper status is written
   * by the settling helper above, where the presence reconcile left the characteristic standing, which is what lets the tamper sweep reach every sensor without the hub
   * keeping a roster, because HomeKit carries an optional characteristic only once something has written it.
   */
  #dressSensor(service: Service, reading: CharacteristicValue): void {

    const contact = service.getCharacteristic(this.hap.Characteristic.ContactSensorState);

    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, reading);
    contact.onGet(this.answering(() => contact.value ?? reading));
  }

  /* How a tamper verdict renders in HomeKit - the one statement of it, read by the settling helper's own write and by the projection's sweep. Nothing established
   * renders normal, because HomeKit has no third value and a status restored from the accessory cache with no reading behind it is not one this plugin can assert.
   *
   * @param verdict - The tracked verdict to render.
   *
   * @returns What HomeKit is handed for that verdict.
   */
  #tamperRendering(verdict: boolean | undefined): CharacteristicValue {

    return verdict ? this.hap.Characteristic.StatusTampered.TAMPERED : this.hap.Characteristic.StatusTampered.NOT_TAMPERED;
  }

  /* Configure the door position sensor. It stands apart from the loop above because its eligibility comes from the family-by-family eligibility statement, which
   * reads the door-state model for most families, rather than a wiring-key pair, its state is maintained by the door-state delivery rather than read off the record,
   * and it reaches HomeKit through a manual getter that keeps its reading available to a garage door service even when the sensor itself is disabled.
   *
   * The door-state delivery calls this too, so a change in wiring evidence re-gates the sensor on that rail as well rather than waiting for a device update. Like
   * the loop above, it is a no-op on repeat by construction.
   */
  private configureDpsSensor({ initialized }: ConfigurePass): void {

    // The sensor is offered wherever the door's position is reported at all, which the getter below states once for every reader of that question.
    const gate = capabilityGate({ capability: this.#positionReported, toggle: this.#selectedSensors().includes("DPS") });

    // Validate whether we should have this service enabled. A true verdict acquires the sensor, creating it where the accessory carries none.
    const { service, transition } = this.validService({ serviceType: this.hap.Service.ContactSensor, subtype: AccessReservedNames.CONTACT_DPS,
      suffix: " " + DPS_LABEL, validate: (hasService: boolean) => {

        const isValid = gate(hasService);

        if(!isValid && hasService) {

          this.log.info("Disabling the " + DPS_LABEL.toLowerCase() + ".");
        }

        return isValid;
      } });

    if(!service) {

      return;
    }

    // The reading is the projection the delivery path maintains, so a dressing writes what we already hold rather than a fresh read of the record.
    this.#settleSensor({ initialized, label: DPS_LABEL, reading: this._hkDpsState, service, transition });
  }

  // Configure contact sensors for the side door terminal inputs on UA Gate hubs. The side door has its own dedicated DPS input separate from the main gate's DPS.
  private configureSideDoorTerminalInputs({ initialized }: ConfigurePass): void {

    /* Validate whether we should have this service enabled. The sensor exists on a UA Gate whose side door is enabled, read from the same hint the side door's lock
     * is gated on, and whose sensor selection includes it, so a sensor the accessory carries from a run with the side door on is removed once the side door is off.
     * The selection is read on every configure pass where the side door is enabled, exactly as every other sensor's is, and a true verdict acquires the sensor,
     * creating it where the accessory carries none.
     */
    const enabled = this.hints.hasSideDoor && this.#selectedSensors().includes("SideDoorDPS");
    const { service, transition } = this.validService({ serviceType: this.hap.Service.ContactSensor, subtype: AccessReservedNames.CONTACT_DPS_SIDE,
      suffix: " " + SIDE_DOOR_DPS_LABEL, validate: (hasService: boolean) => {

        if(!enabled && hasService) {

          this.log.info("Disabling the " + SIDE_DOOR_DPS_LABEL.toLowerCase() + ".");
        }

        return enabled;
      } });

    if(!service) {

      return;
    }

    // The reading is the projection the side door's delivery maintains, for the same reason the main door's is.
    this.#settleSensor({ initialized, label: SIDE_DOOR_DPS_LABEL, reading: this._hkSideDoorDpsState, service, transition });
  }

  // Configure the door for HomeKit. Supports Lock and GarageDoorOpener service types.
  private configureLock({ initialized }: ConfigurePass): void {

    /* First, remove the presentation that is not selected. The lookup is exact, so it removes the main door's own service of that type and never a subtyped
     * sibling of it...a UA Gate presenting its door as an opener carries its side door's lock beside the opener, and that lock stays where it is.
     */
    const serviceTypes = [ this.hap.Service.LockMechanism, this.hap.Service.GarageDoorOpener ];
    const selectedService = this.doorServiceType === "GarageDoorOpener" ? this.hap.Service.GarageDoorOpener : this.hap.Service.LockMechanism;

    for(const serviceType of serviceTypes) {

      if(serviceType !== selectedService) {

        this.validService({ serviceType, validate: false });
      }
    }

    // Validate whether we should have this service enabled.
    const { service, transition } = this.validService({ serviceType: selectedService, validate: isHub(this.uda) });

    if(!service) {

      return;
    }

    if(transition === "attached") {

      this.log.info("Presenting the door in HomeKit as a %s.", (this.doorServiceType === "GarageDoorOpener") ? "garage door opener" : "lock");
    }

    if(initialized && (transition !== "attached")) {

      return;
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
    this.hkLockState = lockState;

    service.setPrimaryService(true);
  }

  // Configure a LockMechanism service.
  private configureLockService(service: Service, isSideDoor: boolean): void {

    const lockStateGetter = isSideDoor ? (): CharacteristicValue => this.hkSideDoorLockState : (): CharacteristicValue => this.hkLockState;
    const lockCommand = isSideDoor ? async (lock: boolean): Promise<boolean> => this.hubSideDoorLockCommand(lock) :
      async (lock: boolean): Promise<boolean> => this.hubLockCommand(lock);

    service.getCharacteristic(this.hap.Characteristic.LockCurrentState).onGet(this.answering(lockStateGetter));
    service.getCharacteristic(this.hap.Characteristic.LockTargetState).onGet(this.answering(lockStateGetter));

    service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet(this.answering(async (value: CharacteristicValue) => {

      const currentState = lockStateGetter();
      const targetLocked = value === this.hap.Characteristic.LockTargetState.SECURED;
      const currentlyLocked = currentState === this.hap.Characteristic.LockCurrentState.SECURED;

      // A write asking for the state the door already holds has nothing to command, so it returns without dispatching.
      if(targetLocked === currentlyLocked) {

        return;
      }

      if(!(await lockCommand(targetLocked))) {

        this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.LockTargetState,
          currentlyLocked ? this.hap.Characteristic.LockTargetState.SECURED : this.hap.Characteristic.LockTargetState.UNSECURED), CHARACTERISTIC_REVERT_DELAY_MS);
      }

      service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, lockStateGetter());
    }));
  }

  // Configure a GarageDoorOpener service.
  private configureGarageDoorService(service: Service): void {

    /* A service re-acquire registers the handlers below afresh, so any travel the machine was rendering belonged to a presentation of the door that no longer
     * exists. The door starts standing here, which also drains whatever timer that travel had armed.
     */
    this.#enterDoorTransition({ phase: "idle" });

    /* What the opener answers when HomeKit asks. A door mid-travel answers with the travel rather than with the evidence: the evidence lags the door, so answering
     * it here would put a HomeKit read straight over the transitional state the write in front of it displayed.
     */
    const getDoorState = (): CharacteristicValue => {

      const travelling = this.#doorTransition;

      return (travelling.phase === "idle") ? this.#doorStateFromEvidence().current : this.#renderedTransition(travelling);
    };

    service.getCharacteristic(this.hap.Characteristic.CurrentDoorState).onGet(this.answering(getDoorState));

    /* The target HomeKit is shown is the one it last asked for or the one the evidence last confirmed, both of them written to the characteristic, so the reader
     * answers that store...and a store with nothing written to it yet answers the evidence.
     */
    const target = service.getCharacteristic(this.hap.Characteristic.TargetDoorState);

    target.onGet(this.answering(() => target.value ?? this.#doorStateFromEvidence().target));

    target.onSet(this.answering(async (value: CharacteristicValue) => {

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
       *
       * A gate with no main door says the same and sends nothing, because the library answers a stop naming no door with whichever door its first binding names, and
       * a role left vacant is a door we refused to guess.
       */
      if(halting && isUaGate) {

        const mainDoor = this.#gateDoor(false);

        if(!this.hubProjection) {

          this.log.debug("Unable to halt the gate. This device has no door control surface.");
        } else if(!mainDoor) {

          this.log.debug("Unable to halt the gate. The controller reports no door for it.");
        } else {

          try {

            await this.hubProjection.stop({ doorId: mainDoor });
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
    }));

    // ObstructionDetected is required - we always report no obstruction.
    service.getCharacteristic(this.hap.Characteristic.ObstructionDetected).onGet(this.answering(() => false));
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit. A repeat pass finds the switch dressed and leaves it, which is what keeps a pending
  // ring's trigger on rather than pushing it back off underneath the ring.
  private configureDoorbellTrigger({ initialized }: ConfigurePass): void {

    if(this.hasCapability("door_bell")) {

      this.announceFeature({ kindLabel: "Doorbell automation triggers", label: "Doorbell automation trigger", option: "Hub.Doorbell.Trigger" });
    }

    // Validate whether we should have this service enabled.
    const { service, transition } = this.validService({ serviceType: this.hap.Service.Switch, subtype: AccessReservedNames.SWITCH_DOORBELL_TRIGGER,
      suffix: " Doorbell Trigger", validate: this.hasCapability("door_bell") && this.hasFeature("Hub.Doorbell.Trigger") });

    if(!service) {

      return;
    }

    if(initialized && (transition !== "attached")) {

      return;
    }

    // The switch mirrors ring truth: on while the doorbell is ringing, off while it is quiet.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.doorbellRingRequestId !== null));

    // The manual direction: with an official path the switch rings and cancels the doorbell, and without one it only reflects ring events. Whatever the outcome,
    // every write schedules exactly one wake that re-reads ring truth at fire time and settles the switch back onto the mirror...the controller's own ring and
    // cancel events stay the single owner of ring state, and the wake is a read of that state, never a second writer.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(async (value: CharacteristicValue) => {

      const official = this.controller.client.official;
      const action = doorbellTriggerAction({ officialAvailable: official !== null, ringing: this.doorbellRingRequestId !== null, value: value === true });

      // The default wake converges HomeKit's optimistic cache back onto the mirror almost immediately; a dispatched ring or cancel earns the longer reconcile
      // window instead, so the controller's own notification can arrive and win first.
      let revertDelay = CHARACTERISTIC_REVERT_DELAY_MS;

      switch(action) {

        case "unavailable":

          this.log.error("Ringing the doorbell requires the official Access API, which needs an API token to be configured.");

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
    }));

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, false);
  }

  /* Configure a switch to automate lock and unlock events in HomeKit beyond what HomeKit might allow for a lock service that gets treated as a secure service. A
   * repeat pass finds the switch dressed and leaves it, which is what keeps an unlocked door's trigger on rather than pushing it back off underneath the door.
   */
  private configureLockTrigger({ initialized }: ConfigurePass): void {

    if(isHub(this.uda)) {

      this.announceFeature({ kindLabel: "Lock automation triggers", label: "Lock automation trigger", option: "Hub.Lock.Trigger" });
    }

    // Validate whether we should have this service enabled.
    const { service, transition } = this.validService({ serviceType: this.hap.Service.Switch, subtype: AccessReservedNames.SWITCH_LOCK_TRIGGER,
      suffix: " Lock Trigger", validate: isHub(this.uda) && this.hasFeature("Hub.Lock.Trigger") });

    if(!service) {

      return;
    }

    if(initialized && (transition !== "attached")) {

      return;
    }

    // The trigger mirrors the lock: on while anything but secured, off while secured.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.hkLockState !== this.hap.Characteristic.LockCurrentState.SECURED));

    // The switch drives the lock through the hub lock command, and a refused command puts the switch back.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(async (value: CharacteristicValue) => {

      // If we are on, we are in an unlocked state. If we are off, we are in a locked state.
      if(!(await this.hubLockCommand(!value))) {

        // Revert our state.
        this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), CHARACTERISTIC_REVERT_DELAY_MS);
      }
    }));

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, false);
  }

  // Configure the side door for HomeKit (UA Gate only) - always uses Lock service. A repeat pass finds the lock dressed and leaves it, so the reading it stands at
  // is whatever the rails last put there.
  private configureSideDoorLock({ initialized }: ConfigurePass): void {

    if(this.uda.device_type === "UGT") {

      this.announceFeature({ kindLabel: "Side door locks", label: "Side door lock", option: "Hub.SideDoor" });
    }

    // Validate whether we should have this service enabled.
    const { service, transition } = this.validService({ serviceType: this.hap.Service.LockMechanism, subtype: AccessReservedNames.LOCK_DOOR_SIDE,
      suffix: " Side Door", validate: this.hints.hasSideDoor });

    if(!service) {

      return;
    }

    if(initialized && (transition !== "attached")) {

      return;
    }

    // Configure the lock service.
    this.configureLockService(service, true);

    // Initialize the lock from the relay reading. The backing value is first put where no reading can equal it, so the setter below writes the service even when the
    // state is the one we were already in.
    this._hkSideDoorLockState = -1;
    this.hkSideDoorLockState = this.hubSideDoorLockState;
  }

  /* Configure a switch to automate side door lock and unlock events in HomeKit beyond what HomeKit might allow for a lock service that gets treated as a secure
   * service. A repeat pass finds the switch dressed and leaves it, for the reason the main door's trigger gives.
   */
  private configureSideDoorLockTrigger({ initialized }: ConfigurePass): void {

    if(this.hints.hasSideDoor) {

      this.announceFeature({ kindLabel: "Side door lock automation triggers", label: "Side door lock automation trigger", option: "Hub.SideDoor.Lock.Trigger" });
    }

    // Validate whether we should have this service enabled.
    const { service, transition } = this.validService({ serviceType: this.hap.Service.Switch, subtype: AccessReservedNames.SWITCH_LOCK_DOOR_SIDE_TRIGGER,
      suffix: " Side Door Lock Trigger", validate: this.hints.hasSideDoor && this.hasFeature("Hub.SideDoor.Lock.Trigger") });

    if(!service) {

      return;
    }

    if(initialized && (transition !== "attached")) {

      return;
    }

    // The trigger mirrors the side door's lock: on while anything but secured, off while secured.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.hkSideDoorLockState !== this.hap.Characteristic.LockCurrentState.SECURED));

    // The switch drives the side door lock through the side door lock command, and a refused command puts the switch back.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(async (value: CharacteristicValue) => {

      // If we are on, we are in an unlocked state. If we are off, we are in a locked state.
      if(!(await this.hubSideDoorLockCommand(!value))) {

        // Revert our state.
        this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), CHARACTERISTIC_REVERT_DELAY_MS);
      }
    }));

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, false);
  }

  /* The payload each held state topic carries, read from the state this hub holds for it. A change publishes through here, the get topics answer through here, and
   * so does the broker-session restatement, so what a subscriber hears on a change, when a session begins, and on asking is one derivation. Each arm reads the
   * source its transition site writes: the lock and position readings the door-state delivery and the gate windows settle, a terminal input's sensor as the device
   * update leaves it, and the tamper verdict the projection holds. A position or a terminal input whose evidence is absent says unknown, read through the same
   * evidence answer the rails weigh to tell when that evidence moved. The switch is exhaustive over the held state topics, so a topic added to the catalog fails
   * compilation here until it has a payload.
   *
   * @param key - The held state topic to read.
   *
   * @returns The payload that topic carries now.
   */
  #statePayload(key: AccessStateTopic): string {

    switch(key) {

      case "dps":

        // A position nothing reports is unknown, whatever the reading a sensor kept through a gap in its evidence last held.
        if(!this.#evidencePresent(key)) {

          return "unknown";
        }

        return this.#contactPayload(this.hkDpsState);

      case "lock":

        return this.#lockPayload(this.hkLockState);

      case "rel":
      case "ren":
      case "rex":

        return this.#contactPayload(this.#terminalReading(key));

      case "sidedoorDps":

        if(!this.#evidencePresent(key)) {

          return "unknown";
        }

        return this.#contactPayload(this._hkSideDoorDpsState);

      case "sidedoorLock":

        return this.#lockPayload(this.hkSideDoorLockState);

      case "tamper":

        return String(this.tamperVerdict ?? "unknown");
    }
  }

  // How a contact reading is spelled on its topic: open is true and closed is false, and anything else, no reading at all included, is unknown.
  #contactPayload(state: CharacteristicValue | undefined): string {

    switch(state) {

      case this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED:

        return "false";

      case this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED:

        return "true";

      default:

        return "unknown";
    }
  }

  // How a lock reading is spelled on its topic: locked is true and unlocked is false, and anything else, the value a lock service is reconfigured through
  // included, is unknown.
  #lockPayload(state: CharacteristicValue): string {

    switch(state) {

      case this.hap.Characteristic.LockCurrentState.SECURED:

        return "true";

      case this.hap.Characteristic.LockCurrentState.UNSECURED:

        return "false";

      default:

        return "unknown";
    }
  }

  /* A terminal input's reading as its sensor holds it, or nothing where the input has no reading to state: its sensor does not stand, or its terminal does not
   * report wired. A sensor kept through a gap in its wiring evidence holds the closed default rather than a reading, which is why its topic says unknown for as
   * long as the gap lasts rather than repeating that default as though the input had reported it.
   *
   * @param key - The catalog key of the input's topic.
   *
   * @returns The sensor's contact reading, or `undefined` where the input has none to state.
   */
  #terminalReading(key: AccessTerminalTopic): CharacteristicValue | undefined {

    for(const { member, topic } of terminalInputs) {

      if((topic !== key) || !this.#evidencePresent(key)) {

        continue;
      }

      return this.#terminalSensor(member)?.getCharacteristic(this.hap.Characteristic.ContactSensorState).value ?? undefined;
    }

    return undefined;
  }

  /* The contact sensor a terminal input stands as, or `undefined` where the accessory carries none.
   *
   * @param member - The input's member name, from which its reserved subtype is composed.
   *
   * @returns The sensor, or `undefined`.
   */
  #terminalSensor(member: (typeof terminalInputs)[number]["member"]): Service | undefined {

    // The cast holds because every member of the terminal input table has a CONTACT_ reserved subtype of the same name.
    return findService({ accessory: this.accessory, serviceType: this.hap.Service.ContactSensor,
      subtype: AccessReservedNames[("CONTACT_" + member) as keyof typeof AccessReservedNames] });
  }

  /* Whether the evidence a held state topic's reading stands on is present, which is the one answer the payload reader and the rails that weigh a move in it read.
   * The door's position needs the position reported at all, and a terminal input or the side door's position needs its terminal reporting wired. A lock and the
   * tamper status read their state alone, the tamper verdict's unknown being a reading of its own, so neither has evidence to lose.
   *
   * @param key - The held state topic to answer for.
   *
   * @returns Whether the topic's evidence is present.
   */
  #evidencePresent(key: AccessStateTopic): boolean {

    switch(key) {

      case "dps":

        return this.#positionReported;

      case "lock":
      case "sidedoorLock":
      case "tamper":

        return true;

      case "rel":
      case "ren":
      case "rex":

        return terminalInputs.some(({ terminal, topic }) => (topic === key) && (terminalInput(this.uda, terminal).wired === true));

      case "sidedoorDps":

        return this.#sideDoorFacts.wired === true;
    }
  }

  /* Whether the HomeKit control a topic describes exists on this accessory when it is asked, which is the one answer every MQTT surface of this hub reads: a topic is
   * published, restated, asked, and commanded only while it holds. It is read live rather than resolved once, because a hub's services appear and disappear mid-run
   * as its capabilities, its wiring, and its door evidence move. The switch is exhaustive over the hub topics, so a topic added to the catalog fails compilation
   * here until the control it describes is named.
   *
   * The door's position is shown by its position sensor, or by a garage door opener rendering from that position, and a terminal input by its own sensor whether
   * or not its wiring reports live. The tamper status is shown by any contact sensor carrying the characteristic. The doorbell is its Doorbell service alone: the
   * trigger switch mirrors a ring without being the doorbell HomeKit shows. A lock topic and the unlocks it attributes belong to the door they describe.
   *
   * @param key - The hub topic to answer for.
   *
   * @returns Whether the topic's control exists.
   */
  #topicPresent(key: AccessHubTopic): boolean {

    switch(key) {

      case "doorbell":

        return findService({ accessory: this.accessory, serviceType: this.hap.Service.Doorbell }) !== undefined;

      case "dps":

        return (findService({ accessory: this.accessory, serviceType: this.hap.Service.ContactSensor, subtype: AccessReservedNames.CONTACT_DPS }) !== undefined) ||
          ((findService({ accessory: this.accessory, serviceType: this.hap.Service.GarageDoorOpener }) !== undefined) && this.#positionReported);

      case "lock":
      case "unlock": {

        // The main door is presented as a lock or as a garage door opener, each without a subtype, and the configure pass keeps at most one of them standing.
        const presentations = [ this.hap.Service.LockMechanism, this.hap.Service.GarageDoorOpener ];

        return presentations.some(serviceType => findService({ accessory: this.accessory, serviceType }) !== undefined);
      }

      case "rel":
      case "ren":
      case "rex":

        return terminalInputs.some(({ member, topic }) => (topic === key) && (this.#terminalSensor(member) !== undefined));

      case "sidedoorDps":

        return findService({ accessory: this.accessory, serviceType: this.hap.Service.ContactSensor, subtype: AccessReservedNames.CONTACT_DPS_SIDE }) !== undefined;

      case "sidedoorLock":
      case "sidedoorUnlock":

        return findService({ accessory: this.accessory, serviceType: this.hap.Service.LockMechanism, subtype: AccessReservedNames.LOCK_DOOR_SIDE }) !== undefined;

      case "tamper":

        return this.accessory.services.some(service => (service.UUID === this.hap.Service.ContactSensor.UUID) &&
          service.testCharacteristic(this.hap.Characteristic.StatusTampered));
    }
  }

  /* Publish on one of this hub's topics, which is the one place a hub topic is published from: a topic whose control does not exist publishes nothing, whether
   * the publish is a change, an event, or a broker session's restatement. A held state topic always says what the payload reader answers, so the change, the
   * restatement, and the get are one derivation, and a momentary topic carries the event it reports, which no held state could say.
   *
   * A held state topic's evidence is weighed here whether or not its control exists, so a rail that moved a reading and its evidence together states the topic
   * once, and the walk below finds nothing left to state for it.
   *
   * @param publish - The topic, and for a momentary topic the event it carries.
   */
  #publishTopic(publish: { key: AccessMomentaryTopic; payload: string } | { key: AccessStateTopic }): void {

    if(!("payload" in publish)) {

      this.#topicEvidence.set(publish.key, this.#evidencePresent(publish.key));
    }

    if(!this.#topicPresent(publish.key)) {

      return;
    }

    this.mqttPublish(mqttTopics[publish.key], ("payload" in publish) ? publish.payload : this.#statePayload(publish.key));
  }

  /* Publish each of the named held state topics whose evidence has moved since the topic was last weighed. This is how evidence that goes, or comes back, while
   * the reading stays put reaches the topic: a terminal rewired onto the reading its sensor already holds moves no characteristic, so no change would ever tell a
   * subscriber holding unknown that the reading is known again. A rail runs it once its readings have landed, so a topic whose reading moved too was stated and
   * weighed already.
   *
   * @param keys - The held state topics whose evidence the calling rail can move.
   */
  #publishMovedEvidence(keys: readonly AccessStateTopic[]): void {

    for(const key of keys) {

      if(this.#topicEvidence.get(key) !== this.#evidencePresent(key)) {

        this.#publishTopic({ key });
      }
    }
  }

  /* The get and set registrations each answered topic makes, under the lifetime it is handed. Each getter answers through the payload reader, or for the doorbell
   * from the ring the hub is holding, and each lock's setter drives that lock's command, refusing anything but true and false with an error. The record names
   * every topic the catalog gives a get or a set, so a topic given one fails compilation here until its registrations are written.
   *
   * @returns Each answered topic's registrations.
   */
  #topicAnswers(): Record<AccessAnsweredTopic, (lifetime: AbortSignal) => void> {

    return {

      doorbell: (lifetime) => this.mqttSubscribeGet(mqttTopics.doorbell, () => (this.doorbellRingRequestId !== null) ? "true" : "false", lifetime),
      dps: (lifetime) => this.mqttSubscribeGet(mqttTopics.dps, () => this.#statePayload("dps"), lifetime),
      lock: (lifetime): void => {

        this.mqttSubscribeGet(mqttTopics.lock, () => this.#statePayload("lock"), lifetime);

        this.mqttSubscribeSet(mqttTopics.lock, (value: string) => {

          switch(value) {

            case "true":

              void this.hubLockCommand(true);

              break;

            case "false":

              void this.hubLockCommand(false);

              break;

            default:

              this.log.error("Unable to process MQTT lock setting: %s.", value);

              break;
          }
        }, lifetime);
      },
      sidedoorDps: (lifetime) => this.mqttSubscribeGet(mqttTopics.sidedoorDps, () => this.#statePayload("sidedoorDps"), lifetime),
      sidedoorLock: (lifetime): void => {

        this.mqttSubscribeGet(mqttTopics.sidedoorLock, () => this.#statePayload("sidedoorLock"), lifetime);

        this.mqttSubscribeSet(mqttTopics.sidedoorLock, (value: string) => {

          switch(value) {

            case "true":

              void this.hubSideDoorLockCommand(true);

              break;

            case "false":

              void this.hubSideDoorLockCommand(false);

              break;

            default:

              this.log.error("Unable to process MQTT side door lock setting: %s.", value);

              break;
          }
        }, lifetime);
      }
    };
  }

  /* Bring each answered topic's registrations into line with whether its control exists: open a lifetime and register under it for a control that has appeared,
   * and abort the lifetime of one that has gone, which releases its registrations and, with the last handler on the topic, the broker subscription. A topic whose
   * control stands where it stood is left alone, so a pass over an unchanged record registers nothing a second time. It runs wherever a control can move: after
   * every configure pass, adoption's included, and after the door-state delivery re-gates the position sensor.
   */
  #reconcileTopicAnswers(): void {

    const answers = this.#topicAnswers();

    for(const key of Object.keys(answers) as AccessAnsweredTopic[]) {

      const lifetime = this.#topicLifetimes.get(key);

      if(this.#topicPresent(key) === (lifetime !== undefined)) {

        continue;
      }

      if(lifetime) {

        lifetime.abort();
        this.#topicLifetimes.delete(key);

        continue;
      }

      const opened = new AbortController();

      this.#topicLifetimes.set(key, opened);
      answers[key](opened.signal);
    }
  }

  /* Configure the restatement this device makes for the whole of its run. Its get and set topics are not among what this configures: each follows the control it
   * describes, through the reconcile above.
   */
  private configureMqtt(): void {

    /* Restate what this device holds each time the client establishes a broker session: its availability first, then every held state topic, each through the one
     * publish, which drops a topic whose control does not exist and reads the payload the get topics answer through. The client publishes nothing across an outage
     * and replays nothing after it, so this is how a subscriber that missed a statement hears the current one, and the client clears its change-gated memory ahead
     * of every session, which is what lets an unchanged availability go out again. The momentary topics are never restated, since a replayed event is the event
     * happening a second time. Every device states its availability, a reader as much as a hub, and a reader carries no control any hub topic describes.
     */
    this.mqttOnConnect(() => {

      this.publishAvailability();

      for(const key of HELD_STATE_TOPICS) {

        this.#publishTopic({ key });
      }
    });
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
   * A UA Gate answers with the doors discovery last resolved for it, because the library derives no per-door facts for hardware whose doors it cannot tell apart.
   * Every other hub answers from the library's own published door resolution. A hub inside its removal grace enumerates nothing at all rather than throwing, which
   * is what the guarded identity read above makes true and which matters because every hub on a controller sees every delivery.
   */
  get #drivenDoors(): readonly DrivenDoor[] {

    if(this.uda.device_type === "UGT") {

      return this.#gateDoors;
    }

    const doorId = this.#doorId;

    return doorId ? [{ isSideDoor: false, locationId: doorId }] : [];
  }

  // How a path that addresses one of a gate's doors by the role it holds reaches the same enumeration the door-state delivery reads.
  #gateDoor(isSideDoor: boolean): string | undefined {

    return this.#drivenDoors.find(door => door.isSideDoor === isSideDoor)?.locationId;
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

  /* Which of this hub's doors a remote unlock names, or null when it names none of them.
   *
   * The controller reports this notification in two identity spaces: hub-class hardware names the device that performed the unlock, and a gate names the door. So the
   * read tolerates both - the performing device is this hub's main door, and anything else is either a door this hub drives or nothing of this hub's at all. A hub
   * inside its removal grace drives no doors, so it answers null through the ownership read above exactly as every other path does.
   *
   * @param packet - The remote unlock as the controller reported it.
   *
   * @returns Which of this hub's doors the unlock names, or null.
   */
  #remoteUnlockDoor(packet: AccessEventPacket): Nullable<"main" | "side"> {

    if(packet.event_object_id === this.uda.unique_id) {

      return "main";
    }

    return this.#ownedDoor(packet.event_object_id);
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

  /* Whether the main door's position is reported at all. A UA Gate's is, from the location rail: that hardware drives two doors, and the library derives no
   * topology facts for a device it cannot tell the doors of apart, so there is no sensor evidence to read, and the door-state delivery, which reads the gate's doors
   * as discovery resolved them, owns the state behind it. Every other family's is wherever the evidence above says a sensor is wired.
   *
   * The sensor's eligibility, the opener's rendering, the position topic's payload, and whether a garage door opener stands in for that topic's control all read
   * this one answer, so none of them can disagree about whether the door's position is known.
   */
  get #positionReported(): boolean {

    return (this.uda.device_type === "UGT") || this.dpsEvidence;
  }

  /* Project this hub's live door state into HomeKit. The controller's door-state loop calls this once from what it finds on arrival, and again on every change the
   * client's model records.
   *
   * Every door the hub drives is read from the client's map under its own identity, which is how a UA Gate's two doors arrive through the same delivery as every
   * other hub's one, applied to the doors that discovery resolved for it rather than through a second resolution of their own.
   *
   * The entries we read update live from the notification stream: the wiring keys behind them are live circuit detection, and the stream reports a wiring
   * transition as it happens. A topology refresh only ever seeds a door that has never reported, while an official read merges its facts over a held entry member
   * by member.
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

        this.configureDpsSensor({ initialized: true });

        // The re-gate can move the position topic's control, and so can the evidence it read, so the topics a subscriber can ask follow it on this rail too.
        this.#reconcileTopicAnswers();
      }

      this.applyDoorState(entry, door.isSideDoor);
    }

    // The main door's entry carries its position evidence as well as its reading, so evidence that moved while the reading stayed put is stated once every door's
    // readings have landed.
    this.#publishMovedEvidence(["dps"]);
  }

  /* The registry key a door's pending auto-relock is tracked under. One door, one relock intent: a HomeKit unlock and a remote unlock arrive under the same key, so
   * the newest relock replaces whatever was pending rather than stacking beside it. The formula lives here alone so that an opening window and the close that ends
   * it can never name different timers, and so a typo collapsing the pair into a single key cannot let a side door's unlock cancel the main door's pending relock.
   */
  #relockTimerKey(isSideDoor: boolean): string {

    return isSideDoor ? "relock-side" : "relock-main";
  }

  /* How any door this hub drives announces itself - the main door of any hub, or a UA Gate's side door: the name its own lines render it under, and the catalog key
   * of its lock topic. The shared #announceLockState voice reads the pair from here, so the name a user hears and the topic a subscriber reads can never disagree
   * about which door they are describing.
   *
   * @param isSideDoor - Whether the side door of a UA Gate is the door being announced.
   *
   * @returns The door's rendered name and its lock topic's catalog key.
   */
  #doorAnnounceIdentity(isSideDoor: boolean): { doorName: string; topic: "lock" | "sidedoorLock" } {

    const doorName = this.#doorCommandName(isSideDoor);

    return { doorName: doorName.charAt(0).toUpperCase() + doorName.slice(1), topic: isSideDoor ? "sidedoorLock" : "lock" };
  }

  /* The one voice a door's lock state is announced in: the topic a subscriber reads, and the line a user reads where they asked for it, both under the door's own
   * name. Every writer of that state speaks here once the state has moved, so whichever side observed a transition - the controller reporting it, a window of ours
   * opening or ending, or a remote unlock arriving - a user reads one vocabulary and a subscriber one topic, whose payload is read from the state just written.
   *
   * @param isSideDoor - Whether the side door of a UA Gate is the door being announced.
   * @param locked - Whether the door is being announced as locked.
   */
  #announceLockState(isSideDoor: boolean, locked: boolean): void {

    const { doorName, topic } = this.#doorAnnounceIdentity(isSideDoor);

    this.#publishTopic({ key: topic });

    if(this.hints.logEvents.has("Lock")) {

      this.log.info("%s %s.", doorName, locked ? "locked" : "unlocked");
    }
  }

  /* Settle a door on a reported lock state and announce the move, answering whether the door moved at all.
   *
   * A reported state moves the door only when it differs from what the door already reads, which is what lets the remote-unlock event and the door-state
   * delivery report the same transition and have it announced once: whichever reaches here first settles the door and speaks, and the one behind it finds the
   * door settled and stays silent. A report of a door locked retires that door's pending relock as well.
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

  /* The one shape a door command's refusal takes: the verb, the door as the user hears it, and the reason the command cannot be carried. Every refusal the
   * shared preamble and its gate form make is spoken here, so the voice cannot drift as commands are added.
   *
   * @param options - The verb the refusal names, the door's rendered name, and the reason, which carries its own terminal punctuation.
   */
  #refuseDoorCommand(options: { action: string; doorName: string; reason: string }): void {

    this.log.error("Unable to %s the %s. %s", options.action, options.doorName, options.reason);
  }

  /* The preamble every door command shares: name the door, resolve the control surface the command dispatches through, and refuse outright when the device cannot
   * be vouched for or carries no such surface. The surface travels in the answer rather than being re-checked by each caller, because TypeScript cannot carry a
   * narrowing of the optional handle across a function boundary...holding it in the target is what makes it non-optional where the command dispatches.
   *
   * @param options - The verb a refusal names, and whether the side door of a UA Gate is the target.
   *
   * @returns The resolved door, or `null` when the command was refused and the caller has nothing left to do.
   */
  #resolveDoorCommand(options: { action: string; isSideDoor: boolean }): DoorCommandTarget | null {

    const { action, isSideDoor } = options;
    const doorName = this.#doorCommandName(isSideDoor);

    /* The commands are only reachable through the hub view of this device. An absent one cannot happen through the adoption path, which resolves the hub view first
     * and falls back to the plain device view only for hardware carrying no hub capability - the same capability this class's lock service is gated on - but the
     * handle is optional at construction, so this is the honest boundary rather than dead code.
     */
    if(!this.hubProjection) {

      this.#refuseDoorCommand({ action, doorName, reason: "This device does not expose door controls." });

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

    const doorId = this.#gateDoor(options.isSideDoor);

    if(!doorId) {

      this.#refuseDoorCommand({ action: target.action, doorName: target.doorName, reason: "The controller reports no door for it." });

      return null;
    }

    return { ...target, doorId };
  }

  /* Every failed dispatch a door command makes, reported in one sentence shape so the verb and the door read the same way whichever command sent it.
   *
   * The attribution fallback is not one of these. It stays inside #dispatchUnlock because the refusal it answers is a retry rather than a failure, and nothing
   * arrives here until that retry has had its turn. Nor is the gate halt, whose failure the opener's handler says at debug, because the gate stands where its
   * travel left it either way.
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
   * The controller reports nothing back over the event stream for a command of ours, so an accepted close hands the door to #closeGateLockWindow rather than
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

    // For hub types other than UA Gate, this is the lock-rule path every lock surface shares: a plain momentary unlock on the default settings, and a lock rule
    // otherwise. A garage door opener on this hardware is the momentary pulse instead.
    const target = this.#resolveDoorCommand({ action, isSideDoor });

    if(!target) {

      return false;
    }

    // What this command should carry. Only a door hub consults it: a UA Gate is unlocked outright and relocked on a timer of our own, and it has already returned.
    const decision = lockCommandRule({ delayInterval: this.lockDelayInterval, isLocking });

    /* A relock is only ours to make where the relay carries a rule to reset, so a door on the default settings is told so rather than left to wonder. A garage door
     * opener never arrives here at all, its writes being the momentary pulse...this is the lock accessory's own refusal. It follows the preamble, so a door that
     * carries no control surface is refused for the reason a user can act on rather than for its relay settings.
     */
    if(decision.kind === "refuse") {

      this.log.error("Unable to manually relock the %s because the lock relay is on its default settings. " +
        "Set a lock delay interval for this door to relock it from HomeKit.", target.doorName);

      return false;
    }

    // Execute the action the policy decided on: an unconfigured delay issues the plain momentary unlock, and every other decision goes as a lock rule.
    return this.#dispatchDoorCommand(target, hub => (decision.kind === "unlock") ? this.#dispatchUnlock(hub) : hub.setLockRule(decision.rule));
  }

  // A name-symmetric counterpart to hubSideDoorLockCommand, so configureLockService's ternary and this file's other call sites can select the main door's
  // lock command by name rather than by an inline side-door check.
  private async hubLockCommand(isLocking: boolean): Promise<boolean> {

    return this.hubDoorLockCommand(isLocking);
  }

  // The side door's counterpart to hubLockCommand, so configureLockService's ternary and the side door's MQTT and trigger handlers select the side door's command
  // by name.
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

    // For Lock service type, update the service. For GarageDoorOpener on non-UA Gate hubs, also update the service, since an opener with no wired position sensor
    // derives its state from the lock relay. For UA Gate with GarageDoorOpener, DPS events handle updates since it's a motorized gate with physical positions.
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

    const closed = this.#positionReported ? this.isClosed(this.hkDpsState) : this.isLocked(this.hkLockState);

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

    const service = findService({ accessory: this.accessory, serviceType: this.hap.Service.GarageDoorOpener });

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
        findService({ accessory: this.accessory, serviceType: this.hap.Service.LockMechanism });

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

  // The side door's position as the library reads it, which is closed wherever nothing is wired to that terminal.
  private get hubSideDoorDpsState(): CharacteristicValue {

    return this.#contactReading(this.#sideDoorFacts);
  }

  /* What a UA Gate's relay says about one of its locks. Only that hardware answers from its record here: every other family's lock reading comes from the door-state
   * model, and answering secured for them is the same safe reading an unrecognized lock value gets.
   *
   * A lock's own port names its relay, and a lock whose port names none has nothing to read, so it takes that safe reading too. A relay reads off while the lock is
   * engaged, so off is secured and anything else, an absent row included, is not.
   *
   * @param isSideDoor - Whether the side door's lock is the one being read.
   *
   * @returns The lock's reading.
   */
  #relayLockState(isSideDoor: boolean): CharacteristicValue {

    if(this.uda.device_type !== "UGT") {

      return this.hap.Characteristic.LockCurrentState.SECURED;
    }

    const relayKey = gateDoorRelayKey({ device: this.uda, isSideDoor });

    if(relayKey === undefined) {

      return this.hap.Characteristic.LockCurrentState.SECURED;
    }

    const lockRelay = this.uda.configs?.find(entry => entry.key === relayKey);

    return (lockRelay?.value === "off") ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED;
  }

  // Return the state of the main gate's lock relay on a UA Gate hub.
  private get hubLockState(): CharacteristicValue {

    return this.#relayLockState(false);
  }

  // Return the current state of the side door relay lock on the UA Gate hub.
  private get hubSideDoorLockState(): CharacteristicValue {

    return this.#relayLockState(true);
  }

  /* What a terminal input reads: closed unless the terminal is in service and its reading says open. A terminal the hardware reports nothing about and one whose
   * row the library did not qualify both render as the same closed contact, so nothing downstream has to tell the two apart.
   *
   * @param facts - What the library's read established about the terminal.
   *
   * @returns The contact sensor state the terminal's live reading renders as.
   */
  #contactReading(facts: AccessTerminalInputFacts): CharacteristicValue {

    return ((facts.wired === true) && (facts.state === false)) ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED :
      this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  // The library's read of the side door's position terminal. It is the one terminal read taken outside the input table, because that sensor's existence follows the
  // user's option rather than the wiring.
  get #sideDoorFacts(): AccessTerminalInputFacts {

    return terminalInput(this.uda, "sideDps");
  }

  // Utility to retrieve a contact sensor state. Its open fallback is never reached from its caller, which confirms the service exists before reading it.
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
   * Both members are optional because the door-state entry carries only what the client's model has established about the door. An ABSENT member updates nothing
   * at all - not established is not a state, and writing a default for it would manufacture a reading the controller never made.
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
          this.#publishTopic({ key: "sidedoorDps" });

          if(this.hints.logEvents.has("DPS")) {

            this.log.info("%s is %s.", sentenceCase(SIDE_DOOR_DPS_LABEL), contactDetected ? "closed" : "open");
          }
        } else {

          this.hkDpsState = newDpsState;
          this.#publishTopic({ key: "dps" });

          if((this.doorServiceType === "GarageDoorOpener") || this.hints.logEvents.has("DPS")) {

            this.log.info("%s is %s.", sentenceCase(DPS_LABEL), contactDetected ? "closed" : "open");
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

  // A remote unlock the controller reported, applied to the door the packet names.
  private handleRemoteUnlock(packet: AccessEventPacket): void {

    const door = this.#remoteUnlockDoor(packet);

    if(door === null) {

      return;
    }

    if(this.uda.device_type === "UGT") {

      // The same hardware window a command of ours opens, begun on the controller's side instead, so it is settled and announced through the same helper.
      this.#openGateLockWindow(door === "side");

      return;
    }

    /* A hub other than a gate has no window of its own to open: its relock is the controller's own relay, reported back over the door-state rail. So the unlock
     * is applied here as one more reported reading, and an unlock the door-state rail has already delivered finds the door settled and stays silent rather than
     * announcing the same unlock a second time.
     */
    this.#applyLockState(false, this.hap.Characteristic.LockCurrentState.UNSECURED);
  }

  /* Handle a device update, delivered once our own record has folded.
   *
   * Availability is deliberately absent from here: the device base's record loop states it from the same delivery and writes no service, so an arm here would be a
   * second statement of one reading. Lock and door position are absent for the same reason - the door-state model carries both, and its
   * delivery owns them. The access method model is a reading this handler does own, under that same doctrine: the record restates its configuration rows on every
   * delivery, so this is where they reach the model, and the switches read the model rather than the rows.
   */
  private handleDeviceUpdate(): void {

    /* The record's rows are the one feed that follows the controller's access methods between settings reads, whichever dialect carried a change onto them, so
     * folding them on every delivery is what keeps the model current.
     *
     * A model still unseeded after the fold belongs to a reader the rows have not answered for, and a delivery is the controller speaking for that device, which
     * makes a settings read that failed worth another attempt. The dispatch's own guards decide whether one launches: only an unseeded reader with an official
     * surface reads, and a read already in flight asks for nothing more.
     */
    this.#foldConfigRows();
    this.#dispatchAccessMethodSeed();

    /* Process any terminal input update events if our state has changed. Keying off whether the sensor exists means eligibility is never cached: an input with
     * no service contributes nothing, and one created mid-run is picked up on the very next update. A change always reaches the topic, which says what the
     * payload reader answers: the reading where the terminal reports wired, and unknown where the sensor stands through a gap in that evidence. The line is the
     * input's own report, so it is written only for a reading the terminal made.
     */
    for(const { label, member, terminal, topic } of terminalInputs) {

      const reservedId = AccessReservedNames[("CONTACT_" + member) as keyof typeof AccessReservedNames];

      if(!this.accessory.getServiceById(this.hap.Service.ContactSensor, reservedId)) {

        continue;
      }

      const facts = terminalInput(this.uda, terminal);
      const reading = this.#contactReading(facts);

      if(reading === this.getContactSensorState(reservedId)) {

        continue;
      }

      this.setContactSensorState(reservedId, reading);
      this.#publishTopic({ key: topic });

      if((facts.wired === true) && this.hints.logEvents.has(member)) {

        this.log.info("%s is %s.", sentenceCase(label), this.isClosed(reading) ? "closed" : "open");
      }
    }

    // The record carries the wiring every terminal input and the side door's position read, and part of the main door's position evidence, so any of them that
    // moved while its reading stayed put is stated here, ahead of the re-gate as the readings are.
    this.#publishMovedEvidence(HELD_STATE_TOPICS);

    // Project tampering ahead of the re-gate, so a sensor the re-gate creates on this delivery is dressed once, from the verdict this delivery established.
    const tamperMoved = this.projectTamperState();

    /* Re-gate every service this record can move, from the evidence this update brought with it. Running the whole pass unconditionally is what lets a capability
     * arriving or going, a rebound port whose record carries its relay data, and a wiring change reach HomeKit mid-run on any hub family rather than only on the one
     * that happened to be checked for it, and the pass is cheap and silent on repeat by construction. It dresses a service it creates and nothing else, because every
     * service already standing was dressed at adoption.
     */
    this.#configureServices({ initialized: true });

    /* The tamper topic follows the pass rather than the projection, because the pass is what puts the characteristic on each sensor and takes it off again: a
     * verdict this delivery moved is published only where a sensor carries it once the pass is done, so a capability arriving with its reading is heard and one
     * leaving takes its topic silent with it.
     */
    if(tamperMoved) {

      this.#publishTopic({ key: "tamper" });
    }

    /* The switches follow the record the same way: a method capability arriving or going reaches HomeKit on this delivery, from what the seeded model holds. A pass
     * over an unchanged record finds every switch dressed, registers nothing, and restates each switch's value; an unseeded model runs no pass at all, as the guard
     * inside states.
     */
    this.#materializeSeededSwitches();
  }

  /* Project tampering. The condition lives on this rail alone: the configure path adopts a baseline and dresses the sensors from it, and every change after that
   * arrives here, ahead of the delivery's service pass. A reading that agrees with the one we hold is not a change, and nothing below describes anything but a
   * change - the characteristic, the log, and the topic the caller publishes alike - so a restated record moves none of them. A reading that is a change lands in
   * the held verdict before the pass runs, which is what lets a sensor the pass creates, and a sensor the pass attaches the characteristic to, read the verdict
   * this delivery established rather than the one it moved past.
   *
   * The characteristic and the topic both carry the condition itself, so each moves on every change. The characteristic reaches every contact sensor of capable
   * hardware through the library's sweep, the pass being what puts it on each sensor and what takes it off again. The topic spells the reading's three answers as
   * they are, with unknown standing in for nothing established, so a subscriber holding unknown hears the reading return the moment it does; it is published by
   * the caller once the pass is done, because the topic exists only while a sensor carries the characteristic, and the pass is what settles which ones do. The log
   * announces transitions alone, because a reading seen for the first time is not one anybody observed. A reading the library withdraws - the console's tampering
   * alert switched off, so the hardware has stopped revising its tamper input - is a transition from a held verdict: a raised status clears, the change is said
   * once, and the verdict is forgotten so that the next reading to arrive is adopted on the log in silence exactly as a first sighting is. Hardware that stops
   * reporting the capability at all is that same transition with its own sentence, and the characteristic leaves every sensor through the pass rather than through
   * the sweep here, so nothing is written to a characteristic that is about to go, and the topic goes silent with it; the return of either the capability or the
   * reading is adopted in silence, as every first sighting is.
   *
   * A raise and clear that both fall inside a connectivity gap is undetectable on any rail, since the controller keeps no tamper history and the notification
   * frames name no device...so what we project after a gap is simply where the hardware stands now.
   *
   * @returns Whether the held verdict moved, which is what the caller's publish of the topic waits on.
   */
  private projectTamperState(): boolean {

    const capable = isTamperCapable(this.uda);
    const verdict = capable ? tamperState(this.uda) : undefined;

    if(verdict === this.tamperVerdict) {

      return false;
    }

    const held = this.tamperVerdict;

    this.tamperVerdict = verdict;

    if(capable) {

      updateServices(this.accessory, this.hap.Characteristic.StatusTampered, this.#tamperRendering(verdict));
    }

    // A first sighting is adopted without a word.
    if(held === undefined) {

      return true;
    }

    // A raised condition, its clearing, and its withdrawal are each said once, the withdrawal with why the status reads normal.
    switch(verdict) {

      case undefined:

        this.log.info(capable ? "Tampering alerts are turned off on the controller, so the tamper status reads normal until they are turned on again." :
          "The device no longer reports tamper detection, so its tamper status is withdrawn until it does.");

        break;

      case true:

        this.log.info("Tampering detected.");

        break;

      case false:

        this.log.info("Tampering no longer detected.");

        break;
    }

    return true;
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
    findService({ accessory: this.accessory, serviceType: this.hap.Service.Doorbell })?.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
      ?.sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

    // Update our doorbell trigger, if needed.
    this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, true);

    // Publish to MQTT, where the doorbell HomeKit shows exists.
    this.#publishTopic({ key: "doorbell", payload: "true" });

    if(this.hints.logEvents.has("Doorbell")) {

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

    this.#publishTopic({ key: (door === "side") ? "sidedoorUnlock" : "unlock", payload: JSON.stringify(attribution) });

    // The sentence is composed rather than formatted in place, because the door's name is whatever an administrator called it and has no business being read as a
    // format string.
    if(this.hints.logEvents.has("Lock")) {

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

    if(this.hints.logEvents.has("Doorbell")) {

      this.log.info("Doorbell call ended: %s", lowerFirst(doorbellOutcome(delivery.data.object.reason_code)));
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

    // Publish to MQTT, where the doorbell HomeKit shows exists.
    this.#publishTopic({ key: "doorbell", payload: "false" });

    if(this.hints.logEvents.has("Doorbell")) {

      this.log.info("Doorbell ring cancelled.");
    }
  }

  // Handle hub-related events.
  private eventHandler(packet: AccessEventPacket): void {

    switch(packet.event) {

      case ACCESS_DEVICE_UPDATE_EVENT:

        this.handleDeviceUpdate();

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
