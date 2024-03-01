import { API } from "homebridge";

import { AccessPlatform } from "./accessPlatform";
import { PLATFORM_NAME } from "./settings";

/**
 * This method registers the platform with Homebridge
 */
export = (api: API):void => {
  api.registerPlatform(PLATFORM_NAME, AccessPlatform);
};
