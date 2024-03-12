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

## <A NAME="why"></A>Why Use This Plugin For UniFi Access Support In HomeKit?
This plugin attempts to bridge a gap in the UniFi Access ecosystem by providing native HomeKit support on par with what you would expect from a first-party of native HomeKit solution. My north star is to create a plugin that *just works* with minimal required configuration by you to get up and running. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, there are more granular options available to enable you to further tailor your experience.

What does *just works* mean in practice? It means that this plugin will discover all your supported UniFi Access devices and make them available in HomeKit. It supports all known UniFi Access controller configurations (UniFi CloudKey Gen2+, UniFi Dream Machine Pro/SE, and UniFi NVR, etc).

For the more technically inclined - this plugin has continued to pioneer the HomeKit user experience for UniFi Access by being the ***first*** Homebridge plugin (and first third-party app, to my knowledge) to successfully reverse engineer the UniFi Access native events API that was introduced with UniFi OS. This allows realtime capturing of events as they occur in the Access ecosystem, allowing us to provide that to HomeKit.

### Features
- ***Easy* configuration - all you need is your UniFi Access controller IP address, username, and password to get started.** The defaults work quite well for the vast majority of users. When you want more, there are [additional options](https://github.com/hjdhjd/homebridge-unifi-access/blob/main/docs/FeatureOptions.md) you can play with, if you choose.

- **Full HomeKit support for the UniFi Access ecosystem.** All generally available UniFi Access hub devices are supported. This includes providing lock accessories, doorbell capabilities, and automation accelerators.

- **Support for multiple controllers.** This plugin can support multiple UniFi Access controllers. If you have more than one controller, it's easy to add them to this plugin, and integrate them seamlessly into HomeKit.

- **Automatic *realtime* detection and configuration of all UniFi Access devices.** By default - all of your supported UniFi Access devices are made available in HomeKit without needing any further configuration on your part. Additionally, if you add or remove hubs or other devices to your UniFi Access controller, this plugin will autodetect those configuration changes and add or remove those devices in HomeKit, seamlessly, *in realtime*. No need to restart Homebridge to see your new Access devices added or removed.

- **A builtin webUI using the Homebridge webUI plugin framework allows you the ability to [customize the plugin to your needs](https://github.com/hjdhjd/homebridge-unifi-access/blob/main/docs/FeatureOptions.md).** You can apply options globally, for all devices connected to a specific Access controller, or for individual Access devices in an intuitive way using the Homebridge HBUA webUI.

- **MQTT support.** [MQTT](https://mqtt.org) support is available for those that want to [make UniFi Access accessible to an MQTT broker](https://github.com/hjdhjd/homebridge-unifi-access/blob/main/docs/MQTT.md).

## Documentation
* Getting Started
  * [Installation](#installation): installing this plugin, including system requirements.
  * [Plugin Configuration](#plugin-configuration): how to quickly get up and running.
  * [Feature Options](https://github.com/hjdhjd/homebridge-unifi-access/blob/main/docs/FeatureOptions.md): granular options to allow you to set the camera quality individually, show or hide specific cameras, controllers, and more.
  * [MQTT](https://github.com/hjdhjd/homebridge-unifi-access/blob/main/docs/MQTT.md): how to configure MQTT support.
  * [API Documentation](https://github.com/hjdhjd/unifi-access): documentation of the native Ubiquiti UniFi Access API. The API is a superset of the public API that Ubiquiti has made available.
  * [Changelog](https://github.com/hjdhjd/homebridge-unifi-access/blob/main/docs/Changelog.md): changes and release history of this plugin, starting with v3.0.

## Installation
If you are new to Homebridge, please first read the [Homebridge](https://homebridge.io) [documentation](https://github.com/homebridge/homebridge/wiki) and installation instructions before proceeding.

If you have installed the [Homebridge Config UI](https://github.com/homebridge/homebridge-config-ui-x), you can intall this plugin by going to the `Plugins` tab and searching for `homebridge-unifi-access` and installing it.

### Things To Be Aware Of
- **Make sure you are running on the latest production / stable firmwares for both your controller platform (UCKgen2+, UDM-Pro, UNVR, etc.) as well as the latest production / stable UniFi Access controller firmware.**
- **No beta versions of iOS, iPadOS, macOS, tvOS, or watchOS are supported. You are on your own if you choose to install / run beta firmwares - don't expect support or sympathy if you run into issues.**
- **No beta or early access versions of device controller firmware (UCKgen2+, UDM-Pro, UNVR, etc.) are supported by this plugin. You are on your own if you choose to install / run beta firmwares - don't expect support or sympathy if you run into issues.**
- **No beta or early access versions of UniFi Access firmware are supported by this plugin. You are on your own if you choose to install / run beta firmwares - don't expect support or sympathy if you run into issues.**
- **No beta or early access versions of UniFi Access hardware are supported by this plugin. You are on your own if you choose to use non-production/GA hardware - don't expect support or sympathy if you run into issues.**
- **My philosophy is to aggressively adopt the capability and features (that make sense in a HomeKit context) in the latest production / stable Ubiquiti firmware releases and to deprecate old functionality that's been superceded by newer, richer, or more performant capabilities - either by HomeKit or Ubiquiti. Read the [Changelog](https://github.com/hjdhjd/homebridge-unifi-access/blob/main/docs/Changelog.md) carefully for the latest information on what's new.**
- ***For extra clarity and to reiterate the above - before you install this plugin, make sure you are on the latest production / stable controller platform firmware and the latest production / stable UniFi Access firmware.***

## Plugin Configuration
If you choose to configure this plugin directly instead of using the [Homebridge Configuration webUI](https://github.com/homebridge/homebridge-config-ui-x), you'll need to add the platform to your `config.json` in your home directory inside `.homebridge`.

```js
"platforms": [
  {
    "platform": "UniFi Access",

    "controllers": [
      {
        "address": "1.2.3.4",
        "username": "some-unifi-access-user (or create a new one just for homebridge)",
        "password": "some-password"
      }
    ]
  }
]
```
**For most people, I recommend using [Homebridge Configuration web UI](https://github.com/homebridge/homebridge-config-ui-x) to configure this plugin rather than doing so directly. It's easier to use for most users, especially newer users, and less prone to typos, leading to other problems. This plugin has a custom webUI built on top of the Homebridge webUI framework that should simplify feature configuration, and make them more accessible to users.**

You can use your Ubiquiti account credentials, though 2FA is not currently supported. That said, **I strongly recommend creating a local user just for Homebridge instead of using this option.**

## Plugin Development Dashboard
This is mostly of interest to the true developer nerds amongst us.

[![License](https://img.shields.io/npm/l/homebridge-unifi-access?color=%230559C9&logo=open%20source%20initiative&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-unifi-access/blob/main/LICENSE.md)
[![Build Status](https://img.shields.io/github/actions/workflow/status/hjdhjd/homebridge-unifi-access/ci.yml?branch=main&color=%230559C9&logo=github-actions&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-unifi-access/actions?query=workflow%3A%22Continuous+Integration%22)
[![Dependencies](https://img.shields.io/librariesio/release/npm/homebridge-unifi-access?color=%230559C9&logo=dependabot&style=for-the-badge)](https://libraries.io/npm/homebridge-unifi-access)
[![GitHub commits since latest release (by SemVer)](https://img.shields.io/github/commits-since/hjdhjd/homebridge-unifi-access/latest?color=%230559C9&logo=github&sort=semver&style=for-the-badge)](https://github.com/hjdhjd/homebridge-unifi-access/commits/master)
