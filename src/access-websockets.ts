/* Copyright(C) 2024, PW (https://github.com/pwilms). All rights reserved.
 *
 * access-websockets.ts: homebridge-unifi-access websocket class for listing to access events
 */

import {AccessPlatformConfig} from "./interfaces/accessPlatformConfig";
import {AccessWebsocketEventListener} from "./interfaces/accessWebsocketEventListener";
import {Logger} from "homebridge";
import WebSocket from "ws";

export class AccessWebsockets {

  private socket: WebSocket;
  private listeners: AccessWebsocketEventListener[] = [];

  constructor(
    public readonly config: AccessPlatformConfig,
    public readonly log: Logger
  ) {
    this.socket = new WebSocket(`wss://${this.config.consoleHost}:${this.config.consolePort}/api/v1/developer/devices/notifications`, {
      headers: {
        "Authorization": `Bearer ${this.config.apiToken}`
      }
    });

    this.socket.on("error", (e):void=>{
      this.log.error(e.message);
    });

    this.socket.on("open", () => {
      this.socket.send("something");
    });

    this.socket.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data !== "Hello") {
          if(this.listeners.length > 0){
            this.listeners.filter(listener => listener.event === data.event).forEach(
              (listener)=> {
                listener.fn(data);
              }
            );
          }
        }
      } catch (e:unknown) {
        this.log.error(`${e as string}`);
      }
    });
  }

  addEventListener(listener: AccessWebsocketEventListener):void{
    this.listeners.push(listener);
  }
}
