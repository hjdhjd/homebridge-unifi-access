/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-controller.ts: Access controller device class for UniFi Access.
 */
import { ACCESS_CONTROLLER_REFRESH_INTERVAL, ACCESS_CONTROLLER_RETRY_INTERVAL, PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import type { API, HAP, PlatformAccessory } from "homebridge";
import { AccessApi, type AccessControllerConfig, type AccessDeviceConfig } from "unifi-access";
import { type HomebridgePluginLogging, MqttClient, type Nullable, retry, sanitizeName, sleep } from "homebridge-plugin-utils";
import type { AccessControllerOptions } from "./access-options.js";
import type { AccessDevice } from "./access-device.js";
import { AccessEvents } from "./access-events.js";
import { AccessHub } from "./access-hub.js";
import type { AccessPlatform } from "./access-platform.js";
import util from "node:util";

export class AccessController {

  private api: API;
  public config: AccessControllerOptions;
  private deviceRemovalQueue: { [index: string]: number };
  public readonly configuredDevices: { [index: string]: AccessDevice | undefined };
  public events!: AccessEvents;
  private hap: HAP;
  public logApiErrors: boolean;
  public readonly log: HomebridgePluginLogging;
  public mqtt: MqttClient | null;
  private name: string;
  public platform: AccessPlatform;
  public uda: AccessControllerConfig;
  public udaApi!: AccessApi;
  private unsupportedDevices: { [index: string]: boolean };

  constructor(platform: AccessPlatform, accessOptions: AccessControllerOptions) {

    this.api = platform.api;
    this.config = accessOptions;
    this.configuredDevices = {};
    this.deviceRemovalQueue = {};
    this.hap = this.api.hap;
    this.logApiErrors = true;
    this.mqtt = null;
    this.name = accessOptions.name ?? accessOptions.address;
    this.platform = platform;
    this.uda = {} as AccessControllerConfig;
    this.unsupportedDevices = {};

    // Configure our logging.
    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => this.platform.debug(util.format(this.name + ": " + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => this.platform.log.error(util.format(this.name + ": " + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => this.platform.log.info(util.format(this.name + ": " + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => this.platform.log.warn(util.format(this.name + ": " + message, ...parameters))
    };

    // Validate our controller address and login information.
    if(!accessOptions.address || !accessOptions.username || !accessOptions.password) {

      return;
    }
  }

  // Retrieve the bootstrap configuration from the Access controller.
  private async bootstrapController(): Promise<void> {

    // Attempt to bootstrap the controller until we're successful.
    await retry(async () => this.udaApi.getBootstrap(), ACCESS_CONTROLLER_RETRY_INTERVAL * 1000);
  }

  // Initialize our connection to the UniFi Access controller.
  public async login(): Promise<void> {

    // The plugin has been disabled globally. Let the user know that we're done here.
    if(!this.hasFeature("Device")) {

      this.log.info("Disabling this UniFi Access controller.");

      return;
    }

    // Initialize our connection to the UniFi Access API.
    const udaLog = {

      debug: (message: string, ...parameters: unknown[]): void => this.platform.debug(util.format(message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => {

        if(this.logApiErrors) {

          this.platform.log.error(util.format(message, ...parameters));
        }
      },
      info: (message: string, ...parameters: unknown[]): void => this.platform.log.info(util.format(message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => this.platform.log.warn(util.format(message, ...parameters))
    };

    // Create our connection to the Access API.
    this.udaApi = new AccessApi(udaLog);

    // Attempt to login to the Access controller, retrying at reasonable intervals. This accounts for cases where the Access controller or the network connection
    // may not be fully available when we startup.
    await retry(async () => this.udaApi.login(this.config.address, this.config.username, this.config.password), ACCESS_CONTROLLER_RETRY_INTERVAL * 1000);

    // Now, let's get the bootstrap configuration from the Access controller.
    await this.bootstrapController();

    // Set our Access configuration from the controller.
    this.uda = this.udaApi.controller as AccessControllerConfig;

    // Assign our name if the user hasn't explicitly specified a preference.
    this.name = this.config.name ?? this.udaApi.name;

    // We successfully logged in.
    this.log.info("Connected to %s (UniFi Access %s running on UniFi OS %s).", this.config.address, this.uda.version, this.uda.host.firmware_version);

    // Now that we know the Access controller configuration, check to see if we've disabled it.
    if(!this.hasFeature("Device")) {

      this.udaApi.logout();
      this.log.info("Disabling this UniFi Access controller in HomeKit.");

      // Let's sleep for thirty seconds to give all the accessories a chance to load before disabling everything. Homebridge doesn't have a good mechanism to notify us
      // when all the cached accessories are loaded at startup.
      await sleep(30);

      // Unregister all the accessories for this controller from Homebridge that may have been restored already. Any additional ones will be automatically caught when
      // they are restored.
      this.platform.accessories.filter(accessory => accessory.context.controller === this.uda.host.mac).map(accessory => this.removeHomeKitDevice(accessory, true));

      return;
    }

    // Initialize our UniFi Access events handler.
    this.events = new AccessEvents(this);

    // Configure any controller-specific settings.
    this.configureController();

    // Initialize MQTT, if needed.
    if(!this.mqtt && this.config.mqttUrl) {

      this.mqtt = new MqttClient(this.config.mqttUrl, this.config.mqttTopic, this.log);
    }

    // Inform the user about the devices we see.
    if(this.udaApi.devices) {

      for(const device of this.udaApi.devices) {

        // Filter out any devices that aren't managed by this Access controller.
        if(!device.is_managed) {

          continue;
        }

        this.log.info("Discovered %s: %s.", this.resolveDeviceModel(device), this.udaApi.getDeviceName(device, this.resolveDeviceName(device), true));
      }
    }

    // Bootstrap refresh loop.
    const bootstrapRefresh = (): void => {

      // Sleep until it's time to bootstrap again.
      setTimeout(() => void this.bootstrapController(), ACCESS_CONTROLLER_REFRESH_INTERVAL * 1000);
    };

    // Sync the Access controller's devices with HomeKit.
    const syncUdaHomeKit = (): void => {

      // Sync status and check for any new or removed accessories.
      this.discoverAndSyncAccessories();

      // Refresh the accessory cache.
      this.api.updatePlatformAccessories(this.platform.accessories);
    };

    // Initialize our Access controller device sync.
    syncUdaHomeKit();

    // Let's set a listener to wait for bootstrap events to occur so we can keep ourselves in sync with the Access controller.
    this.udaApi.on("bootstrap", () => {

      // Sync our device view.
      syncUdaHomeKit();

      // Refresh our bootstrap.
      bootstrapRefresh();
    });

    // Kickoff our first round of bootstrap refreshes to ensure we stay in sync.
    bootstrapRefresh();
  }

  // Configure controller-specific settings.
  private configureController(): boolean {

    return true;
  }

  // Create instances of Access device types in our plugin.
  private addAccessDevice(accessory: PlatformAccessory, device: AccessDeviceConfig): boolean {

    // Access hubs.
    if([ "is_hub", "is_reader" ].some(capability => device.capabilities.includes(capability))) {

      // We have a UniFi Access hub or reader.
      this.configuredDevices[accessory.UUID] = new AccessHub(this, device, accessory);

      return true;
    }

    // Default to an unknown device type.
    this.log.error("Unknown device class %s detected for %s.", device.device_type, this.resolveDeviceName(device));

    return false;
  }

  // Discover UniFi Access devices that may have been added to the controller since we last checked.
  private discoverDevices(devices: AccessDeviceConfig[]): boolean {

    // Iterate through the list of devices that Access has returned and sync them with what we show HomeKit.
    for(const device of devices) {

      this.addHomeKitDevice(device);
    }

    return true;
  }

  // Add a newly detected Access device to HomeKit.
  public addHomeKitDevice(device: AccessDeviceConfig): boolean {

    // If we have no MAC address, name, or this device isn't being managed by this Access controller, we're done.
    if(!this.uda.host.mac || !device.mac || !device.is_managed) {

      return false;
    }

    // We only support certain device capabilities.
    if(![ "is_hub", "is_reader" ].some(capability => device.capabilities.includes(capability))) {

      // If we've already informed the user about this one, we're done.
      if(this.unsupportedDevices[device.mac]) {

        return false;
      }

      // Notify the user we see this device, but we aren't adding it to HomeKit.
      this.unsupportedDevices[device.mac] = true;

      this.log.info("UniFi Access device type '%s' is not currently supported, ignoring: %s.", device.device_type, this.udaApi.getDeviceName(device));

      return false;
    }

    // Generate this device's unique identifier. For devices like the EAH, we can't rely on just the MAC address since they contain multiple doors.
    const uuid = this.hap.uuid.generate(device.mac + ((device.device_type === "UAH-Ent") ? "-" + device.source_id.toUpperCase() : ""));

    // See if we already know about this accessory.
    let accessory = this.platform.accessories.find(x => x.UUID === uuid);

    // Enable or disable certain devices based on configuration parameters.
    if(!this.hasFeature("Device", device)) {

      if(accessory) {

        this.removeHomeKitDevice(accessory, true);
      }

      return false;
    }

    // We've got a new device, let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory(sanitizeName(this.resolveDeviceName(device)), uuid);

      this.log.info("%s: Adding %s to HomeKit.", this.udaApi.getFullName(device), device.display_model);

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.platform.accessories.push(accessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
    }

    // Setup the accessory as a new Access device in HBUA if we haven't configured it yet.
    if(!this.configuredDevices[accessory.UUID]) {

      this.addAccessDevice(accessory, device);

      return true;
    }

    // Update the configuration on an existing Access device.
    // eslint-disable-next-line camelcase
    this.events.emit("access.data.device.update", { data: device, event: "access.data.device.update", event_object_id: device.unique_id });

    return true;
  }

  // Discover and sync UniFi Access devices between HomeKit and the Access controller.
  private discoverAndSyncAccessories(): boolean {

    if(!this.udaApi.bootstrap) {

      return false;
    }

    if(this.udaApi.devices && !this.discoverDevices(this.udaApi.devices)) {

      this.log.error("Error discovering devices.");
    }

    // Remove Access devices that are no longer found on this Access controller, but we still have in HomeKit.
    this.cleanupDevices();

    // Update our device information.
    Object.keys(this.configuredDevices).map(x => this.configuredDevices[x]?.configureInfo());

    return true;
  }

  // Cleanup removed Access devices from HomeKit.
  private cleanupDevices(): void {

    // Process the device removal queue before we do anything else.
    this.platform.accessories.filter(accessory => Object.keys(this.deviceRemovalQueue).includes(accessory.UUID)).map(accessory =>
      // eslint-disable-next-line @stylistic/implicit-arrow-linebreak
      this.removeHomeKitDevice(accessory, !this.platform.featureOptions.test("Device",
        (accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.SerialNumber).value ?? "") as string, this.id)));

    for(const accessory of this.platform.accessories) {

      const accessDevice = this.configuredDevices[accessory.UUID];

      // Check to see if we have an orphan - where we haven't configured this in the plugin, but the accessory still exists in HomeKit. One example of when this might
      // happen is when Homebridge might be shutdown and a device is then removed. When we start back up, the device still exists in HomeKit but not in Access. We
      // catch those orphan devices here.
      if(!accessDevice) {

        this.removeHomeKitDevice(accessory, !this.platform.featureOptions.test("Device",
          (accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.SerialNumber).value ?? "") as string));

        continue;
      }

      // If we don't have the Access bootstrap JSON available, we're done. We need to know what's on the Access controller in order to determine what to do with
      // the accessories we know about.
      if(!this.udaApi.bootstrap) {

        continue;
      }

      // Check to see if the device still exists on the Access controller and the user has not chosen to hide it.
      if([ "is_hub", "is_reader" ].some(capability => accessDevice.uda.capabilities.includes(capability)) &&
        this.udaApi.devices?.some((x: AccessDeviceConfig) => x.mac.toLowerCase() === accessDevice.uda.mac.toLowerCase())) {

        // In case we have previously queued a device for deletion, let's remove it from the queue since it's reappeared.
        delete this.deviceRemovalQueue[accessDevice.accessory.UUID];

        continue;
      }

      // Process the device removal.
      this.removeHomeKitDevice(accessory, !this.hasFeature("Device", accessDevice.uda));
    }
  }

  // Utility to retrieve a reasonable device name for an Access device.
  private resolveDeviceName(device: AccessDeviceConfig): string {

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return (device.alias?.length ? device.alias : device.name) ?? device.display_model ?? device.model ?? device.device_type ?? "Access Device";
  }

  // Utility to retrieve a reasonable device model for an Access device.
  private resolveDeviceModel(device: AccessDeviceConfig): string {

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return device.display_model ?? device.model ?? device.device_type ?? "Unknown Model";
  }

  // Remove an individual Access device from HomeKit.
  public removeHomeKitDevice(accessory: PlatformAccessory, noRemovalDelay = false): void {

    // Ensure that this accessory hasn't already been removed.
    if(!this.platform.accessories.some(x => x.UUID === accessory.UUID)) {

      return;
    }

    // We only remove devices if they're on the Access controller we're interested in.
    if(accessory.context.controller !== this.uda.host.mac) {

      return;
    }

    const delayInterval = this.getFeatureNumber("Controller.DelayDeviceRemoval") ?? 0;

    // For certain use cases, we may want to defer removal of an Access device where Access may lose track of devices for a brief period of time. This prevents a
    // potential back-and-forth where devices are removed momentarily only to be readded later.
    if(!noRemovalDelay && delayInterval) {

      // Have we seen this device queued for removal previously? If not, let's add it to the queue and come back after our specified delay.
      if(!this.deviceRemovalQueue[accessory.UUID]) {

        this.deviceRemovalQueue[accessory.UUID] = Date.now();

        this.log.info("%s: Delaying device removal for at least %s second%s.", accessory.displayName, delayInterval, delayInterval > 1 ? "s" : "");

        return;
      }

      // Is it time to process this device removal?
      if((delayInterval * 1000) > (Date.now() - this.deviceRemovalQueue[accessory.UUID])) {

        return;
      }
    }

    // Cleanup after ourselves.
    delete this.deviceRemovalQueue[accessory.UUID];

    // Grab our instance of the Access device, if it exists.
    const accessDevice = this.configuredDevices[accessory.UUID];

    // See if we can pull the device's configuration details from our Access device instance or the controller.
    const device = accessDevice?.uda ?? this.udaApi.devices?.find(dev => dev.unique_id === accessory.context.mac.toLowerCase()) ?? null;

    this.log.info("%s: Removing %s from HomeKit.", device ? this.udaApi.getDeviceName(device) : accessDevice?.accessoryName ?? accessory.displayName,
      device?.display_model ?? "device");

    // Cleanup our device instance.
    accessDevice?.cleanup();

    // Finally, remove it from our list of configured devices and HomeKit.
    delete this.configuredDevices[accessory.UUID];

    // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.platform.accessories.splice(this.platform.accessories.indexOf(accessory), 1);

    // Tell Homebridge to save the updated list of accessories.
    this.api.updatePlatformAccessories(this.platform.accessories);
  }

  // Reauthenticate with the controller.
  public async resetControllerConnection(): Promise<void> {

    // Clear our login credentials and statistics.
    this.udaApi.reset();

    // Bootstrap the Access controller.
    await this.bootstrapController();
  }

  // Lookup a device by it's identifier and return it if it exists.
  public deviceLookup(deviceId: string): AccessDevice | null {

    // Find the device.
    const foundDevice = Object.keys(this.configuredDevices).find(x => this.configuredDevices[x]?.uda.unique_id === deviceId);

    return foundDevice ? this.configuredDevices[foundDevice] as AccessDevice : null;
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getFloat(option, this.id);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.id);
  }

  // Utility for checking feature options on the controller.
  public hasFeature(option: string, device?: AccessControllerConfig | AccessDeviceConfig): boolean {

    return this.platform.featureOptions.test(option, ((device as AccessDeviceConfig | undefined)?.unique_id ?? this.id), this.id);
  }

  // Return a unique identifier for an Access controller.
  public get id(): string | undefined {

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return this.uda.host?.mac?.replace(/:/g, "");
  }
}
