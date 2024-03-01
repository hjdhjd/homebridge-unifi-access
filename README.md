<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

# Homebridge UniFi Access
[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-access?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-access)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-access?color=%230559C9&label=Latest%20Version&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)



## Complete HomeKit support for the UniFi Access ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-access` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Access](https://ui.com/us/en/door-access) device ecosystem. [UniFi Access](https://ui.com/us/en/door-access) is [Ubiquiti's](https://www.ui.com) door access platform, with rich access management, doorbell, and controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your door access and doorbells.

## <A NAME="why"></A>Why use this plugin for UniFi Access support in HomeKit?
This plugin attempts to bridge a gap in the UniFi Access ecosystem by providing native HomeKit support on par with what you would expect from a first-party of native HomeKit solution. My north star is to create a plugin that *just works* with minimal required configuration by you to get up and running. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, there are more granular options available to enable you to further tailor your experience.

What does *just works* mean in practice? It means that this plugin will discover all your supported UniFi Door devices and makes one available in HomeKit.

### Features
- ***Easy* configuration - all you need is your UniFi Access controller IP address, API-Token to get started.**

- **Contact sensor control from within HomeKit.** If door supports a door position switch. An additional contact sensor is also provided.

- **Fast** UniFi Access supports websocket therefore all events like door position switch or door bell are provided in realtime.


### What's not in this plugin yet
- Multiple doors
- Door Bell support

## Documentation
* Getting Started
    * [Installation](#installation): installing this plugin, including system requirements.
    * [Plugin Configuration](#plugin-configuration): how to quickly get up and running.  

## Installation
If you are new to Homebridge, please first read the [Homebridge](https://homebridge.io) [documentation](https://github.com/homebridge/homebridge/wiki) and installation instructions before proceeding.

If you have installed the [Homebridge Config UI](https://github.com/homebridge/homebridge-config-ui-x), you can intall this plugin by going to the `Plugins` tab and searching for `homebridge-unifi-access` and installing it.

## Plugin Configuration
If you choose to configure this plugin directly instead of using the [Homebridge Configuration webUI](https://github.com/homebridge/homebridge-config-ui-x), you'll need to add the platform to your `config.json` in your home directory inside `.homebridge`.

```js
"platforms": [
  {
    "platform": "UniFi Acccess",
    "apiToken": "xxxxxxxxxxxxxxxxx",
    "consoleHost": "192.168.2.2",
    "consolePort": "12445",
    "doorId": "d64f1ccf-3392-4ea0-bce4-f9d1147fa09a",
    "doorName": "Haustür",
    "doorOpenerDuration": "5000"
    
  }
]
```
**For most people, I recommend using [Homebridge Configuration web UI](https://github.com/homebridge/homebridge-config-ui-x) to configure this plugin rather than doing so directly. It's easier to use for most users, especially newer users, and less prone to typos, leading to other problems. This plugin has a custom webUI built on top of the Homebridge webUI framework that should simplify feature configuration, and make them more accessible to users.**

## Plugin Development Dashboard
This is mostly of interest to the true developer nerds amongst us.

[![License](https://img.shields.io/npm/l/homebridge-unifi-access?color=%230559C9&logo=open%20source%20initiative&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/LICENSE.md)
[![Build Status](https://img.shields.io/github/actions/workflow/status/hjdhjd/homebridge-unifi-access/ci.yml?branch=main&color=%230559C9&logo=github-actions&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-unifi-protect/actions?query=workflow%3A%22Continuous+Integration%22)
[![Dependencies](https://img.shields.io/librariesio/release/npm/homebridge-unifi-access?color=%230559C9&logo=dependabot&style=for-the-badge)](https://libraries.io/npm/homebridge-unifi-protect)
[![GitHub commits since latest release (by SemVer)](https://img.shields.io/github/commits-since/hjdhjd/homebridge-unifi-access/latest?color=%230559C9&logo=github&sort=semver&style=for-the-badge)](https://github.com/hjdhjd/homebridge-unifi-protect/commits/master)
