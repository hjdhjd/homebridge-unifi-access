/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-mqtt.test.ts: Tests for MQTT connection settings and topic composition.
 *
 * The resolution arms drive the real feature-option engine over the plugin's own catalog rather than a stand-in, so what they pin is the behavior a running
 * configuration actually gets, including how the engine answers an option nobody has configured.
 */
import { featureOptionCategories, featureOptions } from "./access-options.ts";
import { mqttConnectionSettings, mqttTopic } from "./access-mqtt.ts";
import { ACCESS_MQTT_TOPIC } from "./settings.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import test from "node:test";

// The controller every per-controller option entry below is scoped to.
const CONTROLLER_MAC = "AABBCCDDEEFF";

/* The broker and topic fixtures. Every topic here is deliberately something other than ACCESS_MQTT_TOPIC, so an assertion expecting the canonical prefix can never
 * pass by coinciding with a fixture, and one expecting a fixture can never pass by coinciding with the catalog default.
 */
const LEGACY_BROKER = "mqtt://legacy.broker";
const LEGACY_TOPIC = "legacy/access";
const OPTION_BROKER = "mqtt://option.broker";
const OPTION_TOPIC = "option/access";

/**
 * Resolve one controller's MQTT settings through the engine the plugin runs.
 *
 * Every caller states the MAC address rather than leaning on a default, because `undefined` is a meaningful value here - it is the token-only controller - and a
 * parameter default would quietly substitute a MAC for exactly the arm that needs none, leaving that arm asserting something other than what it names.
 *
 * @param configured - The feature-option entries the user has configured.
 * @param config     - The controller's configuration properties.
 * @param mac        - The controller's MAC address, or `undefined` for a controller that resolves none.
 *
 * @returns What the resolution answers for that configuration.
 */
function resolve(configured: string[], config: { mqttTopic?: string; mqttUrl?: string },
  mac: string | undefined): ReturnType<typeof mqttConnectionSettings> {

  return mqttConnectionSettings(new FeatureOptions(featureOptionCategories, featureOptions, configured), config, mac);
}

test("no broker configured anywhere leaves MQTT off for the controller", () => {

  assert.equal(resolve([], {}, CONTROLLER_MAC), null);

  // A topic is not a broker, so a configuration carrying one and nothing else still has nothing to connect to.
  assert.equal(resolve([], { mqttTopic: LEGACY_TOPIC }, CONTROLLER_MAC), null);
});

test("a configuration carrying only the legacy properties resolves exactly what it always resolved", () => {

  /* Both properties set is the shape of every configuration running today, and this is the assertion the whole transition rests on. It is also what fails a
   * resolution that reads the topic option's value without first asking whether the user configured it: that option defaults on, so its value answers the canonical
   * prefix even for a user who has never opened the webUI, and a naive read would silently retopic every automation already subscribed to the legacy one.
   */
  assert.deepEqual(resolve([], { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC), { brokerUrl: LEGACY_BROKER, topicPrefix: LEGACY_TOPIC });

  // A broker with no topic beside it resolves the plugin's canonical prefix.
  assert.deepEqual(resolve([], { mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC), { brokerUrl: LEGACY_BROKER, topicPrefix: ACCESS_MQTT_TOPIC });

  /* An explicit empty topic is what a blank configuration field produces. It resolves the canonical prefix rather than passing through, because the client reads an
   * empty prefix as no MQTT at all and would quietly disconnect a controller that is publishing today.
   */
  assert.deepEqual(resolve([], { mqttTopic: "", mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC), { brokerUrl: LEGACY_BROKER, topicPrefix: ACCESS_MQTT_TOPIC });
});

test("a configured option supersedes the legacy property it stands in for", () => {

  // The broker: a resolution reading the configuration property first would answer the legacy broker here.
  assert.deepEqual(resolve(["Enable.Mqtt.Url." + CONTROLLER_MAC + "." + OPTION_BROKER], { mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC),
    { brokerUrl: OPTION_BROKER, topicPrefix: ACCESS_MQTT_TOPIC });

  // The topic, with a legacy topic present to be superseded.
  assert.deepEqual(resolve(["Enable.Mqtt.Topic." + CONTROLLER_MAC + "." + OPTION_TOPIC], { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC),
    { brokerUrl: LEGACY_BROKER, topicPrefix: OPTION_TOPIC });
});

test("a topic option the user has touched owns the answer even when it carries no topic of its own", () => {

  /* Disabling the topic option at the controller's scope is the user speaking about the topic, so the option layer answers and the canonical prefix stands. The
   * alternative - a legacy property outranking an option the user deliberately reached for - would leave no way to walk a controller off its legacy topic short of
   * editing the configuration file by hand.
   */
  assert.deepEqual(resolve(["Disable.Mqtt.Topic." + CONTROLLER_MAC], { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC),
    { brokerUrl: LEGACY_BROKER, topicPrefix: ACCESS_MQTT_TOPIC });
});

test("a controller that resolves no MAC address rides its legacy configuration", () => {

  /* A token-only identity never resolves a controller MAC, so no per-controller option entry can ever address it and the fallback chain is the whole of its MQTT
   * provenance. That is a bound of the identity rather than a transient startup window, so it is pinned here as the deliberate answer.
   */
  assert.deepEqual(resolve([], { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, undefined), { brokerUrl: LEGACY_BROKER, topicPrefix: LEGACY_TOPIC });

  // Another controller's entries must not reach it either, which is what fails a resolution that ignores the scope it was handed.
  assert.deepEqual(resolve([ "Enable.Mqtt.Url." + CONTROLLER_MAC + "." + OPTION_BROKER, "Enable.Mqtt.Topic." + CONTROLLER_MAC + "." + OPTION_TOPIC ],
    { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, undefined), { brokerUrl: LEGACY_BROKER, topicPrefix: LEGACY_TOPIC });
});

test("the composed tail reproduces the wire topic every subscriber already relies on", () => {

  assert.equal(mqttTopic("AABBCCDDEEFF", "lock"), "AABBCCDDEEFF/lock");

  // A nested tail is composed verbatim, so the side door topics keep their shape too.
  assert.equal(mqttTopic("AABBCCDDEEFF", "sidedoor/lock"), "AABBCCDDEEFF/sidedoor/lock");

  /* The client prepends the configured prefix and nothing else, so the broker sees prefix + "/" + this tail. Asserting the tail is what this module owns; that the
   * client prepends its prefix is the library's own tested contract.
   */
  assert.equal("unifi/access" + "/" + mqttTopic("AABBCCDDEEFF", "doorbell"), "unifi/access/AABBCCDDEEFF/doorbell");
});
