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

### Feature Options

Feature options allow you to enable or disable certain features in this plugin. These feature options provide unique flexibility by also allowing you to set a scope for each option that allows you more granular control in how this plugin makes features and capabilities available in HomeKit.

The priority given to these options works in the following order, from highest to lowest priority where settings that are higher in priority will override the ones below:

  * Device options that are enabled or disabled.
  * Controller options that are enabled or disabled.
  * Global options that are enabled or disabled.

All feature options can be set at any scope level, or at multiple scope levels. If an option isn't applicable to a particular category of device, it is ignored. For example, if you have two doorbells in your environment, and want to enable the same feature options on both, you can enable the doorbell-related feature options globally rather than specifying them for each individual doorbell. If you want to override a global feature option you've set, you can override the global feature option for the individual doorbell in this example.

**Note: it's strongly recommended that you use the Homebridge webUI](https://github.com/homebridge/homebridge-config-ui-x) to configure this plugin - it's easier to use for most people, and will ensure you always have a valid configuration.**

#### Specifying Scope
There are two types of scope specifiers that you can use with feature options - MAC addresses.

Scoping rules:

  * If you don't use a scoping specifier, feature options will be applied globally for all devices.
  * To use a device or controller-specific feature option, append the option with `.MAC`, where `MAC` is the MAC address of either a UniFi Access controller or a hub.

`homebridge-unifi-access` will log all devices it discovers on startup, including MAC addresses, which you can use to tailor the feature options you'd like to enable or disable on a per-device basis.

### Getting Started
Before using these features, you should understand how feature options propagate to controllers and the devices attached to them. If you choose to disable a controller from being available to HomeKit, you will also disable all the devices attached to that controller. If you've disabled a controller, you can selectively enable a single device associated with that controller by explicitly using the `Enable.` Feature Option with that device's MAC address. This provides you a lot of richness in how you enable or disable devices for HomeKit use.

The `options` setting is an array of strings used to customize Feature Options in your `config.json`. I would encourage most users, however, to use the [Homebridge webUI](https://github.com/homebridge/homebridge-config-ui-x), to configure Feature Options as well as other options in this plugin. It contains additional validation checking of parameters to ensure the configuration is always valid.

### <A NAME="reference"></A>Feature Options Reference
Feature options provide a rich mechanism for tailoring your `homebridge-unifi-access` experience. The reference below is divided into functional category groups:

**Note: it's strongly recommended that you use the Homebridge webUI](https://github.com/homebridge/homebridge-config-ui-x) to configure this plugin - it's easier to use for most people, and will ensure you always have a valid configuration.**

 * [Device](#device): Device feature options.
 * [Controller](#controller): Controller feature options.
 * [Hub](#hub): Hub feature options.
 * [Log](#log): Logging feature options.

#### <A NAME="device"></A>Device feature options.

These option(s) apply to: all Access device types.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Device`                                         | Make this device available in HomeKit. **(default: enabled)**.
| `Device.SyncName`                                | Synchronize the UniFi Access name of this device with HomeKit. Synchronization is one-way only, syncing the device name from UniFi Access to HomeKit. **(default: disabled)**.

#### <A NAME="controller"></A>Controller feature options.

These option(s) apply to: Access controllers.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Controller.DelayDeviceRemoval<I>.Value</I>`     | Delay, in seconds, before removing devices that are no longer detected on the Access controller. By default, devices are added and removed in realtime. **(default: 60)**.
| `Controller.Publish.Telemetry`                   | Publish all the realtime telemetry received from the Access controller to MQTT. **(default: disabled)**.

#### <A NAME="hub"></A>Hub feature options.

These option(s) apply to: UniFi Access hub.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Hub.LockDelayInterval<I>.Value</I>`             | Delay, in minutes, before locking the door lock relay, once it's been unlocked by HomeKit. If set to 0, it will remain unlocked indefinitely. By default, the door lock relay will lock five seconds after unlocking. **(default: 0)**.
| `Hub.Doorbell`                                   | Add a doorbell accessory to handle doorbell ring events in HomeKit. **(default: enabled)**. <BR>*Supported on Access hubs that have a doorbell.*
| `Hub.Doorbell.Trigger`                           | Add a switch accessory for automation scenarios to reflect (but not trigger) doorbell ring events on an Access doorbell. **(default: disabled)**. <BR>*Supported on Access hubs that have a doorbell.*

#### <A NAME="log"></A>Logging feature options.

These option(s) apply to: all Access device types.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Log.Doorbell`                                   | Log doorbell ring events in Homebridge. **(default: enabled)**. <BR>*Supported on Access hubs that have a doorbell.*
| `Log.Lock`                                       | Log lock events in Homebridge. **(default: enabled)**. <BR>*Supported on UniFi Access hub.*

