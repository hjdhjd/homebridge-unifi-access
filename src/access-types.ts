/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-types.ts: Interface and type definitions for UniFi Access.
 */

// HBUA reserved names.
export enum AccessReservedNames {

  // Manage our contact sensor types.
  CONTACT_DPS = "ContactSensor.DPS",

  // Manage our switch types.
  SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger",
  SWITCH_LOCK_TRIGGER = "LockTrigger",
  SWITCH_MOTION_SENSOR = "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER = "MotionSensorTrigger",
  SWITCH_READER_HAND_WAVE = "ReaderHandWaveSwitch"
}
