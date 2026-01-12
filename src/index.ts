/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.ts: homebridge-unifi-access plugin registration.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import type { API } from "homebridge";
import { AccessPlatform } from "./access-platform.js";

// Register our platform with homebridge.
export default (api: API): void => {

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AccessPlatform);
};
