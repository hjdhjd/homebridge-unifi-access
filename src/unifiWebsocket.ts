import {UnifiWebsocketEventListener} from "./interfaces/unifiWebsocketEventListener";
import {PlatformConfig} from "homebridge";
import WebSocket from "ws";

export class UnifiWebsocket {

  private socket: WebSocket;
  private listeners: UnifiWebsocketEventListener[] = [];

  constructor(
    public readonly config: PlatformConfig
  ) {
    this.socket = new WebSocket(`wss://${this.config.consoleHost}:${this.config.consolePort}/api/v1/developer/devices/notifications`, {
      headers: {
        "Authorization": `Bearer ${this.config.apiToken}`
      }
    });

    this.socket.on("error", console.error);

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
      } catch (e) {
        console.log(e);
      }
    });
  }

  addEventListener(listener: UnifiWebsocketEventListener){
    this.listeners.push(listener);
  }
}
