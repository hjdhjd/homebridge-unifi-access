import {AccessPlatformConfig} from "./interfaces/AccessPlatformConfig";
import {Logger} from "homebridge";
import {UnifiWebsocketEventListener} from "./interfaces/unifiWebsocketEventListener";
import WebSocket from "ws";

export class UnifiWebsocket {

  private socket: WebSocket;
  private listeners: UnifiWebsocketEventListener[] = [];

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

  addEventListener(listener: UnifiWebsocketEventListener):void{
    this.listeners.push(listener);
  }
}
