/* Copyright(C) 2024, PW (https://github.com/pwilms). All rights reserved.
 *
 * access-platform.ts: homebridge-unifi-access platform class
 */

import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  Service
} from "homebridge";
import {DEFAULT_ACCESS_PORT, DEFAULT_DOORNAME, PLATFORM_NAME, PLUGIN_NAME} from "./settings";

import {AccessContactSensor} from "./access-contactSensor";
import {AccessContactSensorState} from "./interfaces/accessContactSensorState";
import {AccessDoor} from "./interfaces/accessDoor";
import {AccessDoorsResponse} from "./interfaces/accessDoorsResponse";
import {AccessLockMechanism} from "./access-lockMechanism";
import {AccessPlatformConfig} from "./interfaces/accessPlatformConfig";
import {AccessWebsockets} from "./access-websockets";



/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class AccessPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public contactSensor?: AccessContactSensor;

  public unifiWebsocket?: AccessWebsockets;

  constructor(
    public readonly log: Logger,
    public readonly config: AccessPlatformConfig,
    public readonly api: API
  ) {
    this.log.debug("Finished initializing platform:", this.config.name);
    if(this.config.consoleHost){
      this.unifiWebsocket = new AccessWebsockets(this.config, this.log);
    }else{
      this.log.error("Cannot setup WebSocket");
    }

    this.api.on("didFinishLaunching", () => {
      log.debug("Executed didFinishLaunching callback");
      void this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory):void {
    this.log.info("Loading accessory from cache:", accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  async discoverDevices(): Promise<void> {
    try{
      const doors = await this.readDoors();
      this.setupDoor();
      this.setupContactSensor(doors.data);
    }catch (e: unknown) {
      const msg = (e instanceof Error)?e.message:"";
      this.log.error(`failed to setup devices - ${msg} `);
    }
  }

  setupDoor():boolean{
    if(!this.config?.doorId){
      this.log.error("No door id is configured");
      return false;
    }
    const uuid = this.api.hap.uuid.generate(this.config.doorId);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    if (existingAccessory) {
      this.log.info("Restoring existing accessory from cache:", existingAccessory.displayName);
      new AccessLockMechanism(this, existingAccessory, this.config);
    } else {
      this.log.info("Adding new accessory:", this.config.doorName);
      const accessory = new this.api.platformAccessory(this.config.doorName || DEFAULT_DOORNAME, uuid);
      accessory.context.device = {
        id: this.config.doorId,
        name: this.config.doorName
      };
      new AccessLockMechanism(this, accessory, this.config);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    return true;
  }

  setupContactSensor(doors: AccessDoor[]): void{
    const uuid = this.api.hap.uuid.generate(this.config.doorId+"dps");
    const name = this.config.doorName + " Contact";
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    if (existingAccessory) {
      this.log.info("Restoring existing accessory from cache:", name);
      this.contactSensor = new AccessContactSensor(this, existingAccessory, this.config, this.unifiWebsocket);
    } else {
      this.log.info("Adding new accessory:", name);
      const accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.device = {
        id: this.config.doorId,
        name: name
      };
      this.contactSensor = new AccessContactSensor(this, accessory, this.config, this.unifiWebsocket);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    for(const door of doors){
      if(door.id === this.config.doorId){
        this.contactSensor.update(door.door_position_status === AccessContactSensorState.CLOSE);
      }
    }
  }

  async readDoors(): Promise<AccessDoorsResponse>{
    const requestHeaders = new Headers();
    requestHeaders.append("Authorization", `Bearer ${this.config.apiToken}`);
    const requestOptions: RequestInit = {
      headers: requestHeaders,
      method: "GET",
      redirect: "follow"
    };
    try{
      const response = await fetch(`https://${this.config.consoleHost}:${DEFAULT_ACCESS_PORT}/api/v1/developer/doors`, {...requestOptions});
      return <AccessDoorsResponse>await response.json();
    }catch (err: unknown) {
      throw Error("error fetching doors");
    }
  }
}
