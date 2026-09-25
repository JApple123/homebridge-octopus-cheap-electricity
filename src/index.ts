import type { API } from 'homebridge';

import { OctopusEnergyPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/**
 * Register the platform with Homebridge.
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, OctopusEnergyPlatform);
};
