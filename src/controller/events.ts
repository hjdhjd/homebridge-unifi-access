/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * events.ts: Events class for UniFi Access.
 */
import type { AccessEventPacket, AccessWebhookEvent } from "unifi-access";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { AccessController } from "./controller.ts";
import { EventEmitter } from "node:events";
import { mqttTopic } from "homebridge-plugin-utils";
import { mqttTopics } from "../mqtt.ts";

/* The controller's device-update event name. It is stated here, once, because three consumers depend on it agreeing exactly: the raw-rail bridge excludes it, the
 * per-device observe loop emits it, and the hub's event handler branches on it. A retyped literal at any one of those sites would silently sever the path, so they
 * all read the same constant instead.
 */
export const ACCESS_DEVICE_UPDATE_EVENT = "access.data.device.update";

/* The prefix every webhook delivery is emitted under.
 *
 * The two channels share names: `access.door.unlock` is a delivery this plugin consumes and a frame the notification socket also sends, and the two carry entirely
 * different payloads. Emitting deliveries under a prefix keeps the two listener populations apart, so a socket handler can never be handed a delivery it would
 * read as a packet.
 */
export const ACCESS_WEBHOOK_EVENT_PREFIX = "webhook:";

// The listener parameter the emitter itself declares, stated once here so every registration path in the plugin agrees with the emitter rather than with a
// hand-written signature that could drift from it.
export type AccessListener = Parameters<EventEmitter["on"]>[1];

/**
 * The hub's compatibility bridge over the client's realtime rails. Device updates reach the hub through the per-device observe loops, which deliver a correctly
 * merged record; everything else the controller says reaches it through the raw packet rail bridged here, keyed by the event vocabulary the hub already listens on.
 */
export class AccessEvents extends EventEmitter {

  private readonly controller: AccessController;
  private readonly log: HomebridgePluginLogging;
  private readonly mqttPublishTelemetry: boolean;
  #subscription: Nullable<Disposable>;

  // Initialize an instance of our Access events handler.
  constructor(controller: AccessController) {

    super();

    this.controller = controller;
    this.log = controller.log;
    this.mqttPublishTelemetry = controller.hasFeature("Controller.Publish.Telemetry");
    this.#subscription = null;

    // If we've enabled telemetry from the controller inform the user.
    if(this.mqttPublishTelemetry) {

      this.log.info("Access controller telemetry enabled.");
    }

    this.#subscription = controller.client.on("rawPacket", (packet: AccessEventPacket) => this.handleRawPacket(packet));
  }

  /**
   * Bridge one raw wire frame onto the plugin's event vocabulary. The wire-facing half of this class, and the one place the telemetry mirror lives.
   *
   * The mirror runs first and unconditionally, so every frame the controller sends is republished exactly once - which is the contract a telemetry subscriber has
   * always been able to rely on. It deliberately does not live in the emission chokepoint below: that chokepoint serves the synthetic device updates as well, so a
   * mirror there would publish a single wire frame twice.
   *
   * Device updates are then the one exclusion. The raw rail emits before the store folds the frame, so bridging a device update would race the read-through record
   * the hub's handler reads, delivering it the state as it was rather than as the update left it; the per-device observe loops deliver those updates post-fold
   * instead. The controller's newer device-update dialect still bridges here, because its handler reads the frame's own payload alongside topology facts that a
   * device-update fold does not change, so the pre-fold hazard does not arise for it.
   *
   * @param packet - The raw frame as the controller sent it.
   */
  public handleRawPacket(packet: AccessEventPacket): void {

    // If enabled, publish all the event traffic coming from the Access controller to MQTT.
    if(this.mqttPublishTelemetry) {

      this.controller.mqttPublish(mqttTopic(this.controller.mqttIdentity, mqttTopics.telemetry.topic), JSON.stringify(packet));
    }

    if(packet.event === ACCESS_DEVICE_UPDATE_EVENT) {

      return;
    }

    this.emitPacket(packet);
  }

  /**
   * Deliver one packet to the accessories listening for it. The single emission chokepoint, carrying every addressing pattern the device layer subscribes on: the
   * event name, the object the event names, the device a newer-dialect update names in its metadata, and the event-and-object combination.
   *
   * Both the wire bridge and the per-device loops' post-fold synthetic updates come through here, so what a listener receives has one shape regardless of which rail
   * produced it.
   *
   * @param packet - The packet to deliver.
   */
  public emitPacket(packet: AccessEventPacket): void {

    // Emit messages based on the event type.
    this.emit(packet.event, packet);

    // Emit messages based on the specific device.
    this.emit(packet.event_object_id, packet);

    // For the newer device update dialect, we unpack the metadata to determine which device we're targeting.
    if((packet.event === "access.data.v2.device.update") && (packet.meta?.object_type === "device")) {

      this.emit(packet.meta.id, packet);
    }

    // Finally, emit messages based on the specific event and device combination.
    this.emit(packet.event + "." + packet.event_object_id, packet);
  }

  /**
   * Deliver one verified webhook delivery to the accessories listening for it.
   *
   * Deliveries are deliberately not mirrored to the telemetry topic. That mirror is a republication of the controller's notification socket, and a subscriber has
   * always been able to read it as exactly that...folding a second, differently-shaped channel into it would quietly change what the topic means.
   *
   * @param delivery - The delivery, already verified and admitted by the controller that received it.
   */
  public emitDelivery(delivery: AccessWebhookEvent): void {

    this.emit(ACCESS_WEBHOOK_EVENT_PREFIX + delivery.event, delivery);
  }

  // Detach from the wire and drop every listener. Called from the controller's teardown, so the bridge never outlives the client whose rail it observes.
  public dispose(): void {

    this.#subscription?.[Symbol.dispose]();
    this.#subscription = null;
    this.removeAllListeners();
  }
}
