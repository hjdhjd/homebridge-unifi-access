/* Copyright(C) 2022-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-unifi-access.
 */
// The name of our plugin.
export const PLUGIN_NAME = "homebridge-unifi-access";

// The platform the plugin creates.
export const PLATFORM_NAME = "UniFi Access";

// How often, in seconds, should we check Access controllers for new or removed devices.
export const ACCESS_CONTROLLER_REFRESH_INTERVAL = 120;

// How often, in seconds, should we retry getting our bootstrap configuration from the Access controller.
export const ACCESS_CONTROLLER_RETRY_INTERVAL = 10;

// Default delay, in seconds, before removing Access devices that no longer exist.
export const ACCESS_DEVICE_REMOVAL_DELAY_INTERVAL = 60;

// Default delay, in minutes, before locking an unlocked door relay.
export const ACCESS_DEVICE_UNLOCK_INTERVAL = 0;

// Default duration, in seconds, of motion events. Setting this too low will potentially cause a lot of notification spam.
export const ACCESS_MOTION_DURATION = 10;

// How often, in seconds, should we try to reconnect with an MQTT broker, if we have one configured.
export const ACCESS_MQTT_RECONNECT_INTERVAL = 60;

// Default MQTT topic to use when publishing events. This is in the form of: unifi/access/MAC/event
export const ACCESS_MQTT_TOPIC = "unifi/access";

// Default duration, in seconds, of occupancy events.
export const ACCESS_OCCUPANCY_DURATION = 300;
