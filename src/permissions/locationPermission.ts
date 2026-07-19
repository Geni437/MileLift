import * as Location from 'expo-location';

import { toOsPermissionStatus, type OsPermissionStatus } from './types';

/**
 * When-In-Use only, per screens-phase-0.md §E2 builder note: "request When
 * In Use, not Always. Requesting Always here would contradict the purpose
 * string and fail review." There is no `requestBackgroundPermissionsAsync`
 * call anywhere in this module — that's deliberate, not an oversight.
 */
export const locationPermission = {
  async getStatus(): Promise<OsPermissionStatus> {
    const response = await Location.getForegroundPermissionsAsync();
    return toOsPermissionStatus(response);
  },

  /** Only call after the user taps "Allow" on our in-app priming sheet — never on screen mount. */
  async request(): Promise<OsPermissionStatus> {
    const response = await Location.requestForegroundPermissionsAsync();
    return toOsPermissionStatus(response);
  },
};
