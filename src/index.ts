/* Copyright(C) 2024, PW (https://github.com/pwilms). All rights reserved.
 *
 * index.ts: homebridge-unifi-access plugin registration.
 */
import { API } from "homebridge";

import { AccessPlatform } from "./access-platform";
import { PLATFORM_NAME } from "./settings";

/**
 * This method registers the platform with Homebridge
 */
export = (api: API):void => {
  api.registerPlatform(PLATFORM_NAME, AccessPlatform);
};
