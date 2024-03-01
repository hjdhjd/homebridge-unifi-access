/* Copyright(C) 2024, PW (https://github.com/pwilms). All rights reserved.
 *
 * access-contactSensor.ts: homebridge-unifi-access contact sensor for exposing dps events
 */
import {PlatformAccessory, Service} from "homebridge";

import {AccessContactSensorEvents} from "./interfaces/accessContactSensorEvents";
import {AccessContactSensorState} from "./interfaces/accessContactSensorState";
import {AccessPlatform} from "./access-platform";
import {AccessPlatformConfig} from "./interfaces/accessPlatformConfig";
import {AccessWebsocketEventDps} from "./interfaces/accessWebsocketEventDps";
import {AccessWebsockets} from "./access-websockets";


export class AccessContactSensor {
  private service: Service;

  private currentStates = {
    contact: this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
  };

  constructor(
    private readonly platform: AccessPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly config: AccessPlatformConfig,
    private readonly socket?: AccessWebsockets
  ) {
    // set accessory information
    accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Ubiquiti")
      .setCharacteristic(this.platform.Characteristic.Model, "Access")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.id);

    this.service = this.accessory.getService(this.platform.Service.ContactSensor) || this.accessory.addService(this.platform.Service.ContactSensor);
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.handleContactSensorStateGet.bind(this));

    if(this.socket){
      this.socket.addEventListener({
        event: AccessContactSensorEvents.DPS_CHANGE,
        fn: this.dpsChangeEvent.bind(this)
      });
    }
  }

  handleContactSensorStateGet():number {
    this.platform.log.debug("Triggered GET ContactSensorState");
    return this.currentStates.contact;
  }

  update(contact:boolean):void {
    const state = this.platform.Characteristic.ContactSensorState;
    this.currentStates.contact = contact ? state.CONTACT_DETECTED:state.CONTACT_NOT_DETECTED;
    this.service.getCharacteristic(state).setValue(this.currentStates.contact);
  }

  private dpsChangeEvent(event: AccessWebsocketEventDps): void{
    this.update(event.data.status === AccessContactSensorState.CLOSE);
  }

}
