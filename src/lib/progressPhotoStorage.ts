import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';

import { supabase } from './supabase';

const BUCKET = 'progress-photos';

/** Deterministic path within the bucket — `{user_id}/{timeline_event_id}/{pose}.jpg` (architecture §1.9), matching the DB's own CHECK-enforced `object_path` shape. */
export function progressPhotoObjectPath(userId: string, timelineEventId: string, pose: string): string {
  return `${userId}/${timelineEventId}/${pose}.jpg`;
}

export type PhotoUploadResult = { ok: true; objectPath: string; checksum: string } | { ok: false; error: string };

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Self-contained base64 decoder — deliberately does not depend on `atob`
 * (not guaranteed present in every Hermes/RN runtime configuration) or
 * Node's `Buffer` (not available in RN without a polyfill this project
 * doesn't otherwise need). `expo-file-system` gives us the photo as a
 * base64 string; Supabase Storage's `.upload()` wants raw bytes.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const byteLength = Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
  const bytes = new Uint8Array(byteLength);
  let byteIndex = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_CHARS.indexOf(clean[i] ?? 'A');
    const c1 = BASE64_CHARS.indexOf(clean[i + 1] ?? 'A');
    const c2 = BASE64_CHARS.indexOf(clean[i + 2] ?? 'A');
    const c3 = BASE64_CHARS.indexOf(clean[i + 3] ?? 'A');

    const triple = (c0 << 18) | (c1 << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
    if (byteIndex < byteLength) bytes[byteIndex++] = (triple >> 16) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = (triple >> 8) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = triple & 0xff;
  }
  return bytes.buffer;
}

/**
 * Upload-then-metadata ordering (§5/§10): bytes go to Storage first; only on
 * success does the caller write the `progress_photo_images` row. `upsert:
 * true` makes a retried upload at the same deterministic path safe — a
 * failed/retried sync never leaves two copies, mirroring `uploadRawTrack`.
 */
export async function uploadProgressPhoto(userId: string, timelineEventId: string, pose: string, localUri: string): Promise<PhotoUploadResult> {
  try {
    const base64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
    const checksum = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64);
    const objectPath = progressPhotoObjectPath(userId, timelineEventId, pose);
    const bytes = base64ToArrayBuffer(base64);

    const { error } = await supabase.storage.from(BUCKET).upload(objectPath, bytes, {
      contentType: 'image/jpeg',
      upsert: true,
    });

    if (error) return { ok: false, error: error.message };
    return { ok: true, objectPath, checksum };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown upload error.' };
  }
}
