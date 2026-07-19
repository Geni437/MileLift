import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Linking from 'expo-linking';
import type { Session } from '@supabase/supabase-js';

import { supabase } from '../lib/supabase';
import { classifyAuthError, type AuthErrorResult } from '../lib/authErrors';
import { profileRepository, type ProfileRow } from '../db/repositories/profileRepository';
import { attachSyncTriggers, runSync, setSyncUser } from '../sync/syncEngine';

type AuthResult = { ok: true } | { ok: false; error: AuthErrorResult };
type SignUpResult = { ok: true; requiresEmailConfirmation: boolean } | { ok: false; error: AuthErrorResult };

type AuthContextValue = {
  /** True until the initial session bootstrap (secure-storage read) completes. */
  isBootstrapping: boolean;
  session: Session | null;
  userId: string | null;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  resendVerificationEmail: (email: string) => Promise<AuthResult>;
  requestPasswordReset: (email: string) => Promise<AuthResult>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const detachSyncTriggers = useRef<() => void>(() => {});

  useEffect(() => {
    let mounted = true;

    // Reads from secure storage; only hits the network if the stored access
    // token is already expired and needs a refresh. This is what makes
    // "already signed in, opens to local data offline" work
    // (screens-phase-0.md §C offline state).
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setIsBootstrapping(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
    });

    detachSyncTriggers.current = attachSyncTriggers();

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
      detachSyncTriggers.current();
    };
  }, []);

  const userId = session?.user?.id ?? null;

  useEffect(() => {
    setSyncUser(userId);
    if (!userId) return;

    // Seed the local profile mirror from the row the `handle_new_user`
    // trigger already created server-side, then run a sync pass. This is
    // best-effort: if we're offline right after a fresh login on a new
    // device, the Profile screen's own loading/empty state (per
    // screens-phase-0.md §F) covers the gap until connectivity returns.
    (async () => {
      const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle<ProfileRow>();
      if (data) {
        await profileRepository.seedIfMissing(data);
      }
      void runSync('startup');
    })();
  }, [userId]);

  const signUp = useCallback(async (email: string, password: string): Promise<SignUpResult> => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { ok: false, error: classifyAuthError(error) };
    // If email confirmation is required by the project's auth settings,
    // signUp succeeds but returns no session — the user must confirm before
    // they can sign in. Surface this as a distinct outcome rather than
    // silently treating "no error" as "signed in."
    return { ok: true, requiresEmailConfirmation: !data.session };
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: classifyAuthError(error) };
    return { ok: true };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const resendVerificationEmail = useCallback(async (email: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.resend({ type: 'signup', email });
    if (error) return { ok: false, error: classifyAuthError(error) };
    return { ok: true };
  }, []);

  /**
   * Sends a real password-reset email via Supabase. NOTE (flagged, not
   * silently assumed complete): this covers "request a reset link" only.
   * The corresponding in-app "set a new password from the recovery deep
   * link" screen is not built in Phase 0 — the task brief scoped this
   * screen set to sign-up/login/onboarding/consent/profile, and a full
   * recovery-session deep-link handler is a meaningfully separate flow.
   * Today the emailed link falls back to Supabase's own hosted recovery
   * page. Follow-up: build app/(auth)/reset-password.tsx wired to the
   * `recovery` deep link before relying on this for a real user.
   */
  const requestPasswordReset = useCallback(async (email: string): Promise<AuthResult> => {
    const redirectTo = Linking.createURL('auth/reset-password');
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) return { ok: false, error: classifyAuthError(error) };
    return { ok: true };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      isBootstrapping,
      session,
      userId,
      signUp,
      signIn,
      signOut,
      resendVerificationEmail,
      requestPasswordReset,
    }),
    [isBootstrapping, session, userId, signUp, signIn, signOut, resendVerificationEmail, requestPasswordReset]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
