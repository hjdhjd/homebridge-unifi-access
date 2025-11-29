/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-types.ts: Interface and type definitions for UniFi Access.
 */

// HBUA reserved names.
export enum AccessReservedNames {

  // Manage our contact sensor types.
  CONTACT_DPS = "ContactSensor.DPS",
  CONTACT_REL = "ContactSensor.REL",
  CONTACT_REN = "ContactSensor.REN",
  CONTACT_REX = "ContactSensor.REX",

  // Manage our lock types.
  LOCK_SIDE_DOOR = "Lock.SideDoor",

  // Manage our switch types.
  SWITCH_ACCESSMETHOD_FACE = "AccessMethod.Face",
  SWITCH_ACCESSMETHOD_HAND = "AccessMethod.Hand",
  SWITCH_ACCESSMETHOD_MOBILE = "AccessMethod.Mobile",
  SWITCH_ACCESSMETHOD_NFC = "AccessMethod.NFC",
  SWITCH_ACCESSMETHOD_PIN = "AccessMethod.PIN",
  SWITCH_ACCESSMETHOD_QR = "AccessMethod.QR",
  SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger",
  SWITCH_LOCK_TRIGGER = "LockTrigger",
  SWITCH_SIDEDOOR_LOCK_TRIGGER = "SideDoorLockTrigger",
  SWITCH_MOTION_SENSOR = "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER = "MotionSensorTrigger"
}
