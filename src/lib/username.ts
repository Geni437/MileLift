import { supabase } from './supabase';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,30}$/;

export type UsernameCheckResult = 'available' | 'taken' | 'invalid_format' | 'unknown_offline';

/**
 * Live username-availability check against `profiles_public` (the
 * column-safe cross-user view — architecture §8), matching the format CHECK
 * already enforced by the DB (`profiles_username_format_chk`).
 *
 * FLAGGED GAP (not silently worked around): the live `profiles` schema
 * (supabase/migrations/20260718210814_create_profiles.sql) has NO unique
 * constraint/index on `username`, despite architecture §2 documenting it as
 * "Unique, for community." This check is therefore a best-effort UX
 * affordance, not a race-safe guarantee — two users could still both pass
 * this check and both write the same username (classic check-then-act
 * race). Needs a `db-engineer` follow-up migration:
 * `CREATE UNIQUE INDEX ... ON profiles (lower(username)) WHERE username IS NOT NULL`.
 * Flagging in the task report rather than attempting a schema change here.
 */
export async function checkUsernameAvailability(username: string, currentUserId: string): Promise<UsernameCheckResult> {
  if (!USERNAME_PATTERN.test(username)) return 'invalid_format';

  try {
    const { data, error } = await supabase
      .from('profiles_public')
      .select('id')
      .ilike('username', username)
      .maybeSingle<{ id: string }>();

    if (error) return 'unknown_offline';
    if (!data) return 'available';
    return data.id === currentUserId ? 'available' : 'taken';
  } catch {
    return 'unknown_offline';
  }
}
