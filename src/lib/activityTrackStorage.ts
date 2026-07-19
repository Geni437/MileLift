import * as Crypto from 'expo-crypto';

import { supabase } from './supabase';
import type { TrackPoint } from './geo';

const BUCKET = 'activity-tracks';

/**
 * Full-resolution raw track upload — the "compute once, upload once" half of
 * architecture §2.1. Serialized as JSON (lat/lng/elevation/timestamp/
 * accuracy per point, matching §2.1's "full stream" contents), sent as
 * `application/octet-stream` per the bucket's allowed MIME type.
 *
 * FLAGGED SIMPLIFICATION: this is not binary-packed or gzip-compressed — no
 * compression dependency exists in this project yet, and adding one is
 * out of scope for this pass. The architectural property this preserves
 * (one blob, uploaded once, never point-by-point to Postgres) holds
 * regardless of the byte-level encoding; a binary/gzip encoder is a
 * reasonable follow-up if track-upload payload size becomes a real cost.
 */

/** The `activity-tracks/{user_id}/{id}/track.bin` form the RPC's `p_raw_track_object_path` requires. */
export function rpcTrackObjectPath(userId: string, activityId: string): string {
  return `${BUCKET}/${userId}/${activityId}/track.bin`;
}

/** The path WITHIN the bucket (no bucket-name prefix) that the Storage client itself expects. */
function storageObjectPath(userId: string, activityId: string): string {
  return `${userId}/${activityId}/track.bin`;
}

export type RawTrackUploadResult =
  | { ok: true; objectPath: string; checksum: string; pointCount: number }
  | { ok: false; error: string };

export async function uploadRawTrack(userId: string, activityId: string, points: TrackPoint[]): Promise<RawTrackUploadResult> {
  const payload = JSON.stringify(
    points.map((p) => ({
      lat: p.latitude,
      lng: p.longitude,
      ele: p.elevationM,
      acc: p.accuracyM,
      t: p.recordedAt,
    }))
  );

  const checksum = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload);

  try {
    const { error } = await supabase.storage.from(BUCKET).upload(storageObjectPath(userId, activityId), payload, {
      contentType: 'application/octet-stream',
      upsert: true, // re-upload overwrites — architecture §2.1's retry-safety guarantee
    });

    if (error) {
      return { ok: false, error: error.message };
    }

    return { ok: true, objectPath: rpcTrackObjectPath(userId, activityId), checksum, pointCount: points.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown upload error.' };
  }
}
