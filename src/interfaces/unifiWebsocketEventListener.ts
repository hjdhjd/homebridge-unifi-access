import {UnifiWebsocketEvent} from "./unifiWebsocketEvent";

export interface UnifiWebsocketEventListener {
  event: string
  fn: (evnet: UnifiWebsocketEvent) => void;
}
