import { supabase } from './supabase';

const EXERCISE_MEDIA_BUCKET = 'exercise-media';

/**
 * Resolves an `exercise_media.url_or_object_path` value to a fetchable image
 * URL (architecture §2.2's "hosted/CDN URL or a Storage object path in the
 * exercise-media bucket"). The ingested library mostly carries full CDN URLs
 * already; a bare object path (no scheme) is resolved against the public
 * `exercise-media` bucket — non-sensitive reference assets, no signed URL
 * needed (see that bucket's migration header).
 */
export function resolveExerciseMediaUrl(urlOrObjectPath: string): string {
  if (/^https?:\/\//i.test(urlOrObjectPath)) return urlOrObjectPath;
  return supabase.storage.from(EXERCISE_MEDIA_BUCKET).getPublicUrl(urlOrObjectPath).data.publicUrl;
}
