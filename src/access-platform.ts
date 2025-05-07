/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-platform.ts: homebridge-unifi-access platform class.
 */
import { API, APIEvent, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { AccessControllerOptions, AccessOptions, featureOptionCategories, featureOptions } from "./access-options.js";
import { ACCESS_MQTT_TOPIC } from "./settings.js";
import { AccessController } from "./access-controller.js";
import { FeatureOptions } from "homebridge-plugin-utils";
import util from "node:util";

export class AccessPlatform implements DynamicPlatformPlugin {

  public accessories: PlatformAccessory[];
  public readonly api: API;
  public readonly config!: AccessOptions;
  private readonly controllers: AccessController[];
  public readonly featureOptions: FeatureOptions;
  public readonly log: Logging;

  constructor(log: Logging, config: PlatformConfig, api: API) {

    this.accessories = [];
    this.api = api;
    this.controllers = [];
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, config?.options ?? []);
    this.log = log;

    // We can't start without being configured.
    if(!config) {

      return;
    }

    // Plugin options into our config variables.
    this.config = {

      controllers: config.controllers as AccessControllerOptions[],
      debugAll: false,
      options: config.options as string[],
      ringDelay: config.ringDelay as number ?? 0
    };

    // We need a UniFi Access controller configured to do anything.
    if(!this.config.controllers) {

      this.log.info("No UniFi Access controllers have been configured.");

      return;
    }

    // Debugging - most people shouldn't enable this.
    this.debug("Debug logging on. Expect a lot of data.");

    // Loop through each configured NVR and instantiate it.
    for(const controllerConfig of this.config.controllers) {

      // We need an address, or there's nothing to do.
      if(!controllerConfig.address) {

        this.log.info("No host or IP address has been configured.");

        continue;
      }

      // We need login credentials or we're skipping this one.
      if(!controllerConfig.username || !controllerConfig.password) {

        this.log.info("No UniFi Access login credentials have been configured.");

        continue;
      }

      // MQTT topic to use.
      controllerConfig.mqttTopic ??= ACCESS_MQTT_TOPIC;

      this.controllers.push(new AccessController(this, controllerConfig));
    }
    // Identify what we're running on so we can take advantage of hardware-specific features.
    this.probeHwOs();

    
    // Avoid a prospective race condition by waiting to configure our controllers until Homebridge is done loading all the cached accessories it knows about, and calling
    // configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.launchControllers.bind(this));
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic
  // for device discovery.
  public configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Launch our configured controllers once all accessories have been loaded. Once we do, they will sustain themselves.
  private launchControllers(): void {

    // Iterate through all our controllers and startup.
    for(const controller of this.controllers) {

      // Login to the Access controller.
      void controller.login();
    }
  }
// Identify what hardware and operating system environment we're actually running on.
  private probeHwOs(): void {

    // Start off with a generic identifier.
    this._hostSystem = "generic";

    // Take a look at the platform we're on for an initial hint of what we are.
    switch(platform) {

      // The beloved macOS.
      case "darwin":

        this._hostSystem = "macOS." + (os.cpus()[0].model.includes("Apple") ? "Apple" : "Intel");

        break;

      // The indomitable Linux.
      case "linux":

        // Let's further see if we're a small, but scrappy, Raspberry Pi.
        try {

          // As of the 4.9 kernel, Raspberry Pi prefers to be identified using this method and has deprecated cpuinfo.
          const systemId = readFileSync("/sys/firmware/devicetree/base/model", { encoding: "utf8" });

          // Is it a Pi 4?
          if(/Raspberry Pi (Compute Module )?4/.test(systemId)) {

            this._hostSystem = "raspbian";
          }
        } catch(error) {

          // We aren't especially concerned with errors here, given we're just trying to ascertain the system information through hints.
        }

        break;

      default:

        // We aren't trying to solve for every system type.
        break;
    }
  }

  // Utility to return the hardware environment we're on.
  public get hostSystem(): string {

    return this._hostSystem;
  }
  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debugAll) {

      this.log.info(util.format(message, ...parameters));
    }
  }
}
