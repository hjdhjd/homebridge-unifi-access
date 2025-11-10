/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge UniFi Access webUI.
 */
"use strict";

import { webUi } from "./lib/webUi.mjs";

// Execute our first run screen if we don't have valid Access login credentials and a controller.
const firstRunIsRequired = () => {

  if(ui.featureOptions.currentConfig.length && ui.featureOptions.currentConfig[0].controllers?.length &&
    ui.featureOptions.currentConfig[0].controllers[0]?.address?.length && ui.featureOptions.currentConfig[0].controllers[0]?.username?.length &&
    ui.featureOptions.currentConfig[0].controllers[0]?.password?.length) {

    return false;
  }

  return true;
};

// Initialize our first run screen with any information from our existing configuration.
const firstRunOnStart = () => {

  // Pre-populate with anything we might already have in our configuration.
  document.getElementById("address").value = ui.featureOptions.currentConfig[0].controllers?.[0]?.address ?? "";
  document.getElementById("username").value = ui.featureOptions.currentConfig[0].controllers?.[0]?.username ?? "";
  document.getElementById("password").value = ui.featureOptions.currentConfig[0].controllers?.[0]?.password ?? "";

  return true;
};

// Validate our Access credentials.
const firstRunOnSubmit = async () => {

  const address = document.getElementById("address").value;
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const tdLoginError = document.getElementById("loginError");

  tdLoginError.innerHTML = "&nbsp;";

  if(!address?.length || !username?.length || !password?.length) {

    tdLoginError.innerHTML = "<code class=\"text-danger\">Please enter a valid UniFi Access controller address, username and password.</code>";
    homebridge.hideSpinner();

    return false;
  }

  const udaDevices = await homebridge.request("/getDevices", { address: address, password: password, username: username });

  // Couldn't connect to the Access controller for some reason.
  if(!udaDevices?.length) {

    tdLoginError.innerHTML = "Unable to login to the UniFi Access controller.<br>" +
      "Please check your controller address, username, and password.<br><code class=\"text-danger\">" + (await homebridge.request("/getErrorMessage")) + "</code>";
    homebridge.hideSpinner();

    return false;
  }

  // Save the login credentials to our configuration.
  if(!ui.featureOptions.currentConfig[0].controllers?.length) {

    ui.featureOptions.currentConfig[0].controllers = [{}];
  }

  ui.featureOptions.currentConfig[0].controllers[0].address = address;
  ui.featureOptions.currentConfig[0].controllers[0].username = username;
  ui.featureOptions.currentConfig[0].controllers[0].password = password;

  await homebridge.updatePluginConfig(ui.featureOptions.currentConfig);

  return true;
};

// Return whether a given device is a controller.
const isController = (device) => device.display_model === "controller";

// Return the list of controllers from our plugin configuration.
const getControllers = () => {

  const controllers = [];

  // Grab the controllers from our configuration.
  for(const controller of ui.featureOptions.currentConfig[0].controllers ?? []) {

    controllers.push({ name: controller.address, serialNumber: controller.address });
  }

  return controllers;
};

// Return the list of devices associated with a given Access controller.
const getDevices = async (selectedController) => {

  // If we're in the global context, we have no devices.
  if(!selectedController) {

    return [];
  }

  // Find the entry in our plugin configuration.
  const controller = (ui.featureOptions.currentConfig[0].controllers ?? []).find(c => c.address === selectedController.serialNumber);

  if(!controller) {

    return [];
  }

  // Retrieve the current list of devices from the Protect controller.
  const devices = await homebridge.request("/getDevices", { address: controller.address, password: controller.password, username: controller.username });

  // Since the controller JSON doesn't have the same properties as the device JSON, let's make the controller JSON emulate the properties we care about.
  if(devices?.length) {

    /* eslint-disable camelcase */
    devices[0].display_model = "controller";
    devices[0].ip = devices[0].host.ip;
    devices[0].is_online = true;
    devices[0].mac = devices[0].host.mac;
    devices[0].model = devices[0].host.device_type;
    devices[0].unique_id = devices[0].host.mac;
    /* eslint-enable camelcase */
  }

  // Workaround for the time being to reduce the number of models we see to just the currently supported ones.
  const modelKeys = [...new Set(
    devices.filter(device => ["controller"].includes(device.display_model) || device.capabilities.includes("is_hub") || device.capabilities.includes("is_reader"))
      .map(device => (device.device_type === "UAH-Ent") ? device.model : device.display_model))];

  // Add the fields that the webUI framework is looking for to render.
  for(const device of devices) {

    device.name ??= device.alias ?? device.display_model;
    device.serialNumber = device.mac.replace(/:/g, "").toUpperCase() + ((device.device_type === "UAH-Ent") ? "-" + device.source_id.toUpperCase() : "");

    const model = (device.device_type === "UAH-Ent") ? device.model : device.display_model;

    if(!modelKeys.includes(model)) {

      device.sidebarGroup = "hidden";
    }

    device.sidebarGroup ??= device.capabilities.includes("is_hub") ? "Hubs" : "Readers";

    // We update the name of the controller that we show users once we've connected with the controller and have it's name.
    if(isController(device)) {

      device.sidebarGroup = "controllers";

      const activeController = [...document.querySelectorAll("[data-navigation='controller']")].find(c => c.getAttribute("data-device-serial") === controller.address);

      if(activeController) {

        activeController.textContent = device.host.hostname;
      }
    }
  }

  return devices;
};

// Only show feature options that are valid for the capabilities of this device.
const validOption = (device, option) => {

  if(device && (device.display_model !== "controller") && (
    (option.hasCapability && (!device.capabilities || !option.hasCapability.some(x => device.capabilities.includes(x)))) ||
    (option.hasProperty && !option.hasProperty.some(x => x in device)) ||
    (option.modelKey && (option.modelKey !== "all") && !option.modelKey.includes(device.display_model)))) {

    return false;
  }

  return true;
};

// Only show feature option categories that are valid for a particular device type.
const validOptionCategory = (device, category) => {

  if(device && (device.display_model !== "controller") && (
    !category.modelKey.some(model => [ "all", device.display_model ].includes(model)) ||
    (category.hasCapability && (!device.capabilities || !category.hasCapability.some(x => device.capabilities.includes(x)))))) {

    return false;
  }

  return true;
};

// Show the details for this device.
const showAccessDetails = (device) => {

  const deviceStatsContainer = document.getElementById("deviceStatsContainer");

  // No device specified, we must be in a global context.
  if(!device) {

    deviceStatsContainer.innerHTML = "";

    return;
  }

  // Populate the device details using the new CSS Grid layout. This provides a more flexible and responsive display than the previous table layout.
  deviceStatsContainer.innerHTML =
    "<div class=\"device-stats-grid\">" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">Model</span>" +
        "<span class=\"stat-value\">" + (device.model ?? device.display_model) + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">MAC Address</span>" +
        "<span class=\"stat-value font-monospace\">" + device.serialNumber + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">IP Address</span>" +
        "<span class=\"stat-value font-monospace\">" + device.ip + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">Status</span>" +
        "<span class=\"stat-value\">" + (device.is_online ? "Connected" : "Disconnected") + "</span>" +
      "</div>" +
    "</div>";
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  getControllers: getControllers,
  getDevices: getDevices,
  infoPanel: showAccessDetails,
  sidebar: {

    controllerLabel: "Access Controllers"
  },
  ui: {

    isController: isController,
    validOption: validOption,
    validOptionCategory: validOptionCategory
  }
};

// Parameters for our plugin webUI.
const webUiParams = {

  featureOptions: featureOptionsParams,
  firstRun: {

    isRequired: firstRunIsRequired,
    onStart: firstRunOnStart,
    onSubmit: firstRunOnSubmit
  },
  name: "UniFi Access"
};

// Instantiate the webUI.
const ui = new webUi(webUiParams);

// Display the webUI.
ui.show();
