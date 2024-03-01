/* Copyright(C) 2024, PW (https://github.com/pwilms). All rights reserved.
 *
 * access-lockMechanism.ts: homebridge-unifi-access lock mechanism for exposing door
 */
import {PlatformAccessory, Service} from "homebridge";

import { AccessPlatform } from "./access-platform";
import {AccessPlatformConfig} from "./interfaces/accessPlatformConfig";

import {DEFAULT_OPENER_DURATION} from "./settings";



/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class AccessLockMechanism {
  private service: Service;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private currentStates = {
    locked: this.platform.Characteristic.LockCurrentState.SECURED
  };

  constructor(
    private readonly platform: AccessPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly config: AccessPlatformConfig
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Ubiquiti")
      .setCharacteristic(this.platform.Characteristic.Model, "Access")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.id);

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.LockMechanism) || this.accessory.addService(this.platform.Service.LockMechanism);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // create handlers for required characteristics
    this.service.getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .onGet(this.handleLockCurrentStateGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.LockTargetState)
      .onGet(this.handleLockTargetStateGet.bind(this))
      .onSet(this.handleLockTargetStateSet.bind(this));


  }

  /**
   * Handle requests to get the current value of the "Lock Current State" characteristic
   */
  handleLockCurrentStateGet(): number {
    this.platform.log.debug("Triggered GET LockCurrentState");
    return this.currentStates.locked;
  }


  /**
   * Handle requests to get the current value of the "Lock Target State" characteristic
   */
  handleLockTargetStateGet(): number {
    this.platform.log.debug("Triggered GET LockTargetState");
    return this.currentStates.locked;
  }

  /**
   * Handle requests to set the "Lock Target State" characteristic
   */
  async handleLockTargetStateSet(value): Promise<void> {
    this.currentStates.locked = value;
    const state = this.platform.Characteristic.LockCurrentState;
    if(value === this.platform.Characteristic.LockCurrentState.UNSECURED){
      const duration = this.config.doorOpenerDuration || DEFAULT_OPENER_DURATION;
      setTimeout(()=>{
        this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState,state.SECURED);
      },duration);
      if(await this. unlockDoor()){
        this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState,state.UNSECURED);
        this.platform.log.debug(`Opened door ${this.config.doorName} successfully`);
      }else{
        this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState,state.SECURED);
        this.platform.log.debug("Failed opening door");
      }
    }else{
      this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState,state.SECURED);
    }
  }


  async unlockDoor(): Promise<boolean>{
    this.platform.log.debug("Triggered unlockDoor");
    const requestHeaders = new Headers();
    requestHeaders.append("Authorization", `Bearer ${this.config.apiToken}`);

    const requestOptions: RequestInit = {
      headers: requestHeaders,
      method: "PUT",
      redirect: "follow"
    };

    try{
      const api = `https://${this.config.consoleHost}:${this.config.consolePort}/api/v1/developer/doors/${this.config.doorId}/unlock`;
      const response = await fetch(api, {...requestOptions});
      const data = <{code:string}>await response.json();
      return data.code === "SUCCESS";
    }catch (err: unknown) {
      if (err instanceof Error) {
        this.platform.log.error(err.message);
      }
      return false;
    }
  }
}
