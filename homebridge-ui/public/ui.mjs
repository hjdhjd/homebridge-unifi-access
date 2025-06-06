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

// Return the list of devices associated with a given Access controller.
const getDevices = async (controller) => {

  // If we're in the global context, we have no devices.
  if(!controller) {

    return [];
  }

  // Retrieve the current list of devices from the Access controller.
  let devices = await homebridge.request("/getDevices", { address: controller.address, password: controller.password, username: controller.username });

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

  // Add the fields that the webUI framework is looking for to render.
  devices = devices.map(device => ({

    ...device,
    serialNumber: device.mac.replace(/:/g, "").toUpperCase() + ((device.device_type === "UAH-Ent") ? "-" + device.source_id.toUpperCase() : "")
  }));

  return devices;
};

// Return whether a given device is a controller.
const isController = (device) => device.display_model === "controller";

// Show the list of Access devices associated with a controller, grouped by model.
const showSidebarDevices = (controller, devices) => {

  // Workaround for the time being to reduce the number of models we see to just the currently supported ones.
  const modelKeys = [...new Set(devices.filter(device => ["controller"].includes(device.display_model) || device.capabilities.includes("is_hub"))
    .map(device => (device.device_type === "UAH-Ent") ? device.model : device.display_model))];

  // Start with a clean slate.
  ui.featureOptions.devicesTable.innerHTML = "";

  for(const key of modelKeys) {

    // Get all the devices associated with this device category.
    const modelDevices = devices.filter(x => ((x.device_type === "UAH-Ent") ? x.model : x.display_model) === key);

    // Nothing in this category, let's keep going.
    if(!modelDevices.length) {

      continue;
    }

    // If it's a controller, we handle that case differently.
    if(key === "controller") {

      // Change the name of the controller that we show users once we've connected with the controller.
      ui.featureOptions.webUiControllerList.map(x => (x.name === controller.address) ? x.childNodes[0].nodeValue = modelDevices[0].host.hostname : true);

      continue;
    }

    // Create a row for this device category.
    const trCategory = document.createElement("tr");

    // Disable any pointer events and hover activity.
    trCategory.style.pointerEvents = "none";

    // Create the cell for our device category row.
    const tdCategory = document.createElement("td");

    tdCategory.classList.add("m-0", "p-0", "pl-1", "w-100");

    // Add the category name, with appropriate casing.
    tdCategory.appendChild(document.createTextNode((key.charAt(0).toUpperCase() + key.slice(1) + "s")));
    tdCategory.style.fontWeight = "bold";

    // Add the cell to the table row.
    trCategory.appendChild(tdCategory);

    // Add the table row to the table.
    ui.featureOptions.devicesTable.appendChild(trCategory);

    for(const device of modelDevices) {

      // Create a row for this device.
      const trDevice = document.createElement("tr");

      trDevice.classList.add("m-0", "p-0");

      // Create a cell for our device.
      const tdDevice = document.createElement("td");

      tdDevice.classList.add("m-0", "p-0" , "w-100");

      const label = document.createElement("label");

      label.name = device.serialNumber;
      label.appendChild(document.createTextNode(device.alias ?? device.display_model));
      label.style.cursor = "pointer";
      label.classList.add("mx-2", "my-0", "p-0", "w-100");

      label.addEventListener("click", () => ui.featureOptions.showDeviceOptions(device.serialNumber));

      // Add the device label to our cell.
      tdDevice.appendChild(label);

      // Add the cell to the table row.
      trDevice.appendChild(tdDevice);

      // Add the table row to the table.
      ui.featureOptions.devicesTable.appendChild(trDevice);

      ui.featureOptions.webUiDeviceList.push(label);
    }
  }
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

  if(device && (device.display_model !== "controller") && !category.modelKey.some(model => ["all", device.display_model].includes(model))) {

    return false;
  }

  return true;
};

// Show the details for this device.
const showAccessDetails = (device) => {

  // No device specified, we must be in a global context.
  if(!device) {

    document.getElementById("device_model").classList.remove("text-center");
    document.getElementById("device_model").colSpan = 1;
    document.getElementById("device_model").style.fontWeight = "normal";
    document.getElementById("device_model").innerHTML = "N/A";
    document.getElementById("device_mac").innerHTML = "N/A";
    document.getElementById("device_address").innerHTML = "N/A";
    document.getElementById("device_online").innerHTML = "N/A";

    return;
  }

  // Populate the device details.
  document.getElementById("device_model").classList.remove("text-center");
  document.getElementById("device_model").colSpan = 1;
  document.getElementById("device_model").style.fontWeight = "normal";
  document.getElementById("device_model").innerHTML = device.model ?? device.display_model;
  document.getElementById("device_mac").innerHTML = device.mac.replace(/:/g, "").toUpperCase();
  document.getElementById("device_address").innerHTML = device.ip;
  document.getElementById("device_online").innerHTML = device.is_online ? "Connected" : "Disconnected";
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  getDevices: getDevices,
  hasControllers: true,
  infoPanel: showAccessDetails,
  sidebar: {

    controllerLabel: "Access Controllers",
    deviceLabel: "Access Devices",
    showDevices: showSidebarDevices
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
