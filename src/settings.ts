/* Copyright(C) 2022-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-unifi-access.
 */
import type { AccessOfficialWebhookEventName } from "unifi-access";

// The name of our plugin.
export const PLUGIN_NAME = "homebridge-unifi-access";

// The platform the plugin creates.
export const PLATFORM_NAME = "UniFi Access";

// How many consecutive authentication failures a connect attempt is given before we stop retrying. A controller still sorting out its own auth state after a restart
// deserves a few attempts, but credentials that are simply wrong should say so rather than looping in silence.
export const ACCESS_CONTROLLER_AUTH_FAILURE_LIMIT = 3;

// Default delay, in seconds, before removing Access devices that no longer exist.
export const ACCESS_DEVICE_REMOVAL_DELAY_INTERVAL = 60;

// What we say when a removal is held for that delay, taking the accessory's name, the delay, and its plural suffix. The controller's departure path and the
// platform's reclaim of a stranded accessory both hold a removal this way, so the user reads one sentence for one behavior whichever of them armed the timer.
export const ACCESS_DEVICE_REMOVAL_DELAY_MESSAGE = "%s: Delaying device removal for at least %s second%s.";

// Default delay, in minutes, before locking an unlocked door relay.
export const ACCESS_DEVICE_UNLOCK_INTERVAL = 0;

// Default travel time, in seconds, a garage door opener is given to open or close. It is the value the duration option offers when a user turns the option on
// without saying how long their own door takes, so it is a plausible middle for a residential door rather than a measurement of any particular one.
export const ACCESS_GARAGE_TRANSITION_DURATION = 15;

// Default MQTT topic to use when publishing events. This is in the form of: unifi/access/MAC/event
export const ACCESS_MQTT_TOPIC = "unifi/access";

// The port the webhook listener binds to by default. One listener serves every controller configured in the plugin, routed by path.
export const ACCESS_WEBHOOK_PORT = 10120;

// How far a delivery's signed timestamp may sit from this host's clock before the delivery is refused as stale or replayed. Generous enough to absorb ordinary
// clock skew between a controller and a Homebridge host, and far shorter than any replay an attacker could make use of. The replay ledger forgets a delivery's
// identifier on the same horizon, because a delivery older than this is refused before the ledger is consulted.
export const ACCESS_WEBHOOK_FRESHNESS_WINDOW_MS = 300000;

// The largest delivery body the listener reads. A delivery carries one device record and one event payload, which the live captures put in the low kilobytes.
export const ACCESS_WEBHOOK_BODY_LIMIT = 65536;

// The path prefix every controller's endpoint registers under; the controller's configured address follows it, percent-encoded.
export const ACCESS_WEBHOOK_PATH_PREFIX = "/unifi-access/";

// How long the listener waits before retrying a port that was in use - long enough for a previous instance to release it during a restart.
export const ACCESS_WEBHOOK_LISTEN_RETRY_MS = 5000;

// The deliveries the plugin consumes, by name, and the registration list derived from them. The names are stated here once: the hub's handlers and the
// registration both read these members, so the set a controller is asked to deliver and the set the plugin listens for cannot drift apart.
export const ACCESS_WEBHOOK_EVENTS = { doorUnlock: "access.door.unlock", doorbellCompleted: "access.doorbell.completed" } as const satisfies
  Record<string, AccessOfficialWebhookEventName>;
export const ACCESS_WEBHOOK_EVENT_LIST: readonly AccessOfficialWebhookEventName[] = Object.values(ACCESS_WEBHOOK_EVENTS);
