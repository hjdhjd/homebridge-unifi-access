import {PlatformConfig} from "homebridge/lib/bridgeService";

export interface AccessPlatformConfig extends PlatformConfig{
  apiToken?: string
  consoleHost?: string
  consolePort?: string
  doorId?: string
  doorName?: string
  platform: string
  doorOpenerDuration?: number
}
