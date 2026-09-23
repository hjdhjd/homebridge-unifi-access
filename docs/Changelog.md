# Changelog

All notable changes to this project will be documented in this file.

## 2.0.1 (2026-09-22)
  * Fix: HBUA now connects to controllers that have a floor with no doors on it, which failed in 2.0.0 with "doors is not iterable".
  * Improvement: when HBUA cannot complete a connection to a controller, the log now tells you why - once when the failures begin, and again if the reason changes - instead of retrying silently.
  * Housekeeping.

## 2.0.0 (2026-09-19)
  * **HBUA 2 is a ground-up redesign of the plugin, rebuilt from first principles on the unifi-access v2 client, homebridge-plugin-utils v2, and a Homebridge 2.0 base. The goal was a plugin that is futureproof, scalable, and maintainable, with room for more capabilities and deeper integration across the UniFi plugin family, Protect included. A modern Node baseline let me build entirely on modern JavaScript and Node runtime features. This is a major version bump, so please read through the notes below before you upgrade.**
  * **Breaking change: Homebridge 2.0 and Node 22.20 (or better) are now required.** HBUA 2 no longer supports Homebridge 1.x.
  * **Breaking change: every HBUA accessory is recreated in HomeKit on upgrade.** Devices are now identified by their serial number, so HomeKit sees each one as a new accessory. Room assignments, scenes, and automations that reference an HBUA accessory need to be set up again after the upgrade.
  * **Breaking change: the MQTT `lock/set` topic now means what it says.** Publishing `true` locks the door and `false` unlocks it. In 1.x, `true` unlocked the door momentarily and `false` unlocked it indefinitely, so any automation that publishes `true` to unlock a door needs to publish `false` instead. On hubs other than the UA Gate, locking requires a lock delay interval to be configured - a door on the default momentary unlock has nothing to relock, and the request is refused with an error in the log.
  * New feature: API token support. You can now configure a controller with just a UniFi Access API token - no local account required - and HBUA will project your door hardware into HomeKit from the official Access API, including access method switches on readers. Tokens also unlock the webhook and attribution features below. As always, configure this through the HBUA webUI.
  * New feature: an all-new webUI for v2, rebuilt on the same framework as HBUP. Everything is configured there now, including MQTT. Your existing settings migrate automatically the first time you open it - no action needed - and devices are now addressed by one identity format shared across the plugin family, aligning HBUA with HBUP for the future. If you have automations built on device-specific MQTT topics, they now use that same identity - the device serial, in uppercase, as shown in the webUI - so a topic built on the lowercase MAC address from 1.x needs updating.
  * New feature: a live device status panel in the webUI. Selecting a device shows its lock, door position, tamper, and availability state streaming in real time, a reader's access methods and which are enabled, and which API surfaces your controller connection is running with.
  * New feature: webhook support. When enabled, HBUA listens for webhook deliveries from your Access controller and tells you who unlocked a door and how - in the log and over MQTT - along with how doorbell calls ended. Requires an API token.
  * New feature: unlock attribution. Doors unlocked through HomeKit now show as "Homebridge" in the Access activity history, wherever your controller can record it.
  * New feature: garage door openers now show real opening, closing, and stopped states backed by the door position sensor, with a configurable travel duration. Look for the transition duration option in the Hub section of the HBUA webUI.
  * New feature: live tamper status on hub contact sensors. Hubs whose hardware detects tampering now show a tamper status on every contact sensor they expose, reading normal until the hardware reports otherwise, and switching the tampering alert off in the UniFi Access console clears a raised status rather than leaving a stale reading standing in HomeKit. A tamper-capable hub also publishes its tamper status over MQTT on the `tamper` topic: `true` when tampering is detected, `false` when it is no longer detected, and `unknown` while tampering alerts are turned off on the controller.
  * New feature: the doorbell trigger switch can now ring and cancel the doorbell through the official Access API when a token is configured, and you can filter doorbell rings by door guard so only the calls assigned to you ring in HomeKit.
  * New feature: accessories left behind by a replaced or removed controller are now reclaimed automatically once every configured controller has connected - no more orphaned accessories lingering in HomeKit after a hardware swap.
  * Behavior change: two settings have a new home in the HBUA webUI. How a door is presented in HomeKit is now one choice - Automatic, Lock, or GarageDoorOpener - in the Hub section, with Automatic giving the same defaults as before: a UA Gate as a garage door opener and every other hub as a lock. Access method switches on readers are now chosen from a list in the Access Method section, offering only the methods each reader supports, and none are selected until you pick them. If you had customized either in 1.x, make your selection again there.
  * Improvement: availability is now honest. Sensors reflect controller reachability alongside the device's own state, answered live on every read, and door commands during an outage tell you plainly why they can't be carried out.
  * Improvement: accessories now show as Not Responding in HomeKit while the controller or the device cannot be reached. Every readable characteristic - locks, door states, switches, contact sensors, tamper status - refuses a read during an outage instead of answering the last value it heard, and answers again on the next read once the device is back.
  * Improvement: door position and lock state now come from the controller's live door-state model, and the UA Gate's unlock goes through the controller's native routing - both directions of a gate now work with API tokens.
  * Improvement: when the plugin cannot work out the address your Access controller should deliver webhooks to - a hostname that does not resolve, for instance - it now says so and skips the registration, rather than quietly registering an endpoint that could never receive anything.
  * Fix: MQTT subscriptions and publishes now end with the device they belong to. A door removed from Access mid-run stops answering its MQTT topics and publishes nothing further on them, a device re-added under the same identity no longer answers twice, and a door command that a removal overtakes while it's still in flight announces nothing on the removed device's behalf.
  * Housekeeping.

## 1.12.1 (2026-01-23)
  * Fix: address a potential issue where removed devices could cause an error during the device removal delay period.
  * Housekeeping.

## 1.12.0 (2026-01-23)
  * New feature: G6 Entry reader support. HBUA now fully supports access method switches on G6 Entry camera-based readers, allowing you to toggle Face, Mobile, NFC, and TouchPass unlock methods directly from HomeKit.
  * New feature: TouchPass access method support for devices with Apple Pass capability.
  * Fix: access method switches now correctly appear and disappear based on feature option settings in the HBUA webUI.
  * Housekeeping.

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
