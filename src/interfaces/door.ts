import {ContactSensorAccessoryState} from "./contactSensorAccessoryState";

export interface Door {
  door_lock_relay_status: string
  door_position_status: ContactSensorAccessoryState.CLOSE|ContactSensorAccessoryState.OPEN
  floor_id: string
  full_name: string
  id: string
  is_bind_hub: boolean
  name: string
  type: string
}
