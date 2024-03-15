/* Copyright(C) 2020-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-types.ts: Interface and type definitions for UniFi Access.
 */

// Define Access logging conventions.
export interface AccessLogging {

  debug: (message: string, ...parameters: unknown[]) => void,
  error: (message: string, ...parameters: unknown[]) => void,
  info: (message: string, ...parameters: unknown[]) => void,
  warn: (message: string, ...parameters: unknown[]) => void
}

// HBUA reserved names.
export enum AccessReservedNames {

  // Manage our switch types.
  SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger",
  SWITCH_LOCK_TRIGGER = "LockTrigger",
  SWITCH_MOTION_SENSOR = "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER = "MotionSensorTrigger"
}
