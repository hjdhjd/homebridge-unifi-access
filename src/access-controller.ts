/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-controller.ts: Access controller device class for UniFi Access.
 */
import { ACCESS_CONTROLLER_REFRESH_INTERVAL, ACCESS_CONTROLLER_RETRY_INTERVAL, PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { API, HAP, PlatformAccessory } from "homebridge";
import { AccessApi, AccessControllerConfig, AccessDeviceConfig } from "unifi-access";
import { AccessControllerOptions, getOptionFloat, getOptionNumber, getOptionValue, isOptionEnabled } from "./access-options.js";
import { AccessDevice } from "./access-device.js";
import { AccessEvents } from "./access-events.js";
import { AccessHub } from "./access-hub.js";
import { AccessLogging } from "./access-types.js";
import { AccessMqtt } from "./access-mqtt.js";
import { AccessPlatform } from "./access-platform.js";
import util from "node:util";

export class AccessController {

  private api: API;
  public config: AccessControllerOptions;
  private deviceRemovalQueue: { [index: string]: number };
  public readonly configuredDevices: { [index: string]: AccessDevice };
  public events!: AccessEvents;
  private isEnabled: boolean;
  private hap: HAP;
  public logApiErrors: boolean;
  public readonly log: AccessLogging;
  public mqtt: AccessMqtt | null;
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
    this.isEnabled = false;
    this.hap = this.api.hap;
    this.logApiErrors = true;
    this.mqtt = null;
    this.name = accessOptions.name ?? accessOptions.address;
    this.platform = platform;
    this.uda = {} as AccessControllerConfig;
    this.unsupportedDevices = {};

    // Configure our logging.
    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => this.platform.debug(util.format((this.udaApi?.name ?? this.name) + ": " + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => this.platform.log.error(util.format((this.udaApi?.name ?? this.name) + ": " + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => this.platform.log.info(util.format((this.udaApi?.name ?? this.name) + ": " + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => this.platform.log.warn(util.format((this.udaApi?.name ?? this.name) + ": " + message, ...parameters))
    };

    // Validate our controller address and login information.
    if(!accessOptions.address || !accessOptions.username || !accessOptions.password) {

      return;
    }
  }

  // Retrieve the bootstrap configuration from the Access controller.
  private async bootstrapController(): Promise<void> {

    // Attempt to bootstrap the controller until we're successful.
    await this.retry(() => this.udaApi.getBootstrap(), ACCESS_CONTROLLER_RETRY_INTERVAL * 1000);
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
    await this.retry(() => this.udaApi.login(this.config.address, this.config.username, this.config.password), ACCESS_CONTROLLER_RETRY_INTERVAL * 1000);

    // Now, let's get the bootstrap configuration from the Access controller.
    await this.bootstrapController();

    // Set our Access configuration from the controller.
    this.uda = this.udaApi.controller as AccessControllerConfig;

    // Assign our name if the user hasn't explicitly specified a preference.
    this.name = this.config.name ?? (this.uda.host.hostname ?? this.uda.host.device_type);

    // We successfully logged in.
    this.log.info("Connected to %s (UniFi Access %s running on UniFi OS %s).", this.config.address, this.uda.version, this.uda.host.firmware_version);

    // Mark this NVR as enabled or disabled.
    this.isEnabled = this.hasFeature("Device");

    // If the Access controller is disabled, we're done.
    if(!this.isEnabled) {

      this.udaApi.logout();
      this.log.info("Disabling this UniFi Access controller in HomeKit.");

      // Let's sleep for thirty seconds to give all the accessories a chance to load before disabling everything. Homebridge doesn't have a good mechanism to notify us
      // when all the cached accessories are loaded at startup.
      await this.sleep(30);

      // Unregister all the accessories for this controller from Homebridge that may have been restored already. Any additional ones will be automatically caught when
      // they are restored.
      this.removeHomeKitAccessories(this.platform.accessories.filter(x => x.context.controller === this.uda.host.mac));
      return;
    }

    // Initialize our UniFi Access events handler.
    this.events = new AccessEvents(this);

    // Configure any controller-specific settings.
    this.configureController();

    // Initialize MQTT, if needed.
    if(!this.mqtt && this.config.mqttUrl) {

      this.mqtt = new AccessMqtt(this);
    }

    // Inform the user about the devices we see.
    if(this.udaApi.devices) {

      for(const device of this.udaApi.devices) {

        // Filter out any devices that aren't managed by this Access controller.
        if(!device.is_managed) {

          continue;
        }

        this.log.info("Discovered %s: %s.", device.model ?? device.display_model, this.udaApi.getDeviceName(device, device.name ?? device.model, true));
      }
    }

    // Sync the Access controller's devices with HomeKit.
    const syncUdaHomeKit = (): void => {

      // Sync status and check for any new or removed accessories.
      this.discoverAndSyncAccessories();

      // Refresh the accessory cache.
      this.api.updatePlatformAccessories(this.platform.accessories);
    };

    // Initialize our Access controller device sync.
    syncUdaHomeKit();

    // Bootstrap refresh loop.
    const bootstrapRefresh = (): void => {

      // Sleep until it's time to bootstrap again.
      setTimeout(() => void this.bootstrapController(), ACCESS_CONTROLLER_REFRESH_INTERVAL * 1000);
    };

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

    if(!accessory || !device) {

      return false;
    }

    switch(device.device_type) {

      case "UAH":
      case "UAH-DOOR":

        // We have a UniFi Access hub.
        this.configuredDevices[accessory.UUID] = new AccessHub(this, device, accessory);
        return true;

        break;

      default:

        this.log.error("Unknown device class %s detected for %s.", device.device_type, device.name ?? device.model);

        return false;
    }
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
  public addHomeKitDevice(device: AccessDeviceConfig): AccessDevice | null {

    // If we have no MAC address, name, or this device isn't being managed by this Access controller, we're done.
    if(!this.uda?.host.mac || !device || !device.mac || !device.is_managed) {

      return null;
    }

    // We only support certain devices.
    switch(device.device_type) {

      case "UAH":
      case "UAH-DOOR":

        break;

      default:

        // If we've already informed the user about this one, we're done.
        if(this.unsupportedDevices[device.mac]) {

          return null;
        }

        // Notify the user we see this device, but we aren't adding it to HomeKit.
        this.unsupportedDevices[device.mac] = true;

        this.log.info("UniFi Access device type '%s' is not currently supported, ignoring: %s.", device.device_type, this.udaApi.getDeviceName(device));
        return null;

        break;
    }

    // Exclude or include certain devices based on configuration parameters.
    if(!this.hasFeature("Device", true, device)) {

      return null;
    }

    // Generate this device's unique identifier.
    const uuid = this.hap.uuid.generate(device.mac);

    let accessory: PlatformAccessory | undefined;

    // See if we already know about this accessory or if it's truly new. If it is new, add it to HomeKit.
    if((accessory = this.platform.accessories.find(x => x.UUID === uuid)) === undefined) {

      accessory = new this.api.platformAccessory(device.name ?? device.model, uuid);

      this.log.info("%s: Adding %s to HomeKit.", this.udaApi.getFullName(device), device.model);

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.platform.accessories.push(accessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
    }

    // Link the accessory to it's device object and it's hosting NVR.
    accessory.context.controller = this.uda.host.mac;

    // Locate our existing Access device instance, if we have one.
    const accessDevice = this.configuredDevices[accessory.UUID];

    // Setup the Access device if it hasn't been configured yet.
    if(!accessDevice) {

      this.addAccessDevice(accessory, device);
    }

    return accessDevice;
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
    Object.keys(this.configuredDevices).map(x => this.configuredDevices[x].configureInfo());

    return true;
  }

  // Cleanup removed Access devices from HomeKit.
  private cleanupDevices(): void {

    for(const accessory of this.platform.accessories) {

      const accessDevice = this.configuredDevices[accessory.UUID];

      // Check to see if we have an orphan - where we haven't configured this in the plugin, but the accessory still exists in HomeKit. One example of when this might
      // happen is when Homebridge might be shutdown and a device is then removed. When we start back up, the device still exists in HomeKit but not in Access. We
      // catch those orphan devices here.
      if(!accessDevice) {

        // We only remove devices if they're on the Access controller we're interested in.
        if(("controller" in accessory.context) && (accessory.context.controller !== this.uda.host.mac)) {

          continue;
        }

        // We only store MAC addresses on devices that exist on the Access controller. Any other accessories created are ones we created ourselves and are managed
        // elsewhere.
        if(!("mac" in accessory.context)) {

          continue;
        }

        // For certain use cases, we may want to defer removal of an Access device for a brief period of time.
        const delayInterval = this.getFeatureNumber("Controller.DelayDeviceRemoval");

        if((delayInterval !== undefined) && (delayInterval > 0)) {

          // Have we seen this device queued for removal previously? If not, let's add it to the queue and come back after our specified delay.
          if(!this.deviceRemovalQueue[accessory.UUID]) {

            this.deviceRemovalQueue[accessory.UUID] = Date.now();
            this.log.info("%s: Delaying device removal for at least %s second%s.", accessory.displayName, delayInterval, delayInterval > 1 ? "s" : "");
            continue;
          }

          // Is it time to process this device removal?
          if((delayInterval * 1000) > (Date.now() - this.deviceRemovalQueue[accessory.UUID])) {

            continue;
          }

          // Cleanup after ourselves.
          delete this.deviceRemovalQueue[accessory.UUID];
        }

        this.log.info("%s: Removing device from HomeKit.", accessory.displayName);

        // Unregister the accessory and delete it's remnants from HomeKit.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ accessory ]);
        this.platform.accessories.splice(this.platform.accessories.indexOf(accessory), 1);
        this.api.updatePlatformAccessories(this.platform.accessories);

        continue;
      }

      // If we don't have the Access bootstrap JSON available, we're done. We need to know what's on the Access controller in order to determine what to do with
      // the accessories we know about.
      if(!this.udaApi.bootstrap) {

        continue;
      }

      // Check to see if the device still exists on the Access controller and the user has not chosen to hide it.
      switch(accessDevice.uda.device_type) {

        case "UAH":
        case "UAH-DOOR":

          if(this.udaApi.devices?.some((x: AccessDeviceConfig) => x.mac === accessDevice.uda.mac) && accessDevice.hasFeature("Device")) {

            // In case we have previously queued a device for deletion, let's remove it from the queue since it's reappeared.
            delete this.deviceRemovalQueue[accessDevice.accessory.UUID];
            continue;
          }

          break;

        default:

          break;
      }

      // Process the device removal.
      this.removeHomeKitDevice(this.configuredDevices[accessory.UUID]);
    }
  }

  // Remove an individual Access device from HomeKit.
  public removeHomeKitDevice(accessDevice: AccessDevice): void {

    // Sanity check.
    if(!accessDevice) {

      return;
    }

    // We only remove devices if they're on the Access controller we're interested in.
    if(accessDevice.accessory.context.controller !== this.uda.host.mac) {

      return;
    }

    // For certain use cases, we may want to defer removal of an Access device.
    const delayInterval = this.getFeatureNumber("Controller.DelayDeviceRemoval");

    if((delayInterval !== undefined) && (delayInterval > 0)) {

      // Have we seen this device queued for removal previously? If not, let's add it to the queue and come back after our specified delay.
      if(!this.deviceRemovalQueue[accessDevice.accessory.UUID]) {

        this.deviceRemovalQueue[accessDevice.accessory.UUID] = Date.now();
        this.log.info("%s: Delaying device removal for %s second%s.",
          accessDevice.uda.name ? this.udaApi.getDeviceName(accessDevice.uda) : accessDevice.accessoryName,
          delayInterval, delayInterval > 1 ? "s" : "");

        return;
      }

      // Is it time to process this device removal?
      if((delayInterval * 1000) > (Date.now() - this.deviceRemovalQueue[accessDevice.accessory.UUID])) {

        return;
      }

      // Cleanup after ourselves.
      delete this.deviceRemovalQueue[accessDevice.accessory.UUID];
    }

    // Remove this device.
    this.log.info("%s: Removing %s from HomeKit.",
      accessDevice.uda.name ? this.udaApi.getDeviceName(accessDevice.uda) : accessDevice.accessoryName,
      accessDevice.uda.model ? accessDevice.uda.model : "device");

    const deletingAccessories = [ accessDevice.accessory ];

    // Cleanup our event handlers.
    accessDevice.cleanup();

    // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
    delete this.configuredDevices[accessDevice.accessory.UUID];
    this.removeHomeKitAccessories(deletingAccessories);
  }

  // Remove accessories from HomeKit and Homebridge.
  private removeHomeKitAccessories(deletingAccessories: PlatformAccessory[]): void {

    // Sanity check.
    if(!deletingAccessories || (deletingAccessories.length <= 0)) {

      return;
    }

    // Unregister the accessories from Homebridge and HomeKit.
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, deletingAccessories);

    // Update our internal list of all the accessories we know about.
    for(const accessory of deletingAccessories) {

      this.platform.accessories.splice(this.platform.accessories.indexOf(accessory), 1);
    }

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
    const foundDevice = Object.keys(this.configuredDevices).find(x => this.configuredDevices[x].uda.unique_id === deviceId);

    return foundDevice ? this.configuredDevices[foundDevice] : null;
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): number | undefined {

    return getOptionFloat(getOptionValue(this.platform.featureOptions, this.uda, null, option));
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): number | undefined {

    return getOptionNumber(getOptionValue(this.platform.featureOptions, this.uda, null, option));
  }

  // Utility for checking feature options on the NVR.
  public hasFeature(option: string, defaultReturnValue?: boolean, device:  AccessControllerConfig | AccessDeviceConfig | null = null): boolean {

    return isOptionEnabled(this.platform.featureOptions, this.uda, device, option, defaultReturnValue ?? this.platform.featureOptionDefault(option));
  }

  // Emulate a sleep function.
  public sleep(sleepTimer: number): Promise<NodeJS.Timeout> {

    return new Promise(resolve => setTimeout(resolve, sleepTimer));
  }

  // Retry an operation until we're successful.
  private async retry(operation: () => Promise<boolean>, retryInterval: number): Promise<boolean> {

    // Try the operation that was requested.
    if(!(await operation())) {

      // If the operation wasn't successful, let's sleep for the requested interval and try again.
      await this.sleep(retryInterval);
      return this.retry(operation, retryInterval);
    }

    // We were successful - we're done.
    return true;
  }
}
