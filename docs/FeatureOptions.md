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

 * [Device](#device): Device feature options.
 * [Controller](#controller): Controller feature options.
 * [Hub](#hub): Hub feature options.
 * [AccessMethod](#accessmethod): Access method feature options.
 * [Log](#log): Logging feature options.

#### <A NAME="device"></A>Device feature options.

These option(s) apply to: all Access device types.

| Option                                                                              | Description
|-------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------
| <A NAME="Device"></A>`Device`                                                       | Make this device available in HomeKit. **(default: enabled)**.
| <A NAME="Device.SyncName"></A>`Device.SyncName`                                     | Synchronize the UniFi Access name of this device with HomeKit. Synchronization is one-way only, syncing the device name from UniFi Access to HomeKit. **(default: disabled)**.

#### <A NAME="controller"></A>Controller feature options.

These option(s) apply to: Access controllers.

| Option                                                                              | Description
|-------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------
| <A NAME="Controller.DelayDeviceRemoval"></A><CODE>Controller.DelayDeviceRemoval<I>.Value</I></CODE>  | Delay, in seconds, before removing devices that are no longer detected on the Access controller. By default, devices are added and removed in realtime. **(default: 60)**.
| <A NAME="Controller.Publish.Telemetry"></A>`Controller.Publish.Telemetry`           | Publish all the realtime telemetry received from the Access controller to MQTT. **(default: disabled)**.

#### <A NAME="hub"></A>Hub feature options.

These option(s) apply to: all Access device types.

| Option                                                                              | Description
|-------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------
| <A NAME="Hub.Door.UseLock"></A>`Hub.Door.UseLock`                                   | Use a lock accessory instead of a garage door opener accessory for the gate. **(default: disabled)**. <BR>*Supported on UniFi Access Gate.*
| <A NAME="Hub.Door.UseGarageOpener"></A>`Hub.Door.UseGarageOpener`                   | Use a garage door opener accessory instead of a lock accessory. This is a visual preference only within HomeKit; the underlying lock behavior and feature options remain the same. **(default: disabled)**. <BR>*Supported on UniFi Access Ultra.*
| <A NAME="Hub.LockDelayInterval"></A><CODE>Hub.LockDelayInterval<I>.Value</I></CODE>  | Delay, in minutes, before locking the door lock relay once it's been unlocked by HomeKit. If set to 0, it will remain unlocked indefinitely. This applies regardless of whether you use a lock or garage door opener accessory. By default, the door lock relay will lock five seconds after unlocking. **(default: 0)**.
| <A NAME="Hub.Lock.Trigger"></A>`Hub.Lock.Trigger`                                   | Add a switch accessory to control the door lock relay. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions and trigger events when a lock or unlock event occurs. This works with both lock and garage door opener accessories. **(default: disabled)**.
| <A NAME="Hub.Doorbell"></A>`Hub.Doorbell`                                           | Add a doorbell accessory to handle doorbell ring events in HomeKit. **(default: enabled)**. <BR>*Supported on UniFi Access hubs that have a doorbell.*
| <A NAME="Hub.Doorbell.Trigger"></A>`Hub.Doorbell.Trigger`                           | Add a switch accessory for automation scenarios to reflect (but not trigger) doorbell ring events on an Access doorbell. **(default: disabled)**. <BR>*Supported on UniFi Access hubs that have a doorbell.*
| <A NAME="Hub.DPS"></A>`Hub.DPS`                                                     | Add a contact sensor accessory for the door position sensor. **(default: enabled)**. <BR>*Supported on UniFi Access Ultra.*
| <A NAME="Hub.REL"></A>`Hub.REL`                                                     | Add a contact sensor accessory for the remote release. **(default: enabled)**. <BR>*Supported on UniFi Access Hub.*
| <A NAME="Hub.REN"></A>`Hub.REN`                                                     | Add a contact sensor accessory for the request to enter sensor. **(default: enabled)**. <BR>*Supported on UniFi Access Hub.*
| <A NAME="Hub.REX"></A>`Hub.REX`                                                     | Add a contact sensor accessory for the request to exit sensor. **(default: enabled)**. <BR>*Supported on UniFi Access Ultra.*
| <A NAME="Hub.SideDoor"></A>`Hub.SideDoor`                                           | Add a lock accessory for the side door (pedestrian gate) on UniFi Access Gate Hub devices. **(default: enabled)**. <BR>*Supported on UniFi Access Gate.*
| <A NAME="Hub.SideDoor.DPS"></A>`Hub.SideDoor.DPS`                                   | Add a contact sensor accessory for the side door position sensor. **(default: enabled)**. <BR>*Supported on UniFi Access Gate.*
| <A NAME="Hub.SideDoor.Lock.Trigger"></A>`Hub.SideDoor.Lock.Trigger`                 | Add a switch accessory to control the side door lock. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling locks. **(default: disabled)**. <BR>*Supported on UniFi Access Gate.*

#### <A NAME="accessmethod"></A>Access method feature options.

These option(s) apply to: all Access device types.

| Option                                                                              | Description
|-------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------
| <A NAME="AccessMethod.Face"></A>`AccessMethod.Face`                                 | Add a switch accessory to control the face unlock access method. **(default: enabled)**. <BR>*Supported on UniFi Access readers that support face unlock authentication.*
| <A NAME="AccessMethod.Hand"></A>`AccessMethod.Hand`                                 | Add a switch accessory to control the hand wave unlock access method. **(default: enabled)**. <BR>*Supported on UniFi Access readers that support hand wave authentication.*
| <A NAME="AccessMethod.Mobile"></A>`AccessMethod.Mobile`                             | Add a switch accessory to control the mobile unlock access method. **(default: enabled)**. <BR>*Supported on UniFi Access readers that support mobile authentication.*
| <A NAME="AccessMethod.NFC"></A>`AccessMethod.NFC`                                   | Add a switch accessory to control the NFC card access method. **(default: enabled)**. <BR>*Supported on UniFi Access readers that support NFC authentication.*
| <A NAME="AccessMethod.PIN"></A>`AccessMethod.PIN`                                   | Add a switch accessory to control the PIN unlock access method. **(default: enabled)**. <BR>*Supported on UniFi Access readers that support PIN authentication.*
| <A NAME="AccessMethod.QR"></A>`AccessMethod.QR`                                     | Add a switch accessory to control the QR unlock access method. **(default: enabled)**. <BR>*Supported on UniFi Access readers that support QR code authentication.*
| <A NAME="AccessMethod.TouchPass"></A>`AccessMethod.TouchPass`                       | Add a switch accessory to control the Touch Pass access method. **(default: enabled)**. <BR>*Supported on UniFi Access readers thaat support Touch Pass.*

#### <A NAME="log"></A>Logging feature options.

These option(s) apply to: all Access device types.

| Option                                                                              | Description
|-------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------
| <A NAME="Log.Doorbell"></A>`Log.Doorbell`                                           | Log doorbell ring events in Homebridge. **(default: enabled)**. <BR>*Supported on UniFi Access hubs that have a doorbell.*
| <A NAME="Log.DPS"></A>`Log.DPS`                                                     | Log door position sensor events in Homebridge. **(default: enabled)**. <BR>*Supported on UniFi Access Ultra.*
| <A NAME="Log.REL"></A>`Log.REL`                                                     | Log door remote release events in Homebridge. **(default: enabled)**. <BR>*Supported on UniFi Access Hub.*
| <A NAME="Log.REN"></A>`Log.REN`                                                     | Log door request to enter events in Homebridge. **(default: enabled)**. <BR>*Supported on UniFi Access Hub.*
| <A NAME="Log.REX"></A>`Log.REX`                                                     | Log door request to exit events in Homebridge. **(default: enabled)**. <BR>*Supported on UniFi Access Ultra.*
| <A NAME="Log.Lock"></A>`Log.Lock`                                                   | Log lock events in Homebridge. **(default: enabled)**. <BR>*Supported on UniFi Access hubs.*

