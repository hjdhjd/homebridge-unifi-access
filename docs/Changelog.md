# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

## 1.9.0 (2025-05-27)
  * New feature: MQTT support for door position sensors.
  * Fix: address a regression in MQTT status updates.
  * Housekeeping.

## 1.8.0 (2025-05-26)
  * New feature: door position sensor support on Access hubs that have them.
  * Housekeeping.

## 1.7.2 (2025-05-26)
  * Fix: correctly interpret the lock state of Door Hub Mini devices.
  * Housekeeping.

## 1.7.1 (2025-05-15)
  * Fix: correctly interpret the lock state of Ultra devices.
  * Fix: recent Access controller firmwares seem to have quirks that interfered with how HBUA detects new devices and device removals, causing constant add/remove cycles.
  * Housekeeping.

## 1.7.0 (2025-05-04)
  * New feature: add support for UniFi Access Ultra.
  * Housekeeping.

## 1.6.0 (2025-04-27)
  * New feature: add support for UniFi Access Hub Mini.
  * Housekeeping.

## 1.5.0 (2024-10-02)
  * Behavior change: HBUA will now ensure HomeKit accessory names are compliant with [HomeKit's naming guidelines](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names). Invalid characters will be replaced with a space, and multiple spaces will be squashed.
  * Improvement: support for UniFi Access v2.3.
  * Housekeeping.

## 1.4.0 (2024-08-04)
  * Improvement: now fully supporting UniFi Access v2, including all Access hubs.
  * Housekeeping.

## 1.3.0 (2024-04-20)
  * New feature: add support for the latest generation of UniFi Access hubs.

## 1.2.2 (2024-03-31)
  * Fix: disconnected devices could appear as no longer belonging to a given Access controller.
  * Housekeeping.

## 1.2.1 (2024-03-16)
  * Housekeeping.

## 1.2.0 (2024-03-15)
  * New feature: automation switch support for locks, primarily intended for automation scenarios.
  * Housekeeping.

## 1.1.0 (2024-03-13)
  * Improvement: MQTT support for doorbell status.
  * Housekeeping.

## 1.0.0 (2024-03-12)
  * Initial release.
  * New feature: support for door relay lock devices.
  * New feature: support for doorbells on hubs.
  * New feature: automation switches for doorbells.
  * New feature: MQTT support.
