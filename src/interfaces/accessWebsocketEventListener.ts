import {AccessWebsocketEvent} from "./accessWebsocketEvent";

export interface AccessWebsocketEventListener {
  event: string
  fn: (evnet: AccessWebsocketEvent) => void;
}
