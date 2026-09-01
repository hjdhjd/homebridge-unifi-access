/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-types.ts: Interface and type definitions for UniFi Access.
 */
import type { PlatformAccessory, PlatformConfig } from "homebridge";
import type { AccessControllerOptions } from "./access-options.ts";

// The typed view of an Access accessory's persisted HomeKit context: the key of the controller that created it, the device identity it was minted under - the
// decorated serial, absent on an accessory created by a version that recorded none - and the hardware MAC address it names. Every key is optional because a device
// resets and repopulates its context when it is configured, so a cached accessory can be read before any of them has been written. Declaring the keys replaces the
// UnknownContext index signature homebridge supplies by default, which is what lets every context read be a declared-property access...the shared tsconfig sets
// noPropertyAccessFromIndexSignature, so an untyped context would force a bracket access or a cast at each read site rather than stating the contract once here.
export interface AccessAccessoryContext {

  controller?: string;
  id?: string;
  mac?: string;
}

// An Access accessory: a homebridge PlatformAccessory carrying our typed context. This alias is the single name threaded through every accessory field, parameter, and
// creation site, so the context contract lives in exactly one place rather than being re-annotated wherever an accessory is handled.
export type AccessAccessory = PlatformAccessory<AccessAccessoryContext>;

// A typed view of this plugin's slice of the homebridge PlatformConfig. PlatformConfig carries an index signature for arbitrary user configuration, so declaring the keys
// we actually read lets the platform constructor reach them as typed properties rather than index-signature accesses, while still satisfying the DynamicPlatformPlugin
// contract because every key we add is optional.
export interface AccessPlatformConfig extends PlatformConfig {

  controllers?: AccessControllerOptions[];
  options?: string[];
}

/* A frozen lookup of the reserved subtype identifiers we assign to the HomeKit services this plugin synthesizes. It is modeled as an "as const" object rather than a
 * TypeScript enum because the shared tsconfig sets erasableSyntaxOnly: an enum emits runtime code that type erasure cannot produce, so the enum form is not valid syntax
 * here at all. Every value below is persisted in the Homebridge accessory cache as the subtype of the service it names, so a value that drifts orphans that service on
 * every install in the field...treat these strings as immutable. The companion type alias below carries the uses that read AccessReservedNames in type position.
 */
export const AccessReservedNames = {

  // Manage our contact sensor types.
  CONTACT_DPS: "ContactSensor.DPS",
  CONTACT_DPS_SIDE: "ContactSensor.DPS.Side",
  CONTACT_REL: "ContactSensor.REL",
  CONTACT_REN: "ContactSensor.REN",
  CONTACT_REX: "ContactSensor.REX",

  // Manage our door/lock types.
  LOCK_DOOR_SIDE: "Lock.Door.Side",

  // Manage our switch types.
  SWITCH_ACCESSMETHOD_FACE: "AccessMethod.Face",
  SWITCH_ACCESSMETHOD_HAND: "AccessMethod.Hand",
  SWITCH_ACCESSMETHOD_MOBILE: "AccessMethod.Mobile",
  SWITCH_ACCESSMETHOD_NFC: "AccessMethod.NFC",
  SWITCH_ACCESSMETHOD_PIN: "AccessMethod.PIN",
  SWITCH_ACCESSMETHOD_QR: "AccessMethod.QR",
  SWITCH_ACCESSMETHOD_TOUCHPASS: "AccessMethod.TouchPass",
  SWITCH_DOORBELL_TRIGGER: "DoorbellTrigger",
  SWITCH_LOCK_DOOR_SIDE_TRIGGER: "Switch.Lock.Door.Side.Trigger",
  SWITCH_LOCK_TRIGGER: "LockTrigger"
} as const;

// The union of reserved-name values. It gives the reserved names a type identity alongside their value identity, so a signature written as "name: AccessReservedNames"
// resolves against exactly the strings the object above declares.
export type AccessReservedNames = (typeof AccessReservedNames)[keyof typeof AccessReservedNames];
