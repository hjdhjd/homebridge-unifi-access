import {AccessWebsocketEvent} from "./accessWebsocketEvent";
import {AccessContactSensorState} from "./accessContactSensorState";

export interface AccessWebsocketEventDps extends AccessWebsocketEvent{
  event: string
  data: {
    status: AccessContactSensorState.CLOSE|AccessContactSensorState.OPEN
  }
}
