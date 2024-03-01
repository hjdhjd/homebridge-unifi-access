import {AccessContactSensorState} from "./accessContactSensorState";

export interface AccessDoor {
  door_lock_relay_status: string
  door_position_status: AccessContactSensorState.CLOSE|AccessContactSensorState.OPEN
  floor_id: string
  full_name: string
  id: string
  is_bind_hub: boolean
  name: string
  type: string
}
