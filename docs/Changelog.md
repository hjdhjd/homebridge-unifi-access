# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

## 1.11.0 (2026-01-11)
  * New feature: UniFi Access Gate support. HBUA now supports the UA Gate with full support for both the main gate and side door (pedestrian gate). The main gate defaults to a garage door opener service to match typical gate behavior, while the side door is exposed as a lock. Both doors have their own door position sensors exposed as contact sensors in HomeKit. As always, you can adjust these through the HBUA webUI. Thank you to @mickael-palma-wttj for the initial plumbing - I appreciate your contribution to the community! **Note: UA Gate support should be considered experimental as I don't have access to the hardware to fully test it. If you encounter issues, please reach out on the #unifi-access channel on the Homebridge Discord so we can troubleshoot together.**
  * New feature: you can now choose whether to expose your door as a lock or garage door opener accessory in HomeKit. UA Gate defaults to garage door opener, while other hubs default to lock. This is purely a visual preference for how the accessory appears in HomeKit - the underlying behavior remains the same. Look for the door service type options in the Hub section of the HBUA webUI.
  * Housekeeping.

## 1.10.1 (2025-11-24)
  * Housekeeping.

## 1.10.0 (2025-11-10)
  * New feature: UniFi Access Gate Hub support. Thank you to @tdabasinskas for the plumbing tidbits - I appreciate your contribution to the community!
  * New feature: UniFi Access readers are now supported. Readers, and hubs with reader functionality, now expose access-method switches that let you selectively enable or disable individual methods. Depending on device capabilities, HBUA can now toggle face, hand-wave, mobile, NFC, PIN, or QR access. Credit to @master-nevi for the suggestion. Thank you for your contributions to the community!
  * New feature: all dry contact sensors that are available to Hub, Hub Mini, and Ultra devices. The dry contacts that are available are: DPS, REL, REN, REX. They will appear as contact sensors in HomeKit and are enabled by default. As always, you can adjust their availability in HomeKit through the HBUA webUI. For the Ultra, given it has a configurable dry contact, HBUA will autodetect which one is enabled and make that available dynamically.
  * Behavior change: by default device delay interval is on.
  * Housekeeping.

## 1.9.2 (2025-05-27)
  * Housekeeping.

## 1.9.1 (2025-05-27)
  * Improvement: refinements to MQTT status updates for DPS. It will return `unknown` when the DPS isn't wired.
  * Fix: address a regression to ensure automation triggers are created and managed correctly.
  * Housekeeping.

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
