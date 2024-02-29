import {PlatformAccessory, PlatformConfig, Service} from "homebridge";

import {ExampleHomebridgePlatform} from "./platform";
import {UnifiWebsocket} from "./unifiWebsocket";
import {ContactSensorAccessoryState} from "./interfaces/contactSensorAccessoryState";
import {ContactSensorAccessoryEvents} from "./interfaces/contactSensorAccessoryEvents";
import {UnifiWebsocketEvent} from "./interfaces/unifiWebsocketEvent";

export class ContactSensorAccessory {
  private service: Service;

  private currentStates = {
    contact: this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
  };

  constructor(
    private readonly platform: ExampleHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    public readonly config: PlatformConfig,
    private readonly socket?: UnifiWebsocket
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Ubiquiti")
      .setCharacteristic(this.platform.Characteristic.Model, "Access")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.id);

    this.service = this.accessory.getService(this.platform.Service.ContactSensor) || this.accessory.addService(this.platform.Service.ContactSensor);
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.handleContactSensorStateGet.bind(this));

    if(this.socket){
      this.socket.addEventListener({
        event: ContactSensorAccessoryEvents.DPS_CHANGE,
        fn: this.dpsChangeEvent.bind(this)
      });
    }
  }

  handleContactSensorStateGet() {
    this.platform.log.debug("Triggered GET ContactSensorState");
    return this.currentStates.contact;
  }

  update(contact:boolean) {
    this.currentStates.contact = contact ? this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED:this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    this.service.getCharacteristic(this.platform.Characteristic.ContactSensorState).setValue(this.currentStates.contact);
  }

  private dpsChangeEvent(event: UnifiWebsocketEvent){
    this.update(event.data.status === ContactSensorAccessoryState.CLOSE);
  }

}
