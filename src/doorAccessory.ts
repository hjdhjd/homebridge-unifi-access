import {Service, PlatformAccessory, CharacteristicValue, PlatformConfig} from 'homebridge';

import { ExampleHomebridgePlatform } from './platform';
import https from "https";

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class DoorAccessory {
  private service: Service;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private currentStates = {
    locked: this.platform.Characteristic.LockCurrentState.SECURED
  };

  constructor(
      private readonly platform: ExampleHomebridgePlatform,
      private readonly accessory: PlatformAccessory,
      public readonly config: PlatformConfig
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Default-Manufacturer')
        .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
        .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.LockMechanism) || this.accessory.addService(this.platform.Service.LockMechanism);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.exampleDisplayName);

    // create handlers for required characteristics
    this.service.getCharacteristic(this.platform.Characteristic.LockCurrentState)
        .onGet(this.handleLockCurrentStateGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.LockTargetState)
        .onGet(this.handleLockTargetStateGet.bind(this))
        .onSet(this.handleLockTargetStateSet.bind(this));


  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  handleLockCurrentStateGet() {
    this.platform.log.debug('Triggered GET LockCurrentState');

    // set this to a valid value for LockCurrentState
    const currentValue = this.currentStates.locked

    return currentValue;
  }


  /**
   * Handle requests to get the current value of the "Lock Target State" characteristic
   */
  handleLockTargetStateGet() {
    this.platform.log.debug('Triggered GET LockTargetState');

    // set this to a valid value for LockTargetState
    const currentValue = this.currentStates.locked

    return currentValue;
  }

  /**
   * Handle requests to set the "Lock Target State" characteristic
   */
  async handleLockTargetStateSet(value) {
    this.currentStates.locked = value;
    if(value === this.platform.Characteristic.LockCurrentState.UNSECURED){
      console.log("UNLOCK");
      setTimeout(()=>{
        this.platform.log.debug('Triggered RESET LockTargetState:'+ value);
        this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState,this.platform.Characteristic.LockCurrentState.SECURED);
      },4000);
      if(await this. unlockDoor()){
        this.platform.log.debug(`Opened door ${this.config.doorName} successfully`);
      }else{
        this.platform.log.debug('Failed opening door');
      }
    }
  }


  async unlockDoor(){
    this.platform.log.debug('Triggered unlockDoor');
    const agent = new https.Agent({
      rejectUnauthorized: false,
    });
    const requestHeaders = new Headers();
    requestHeaders.append("Authorization", `Bearer ${this.config.apiToken}`);

    const requestOptions: RequestInit = {
      method: 'PUT',
      headers: requestHeaders,
      redirect: 'follow'
    };

    try{
      const response = await fetch(`https://${this.config.consoleHost}:12445/api/v1/developer/doors/${this.config.doorId}/unlock`, {...requestOptions})
      const data = <{code:string}>await response.json();
      return data.code === "SUCCESS";
    }catch (e: any) {
      return false;
    }
  }


}
