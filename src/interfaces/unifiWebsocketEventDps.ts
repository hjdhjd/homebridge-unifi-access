import {UnifiWebsocketEvent} from "./unifiWebsocketEvent";
import {ContactSensorAccessoryState} from "./contactSensorAccessoryState";

export interface UnifiWebsocketEventDps extends UnifiWebsocketEvent{
  event: string
  data: {
    status: ContactSensorAccessoryState.CLOSE|ContactSensorAccessoryState.OPEN
  }
}
