/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.test.ts: Tests for the MQTT topic catalog and the broker and topic resolution the plugin constructs its client from.
 *
 * The resolution arms drive the library's resolver over the plugin's own feature-option catalog rather than a stand-in, so what they assert is the behavior a
 * running configuration actually gets, including how the engine answers an option nobody has configured.
 *
 * Importing the topic catalog runs the builder's own validation, so a declaration carrying a duplicate wire topic, an entry with no message text at all, or a
 * malformed placeholder fails this whole file at load rather than reaching a broker.
 */
import { FeatureOptions, MQTT_DEVICE_COLUMN, mqttConnectionSettings, mqttTopic } from "homebridge-plugin-utils";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { ACCESS_MQTT_TOPIC } from "./settings.ts";
import assert from "node:assert/strict";
import { mqttTopics } from "./mqtt.ts";
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

  return mqttConnectionSettings({ config, controller: mac, featureOptions: new FeatureOptions(featureOptionCategories, featureOptions, configured) });
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

test("a topic option the user turned off leaves MQTT off for that controller", () => {

  /* An option the user configured answers in every state it can be in, and off is one of those states. A controller whose topic option is off is therefore a
   * controller whose MQTT is off, even with a perfectly usable legacy pair sitting beside it: the user reached for the option and said no, and a configuration
   * property does not get to speak over that. The prefix has no second-choice answer to fall back on either, since the canonical one is what an untouched option
   * already resolves.
   */
  assert.equal(resolve(["Disable.Mqtt.Topic." + CONTROLLER_MAC], { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC), null);
});

test("a broker option carrying no usable value leaves MQTT off for that controller", () => {

  // The same rule read from the broker side: turning the option off is the user saying this controller has no broker, whatever the legacy property still holds.
  assert.equal(resolve(["Disable.Mqtt.Url." + CONTROLLER_MAC], { mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC), null);

  // Enabling the option without giving it a URL is that same statement made a different way, and it resolves to nothing rather than to the property behind it.
  assert.equal(resolve(["Enable.Mqtt.Url." + CONTROLLER_MAC], { mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC), null);
});

test("a controller no entry speaks for is carried by its legacy configuration", () => {

  /* Wherever the options are silent the configuration properties answer, which is the fallback chain's whole job and is true of every controller rather than of
   * any one kind. A controller named by no scope at all is the sharpest way to read it: nothing can address such a controller, so the properties are all it has.
   */
  assert.deepEqual(resolve([], { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, undefined), { brokerUrl: LEGACY_BROKER, topicPrefix: LEGACY_TOPIC });

  // Another controller's entries must not reach it either, which is what fails a resolution that ignores the scope it was handed.
  assert.deepEqual(resolve([ "Enable.Mqtt.Url." + CONTROLLER_MAC + "." + OPTION_BROKER, "Enable.Mqtt.Topic." + CONTROLLER_MAC + "." + OPTION_TOPIC ],
    { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, undefined), { brokerUrl: LEGACY_BROKER, topicPrefix: LEGACY_TOPIC });
});

test("a controller reached with an API token alone is addressable by its address identity", () => {

  /* Such a controller answers by its configured address with the periods repaired into hyphens, which is a scope identifier like any other - so its own broker and
   * topic are configurable per-controller exactly as a credentialed controller's are, and the entries outrank the legacy properties sitting behind them.
   */
  assert.deepEqual(resolve([ "Enable.Mqtt.Topic.1-2-3-4=" + OPTION_TOPIC, "Enable.Mqtt.Url.1-2-3-4=" + OPTION_BROKER ],
    { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, "1-2-3-4"), { brokerUrl: OPTION_BROKER, topicPrefix: OPTION_TOPIC });
});

test("the catalog declares the wire topics every subscriber already relies on", () => {

  /* The tails are the plugin's external contract: an automation subscribes to the string on the broker, not to the entry key beside it. They are asserted literally
   * here rather than derived from the catalog under test, so adding or respelling a topic is a conscious edit in this file as well as in the declaration.
   */
  assert.deepEqual(Object.fromEntries(Object.entries(mqttTopics).map(([ key, entry ]) => [ key, entry.topic ])), {

    doorbell: "doorbell",
    dps: "dps",
    lock: "lock",
    rel: "rel",
    ren: "ren",
    rex: "rex",
    sidedoorDps: "sidedoor/dps",
    sidedoorLock: "sidedoor/lock",
    sidedoorUnlock: "sidedoor/unlock",
    tamper: "tamper",
    telemetry: "telemetry",
    unlock: "unlock"
  });

  // One composition through the library, so the string a nested tail puts on the wire is stated here rather than only inferred from the tail above.
  assert.equal(mqttTopic("AABBCCDDEEFF", mqttTopics.sidedoorLock.topic), "AABBCCDDEEFF/sidedoor/lock");

  // The device column travels with the entries, which is what lets the renderer print a device cell for every row at the docs build.
  assert.equal(mqttTopics[MQTT_DEVICE_COLUMN].heading, "Access Device Type");
});
