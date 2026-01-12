<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-access: Native HomeKit support for UniFi Access](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-access/main/images/homebridge-unifi-access.svg)](https://github.com/hjdhjd/homebridge-unifi-access)

# Homebridge UniFi Access

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-access?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-access)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-access?color=%230559C9&label=Latest%20Version&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-access)
[![UniFi Access@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Complete HomeKit support for the UniFi Access ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-access` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Access](https://ui.com/door-access) device ecosystem. [UniFi Access](https://ui.com/door-access) is [Ubiquiti's](https://www.ui.com) door access security platform, with doorbell, reader, lock, and controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your door access security.

### MQTT Support

[MQTT](https://mqtt.org) is a popular Internet of Things (IoT) messaging protocol that can be used to weave together different smart devices and orchestrate or instrument them in an infinite number of ways. In short - it lets things that might not normally be able to talk to each other communicate across ecosystems, provided they can support MQTT.

I've provided MQTT support for those that are interested - I'm genuinely curious, if not a bit skeptical, at how many people actually want to use this capability. MQTT has a lot of nerd-credibility, and it was a fun side project to mess around with. :smile:

`homebridge-unifi-access` will publish MQTT events if you've configured a broker in the controller-specific settings. The plugin supports a rich set of capabilities over MQTT. This includes:

  * Doorbell ring events.
  * Lock events, including triggering locks via MQTT.
  * Door position sensor (DPS) events.
  * Terminal input events (REL, REN, REX).
  * Motion detection events, including triggering motion via MQTT.
  * Side door events for UA Gate devices.
  * Raw telemetry publishing.

### How to configure and use this feature

This documentation assumes you know what MQTT is, what an MQTT broker does, and how to configure it. Setting up an MQTT broker is beyond the scope of this documentation. There are plenty of guides available on how to do so just a search away.

You configure MQTT settings within a `controller` configuration block. The settings are:

| Configuration Setting | Description
|-----------------------|----------------------------------
| `mqttUrl`             | The URL of your MQTT broker. **This must be in URL form**, e.g.: `mqtt://user:password@1.2.3.4`.
| `mqttTopic`           | The base topic to publish to. The default is: `unifi/access`.

To reemphasize the above: **mqttUrl** must be a valid URL. Simply entering in a hostname without specifying it in URL form will result in an error. The URL can use any of these protocols: `mqtt`, `mqtts`, `tcp`, `tls`, `ws`, `wss`.

When events are published, by default, the topics look like:

```sh
unifi/access/1234567890AB/lock
unifi/access/ABCDEF123456/doorbell
```

In the above example, `1234567890AB` and `ABCDEF123456` are the MAC addresses of your Access hub or other devices. We use MAC addresses as an easy way to guarantee unique identifiers that won't change. `homebridge-unifi-access` provides you information about your devices and their respective MAC addresses in the homebridge log on startup. Additionally, you can use the UniFi Access app or webUI to lookup what the MAC addresses are of your devices, should you need to do so.

### <A NAME="publish"></A>Topics Published

The topics and messages that `homebridge-unifi-access` publishes are:

#### Door and Lock Topics

| Topic                 | Message Published                | Device Scope
|-----------------------|----------------------------------|----------------------------------
| `doorbell`            | `true` when ringing, `false` when ring ends. | Hubs with doorbells.
| `dps`                 | `true` when open, `false` when closed, `unknown` if not wired. | UA Ultra, UA Hub, UA Hub Door Mini, UA Gate.
| `lock`                | `true` when locked, `false` when unlocked. | All hubs.
| `rel`                 | `true` when open, `false` when closed. | UA Hub (remote release sensor).
| `ren`                 | `true` when open, `false` when closed. | UA Hub (request to enter sensor).
| `rex`                 | `true` when open, `false` when closed. | UA Ultra, UA Hub, UA Hub Door Mini (request to exit sensor).

#### Side Door Topics (UA Gate Only)

| Topic                 | Message Published                | Description
|-----------------------|----------------------------------|----------------------------------
| `sidedoor/dps`        | `true` when open, `false` when closed, `unknown` if not wired. | Side door (pedestrian gate) position sensor.
| `sidedoor/lock`       | `true` when locked, `false` when unlocked. | Side door (pedestrian gate) lock state.

#### Motion and Telemetry Topics

| Topic                 | Message Published                | Description
|-----------------------|----------------------------------|----------------------------------
| `motion`              | `true` when motion detected, `false` when motion ends. | Motion detection events.
| `telemetry`           | JSON payload of raw event data. | Published when `Controller.Publish.Telemetry` is enabled.

Messages are published to MQTT when an action occurs on an Access device that triggers the respective event, or when an MQTT message is received for one of the topics `homebridge-unifi-access` subscribes to.

### <A NAME="subscribe"></A>Topics Subscribed

The topics that `homebridge-unifi-access` subscribes to are:

#### Door and Lock Topics

| Topic                   | Message Expected                 | Description
|-------------------------|----------------------------------|----------------------------------
| `doorbell/get`          | `true` | Triggers a publish of the current doorbell ring status.
| `dps/get`               | `true` | Triggers a publish of the current door position sensor state.
| `lock/get`              | `true` | Triggers a publish of the current lock state.
| `lock/set`              | `true` to unlock momentarily (auto-relocks based on configured delay), `false` to unlock indefinitely. | Controls the door lock relay.

#### Side Door Topics (UA Gate Only)

| Topic                   | Message Expected                 | Description
|-------------------------|----------------------------------|----------------------------------
| `sidedoor/dps/get`      | `true` | Triggers a publish of the current side door position sensor state.
| `sidedoor/lock/get`     | `true` | Triggers a publish of the current side door lock state.
| `sidedoor/lock/set`     | `true` to lock, `false` to unlock. | Controls the side door lock relay.

#### Motion Topics

| Topic                   | Message Expected                 | Description
|-------------------------|----------------------------------|----------------------------------
| `motion/trigger`        | `true` | Triggers a motion event on the device.

### Some Fun Facts
  * MQTT support is disabled by default. It's enabled when an MQTT broker is specified in the configuration.
  * MQTT is configured per-controller. This allows you to have different MQTT brokers for different Access controllers, if needed.
  * If connectivity to the broker is lost, it will perpetually retry to connect in one-minute intervals.
  * If a bad URL is provided, MQTT support will not be enabled.
