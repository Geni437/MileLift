import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';

import { supabase } from './supabase';
import { classifyAuthError, type AuthErrorResult } from './authErrors';

export type OAuthProvider = 'apple' | 'google';
export type OAuthResult = { ok: true } | { ok: false; error: AuthErrorResult } | { ok: false; cancelled: true };

/**
 * Real Supabase OAuth flow (Authorization Code w/ PKCE via
 * `signInWithOAuth` + an in-app browser session), per screens-phase-0.md §B
 * "Continue with Apple" / "Continue with Google".
 *
 * SCOPING NOTE (flagged for the person / devops-engineer, not silently
 * assumed): this requires the Apple and Google OAuth providers to be
 * configured on the Supabase project (client IDs/secrets, redirect URLs) —
 * that is dashboard/infra configuration outside mobile-builder's scope and
 * was not part of the "verified working" backend described in the task
 * brief (only email/password + the four Phase-0 tables were confirmed
 * live). The code path below is real, not a stub — if the provider isn't
 * configured yet, Supabase returns a real error which surfaces through the
 * same InlineBanner as any other sign-in failure, rather than pretending to
 * succeed.
 */
export async function signInWithOAuth(provider: OAuthProvider): Promise<OAuthResult> {
  const redirectTo = Linking.createURL('auth/callback');

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });

  if (error || !data?.url) {
    return { ok: false, error: classifyAuthError(error ?? new Error('No OAuth URL returned')) };
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { ok: false, cancelled: true };
  }
  if (result.type !== 'success' || !result.url) {
    return { ok: false, error: classifyAuthError(new Error('OAuth session did not return a redirect URL')) };
  }

  const tokens = parseTokensFromRedirectUrl(result.url);
  if (!tokens) {
    return { ok: false, error: classifyAuthError(new Error('OAuth redirect did not contain a session')) };
  }

  const { error: setSessionError } = await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });

  if (setSessionError) {
    return { ok: false, error: classifyAuthError(setSessionError) };
  }

  return { ok: true };
}

function parseTokensFromRedirectUrl(url: string): { accessToken: string; refreshToken: string } | null {
  // Supabase returns tokens in the URL fragment: #access_token=...&refresh_token=...
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return null;

  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;

  return { accessToken, refreshToken };
}
