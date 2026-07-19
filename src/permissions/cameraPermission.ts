import { Camera } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

import { toOsPermissionStatus, type OsPermissionStatus } from './types';

export const cameraPermission = {
  async getStatus(): Promise<OsPermissionStatus> {
    const response = await Camera.getCameraPermissionsAsync();
    return toOsPermissionStatus(response);
  },

  /** Only call after the user taps "Allow camera" on our in-app priming sheet. */
  async request(): Promise<OsPermissionStatus> {
    const response = await Camera.requestCameraPermissionsAsync();
    return toOsPermissionStatus(response);
  },
};

/**
 * The library fallback (screens-phase-0.md §E3 footnote: "You can also add a
 * photo from your library instead") uses its own OS permission, separate
 * from the camera consent category — declining camera never blocks this.
 */
export const photoLibraryPermission = {
  async getStatus(): Promise<OsPermissionStatus> {
    const response = await ImagePicker.getMediaLibraryPermissionsAsync();
    return toOsPermissionStatus(response);
  },
  async request(): Promise<OsPermissionStatus> {
    const response = await ImagePicker.requestMediaLibraryPermissionsAsync();
    return toOsPermissionStatus(response);
  },
};
