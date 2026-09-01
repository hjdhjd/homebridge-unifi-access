/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-mqtt.ts: MQTT connection settings and topic composition for UniFi Access.
 */
import type { FeatureOptions, Nullable } from "homebridge-plugin-utils";
import { ACCESS_MQTT_TOPIC } from "./settings.ts";

/**
 * Resolve the MQTT broker and topic prefix for one controller, or `null` when that controller has no broker anywhere and MQTT is therefore off for it.
 *
 * Both settings resolve at the controller's own scope first, with the legacy per-controller configuration properties as the transition fallback, so a configuration
 * nobody has opened the webUI on keeps working exactly as it did.
 *
 * Each read asks its question differently, and deliberately. The broker option defaults off, so an unconfigured broker resolves to nothing and the legacy property
 * answers through the nullish fallback. The topic option carries an always-on default, so reading its value would answer that default even where the user has
 * configured nothing...which would silently outrank a legacy topic. Configured-ness for the topic is therefore read through the option's scope, and only a topic the
 * user has actually touched supersedes the legacy property. Where neither is touched, the plugin's canonical topic prefix answers.
 *
 * A legacy topic of the empty string counts as unset, which is what a blank configuration field means and what the client itself makes of one: an empty prefix
 * disables MQTT outright, so passing it through would silently turn off a controller that is publishing today.
 *
 * @param featureOptions - The feature-option engine the option entries resolve through.
 * @param config         - The controller's configuration, carrying the legacy broker and topic properties.
 * @param mac            - The controller's MAC address, or `undefined` for an identity that never resolves one and can therefore never be addressed by a
 *                         per-controller option entry.
 *
 * @returns The resolved broker URL and topic prefix, or `null` when no broker is configured for this controller.
 */
export function mqttConnectionSettings(featureOptions: FeatureOptions, config: { mqttTopic?: string; mqttUrl?: string },
  mac: string | undefined): Nullable<{ brokerUrl: string; topicPrefix: string }> {

  const brokerUrl = featureOptions.value("Mqtt.Url", undefined, mac) ?? config.mqttUrl;

  if(!brokerUrl) {

    return null;
  }

  // The emptiness test is the one the client applies to the prefix it is handed, so what counts as no topic here is what counts as no topic there.
  const legacyTopic = config.mqttTopic?.length ? config.mqttTopic : undefined;
  const topicPrefix = (featureOptions.scope("Mqtt.Topic", undefined, mac) !== "none") ? featureOptions.value("Mqtt.Topic", undefined, mac) : legacyTopic;

  return { brokerUrl, topicPrefix: topicPrefix ?? ACCESS_MQTT_TOPIC };
}

/**
 * Compose the topic tail for one device's MQTT topic. The client prepends the configured topic prefix and nothing else, so the tail composed here is what decides
 * the rest of the path, and the broker-visible result is `prefix/id/topic`.
 *
 * The composition has one statement here so that every publish and subscribe site in the plugin spells a topic the same way rather than repeating a concatenation
 * at each of them. The id is the device's identity - its decorated serial - so a topic on the wire reads exactly as the device is addressed everywhere else: in
 * the startup log, in a feature-option entry, and in the webUI.
 *
 * @param id    - The device identity the topic addresses.
 * @param topic - The topic tail relative to that device.
 *
 * @returns The composed topic tail.
 */
export function mqttTopic(id: string, topic: string): string {

  return id + "/" + topic;
}
