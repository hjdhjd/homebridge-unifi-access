/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-reader.ts: homebridge-unifi-access platform class.
 */
import type { AccessDeviceConfig, AccessEventPacket } from "unifi-access";
import type { CharacteristicValue, PlatformAccessory } from "homebridge";
import { acquireService, validService } from "homebridge-plugin-utils";
import type { AccessController } from "./access-controller.js";
import { AccessDevice } from "./access-device.js";
import { AccessReservedNames } from "./access-types.js";
import { AccessMethod } from "unifi-access";

export class AccessReader extends AccessDevice {
  public uda: AccessDeviceConfig;
  private handWaveEnabled: boolean;

  // Create an instance.
  constructor(controller: AccessController, device: AccessDeviceConfig, accessory: PlatformAccessory) {
    
    super(controller, accessory);
    
    this.uda = device;
    this.handWaveEnabled = false; // We'll update this when we get the device state
    this.configureDevice();
  }

  // Initialize and configure the reader accessory for HomeKit.
  private configureDevice(): boolean {
    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.uda.mac;
    this.accessory.context.controller = this.controller.uda.host.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure the hand-wave switch.
    this.configureHandWaveService();

    // Listen for events.
    this.controller.events.on(this.uda.unique_id, this.listeners[this.uda.unique_id] = this.eventHandler.bind(this));

    return true;
  }

  // Configure the hand-wave switch service.
  private configureHandWaveService(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch,
      this.hasCapability("hand_wave") && this.hasFeature("Reader.HandWave"),
      AccessReservedNames.SWITCH_READER_HAND_WAVE)) {

      return false;
    }

    // Acquire the service.
    const switchService = acquireService(this.hap, this.accessory, this.hap.Service.Switch,
      this.accessoryName + " Hand Wave", AccessReservedNames.SWITCH_READER_HAND_WAVE,
      () => this.log.info("%s: Enabling the hand-wave switch.", this.accessoryName));

    if (!switchService) {
      this.log.error("%s: Unable to add the hand-wave switch.", this.accessoryName);
      return false;
    }

    // Handle changes from HomeKit
    switchService.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {
      // Update the hand-wave setting through the API
      const success = await this.setHandWaveState(value as boolean);
      if (!success) {
        // If the update failed, revert the switch state
        setTimeout(() => switchService.updateCharacteristic(this.hap.Characteristic.On, this.handWaveEnabled), 50);
      } else {
        this.handWaveEnabled = value as boolean;
      }
    });

    // Initialize the switch.
    switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.accessoryName + " Hand Wave");
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.handWaveEnabled);

    return true;
  }

  // Set the hand-wave state through the UniFi Access API
  private async setHandWaveState(enabled: boolean): Promise<boolean> {
    try {
      this.log.info("Setting hand-wave state to %s", enabled);
      const result = await this.controller.udaApi.setReaderAccessMethod(
        this.uda,
        enabled ? AccessMethod.HAND_WAVE : AccessMethod.NFC
      );

      if (result) {
        this.log.info("%s: Access method set to %s", this.accessoryName, enabled ? "hand-wave" : "NFC");
        return true;
      }
      this.log.info("Failed to set hand-wave state to %s", enabled);
      return false;
    } catch (error) {
      this.log.error("Failed to update hand-wave state: %s", error);
      return false;
    }
  }

  // Handle reader-related events.
  private eventHandler(packet: AccessEventPacket): void {
    switch(packet.event) {
        // Process device updates - we'll need to check if hand-wave setting changed
        // Update this when we know the exact event data structure
        
        default:

        break;
    }
  }

  // Utility to validate reader capabilities.
  private hasCapability(capability: string | string[]): boolean {
    return Array.isArray(capability) ? capability.some(c => this.uda?.capabilities?.includes(c)) : this.uda?.capabilities?.includes(capability);
  }
} 
