import type { AuthError } from '@supabase/supabase-js';

/**
 * Explicit, distinguishable auth error kinds (production-standards: "a
 * caller should be able to distinguish 'not found' from 'not authorized'
 * from 'validation failed' ... without string-matching an error message" —
 * this module IS the one place allowed to string-match Supabase's error
 * messages, so every screen downstream gets a typed kind instead).
 */
export type AuthErrorKind =
  | 'network_offline'
  | 'invalid_credentials'
  | 'email_in_use'
  | 'weak_password'
  | 'unverified_email'
  | 'rate_limited'
  | 'unknown';

export type AuthErrorResult = {
  kind: AuthErrorKind;
  message: string;
};

/**
 * Maps a raw Supabase AuthError (or a thrown network error) to a typed kind.
 * `screens-phase-0.md` §B/§C specify exact copy per kind — screens own the
 * copy, this module only owns classification.
 */
export function classifyAuthError(error: unknown): AuthErrorResult {
  if (error instanceof TypeError && /network/i.test(error.message)) {
    return { kind: 'network_offline', message: error.message };
  }

  const authError = error as Partial<AuthError> & { message?: string; status?: number };
  const message = authError?.message ?? String(error);
  const status = authError?.status;

  if (/network request failed|fetch failed|Network Error/i.test(message)) {
    return { kind: 'network_offline', message };
  }
  if (/already registered|already exists|user_already_exists/i.test(message)) {
    return { kind: 'email_in_use', message };
  }
  if (/password should be at least|password is too short|weak password/i.test(message)) {
    return { kind: 'weak_password', message };
  }
  if (/invalid login credentials|invalid_grant/i.test(message)) {
    return { kind: 'invalid_credentials', message };
  }
  if (/email not confirmed|email_not_confirmed/i.test(message)) {
    return { kind: 'unverified_email', message };
  }
  if (status === 429 || /rate limit|too many requests/i.test(message)) {
    return { kind: 'rate_limited', message };
  }

  return { kind: 'unknown', message };
}
