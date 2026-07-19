import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import { createClient } from '@supabase/supabase-js';

import { env } from './env';
import { secureSessionStorage } from './secureSessionStorage';

/**
 * The single Supabase client for the app. Auth session persistence goes
 * through `secureSessionStorage` (Keychain/Keystore-backed), never a plain
 * AsyncStorage default.
 *
 * NOTE ON OFFLINE-FIRST: this client is used for auth (sign-up/sign-in — the
 * one thing that genuinely cannot work offline, per screens-phase-0.md §B)
 * and for the sync engine's push/pull of already-locally-committed writes
 * (architecture §3). Screens must NOT call `supabase.from(...)` directly to
 * render UI — they read the local SQLite store via the repositories in
 * `src/db/repositories`, which is the offline-first source of truth
 * (mobile-architecture-standards: "never let a UI component read/write
 * server cache state directly without going through the sync layer").
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    storage: secureSessionStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Supabase's client-side auto-refresh timer only ticks while JS is running;
// on native it must be told explicitly when the app returns to the
// foreground/background so refresh doesn't silently stall while backgrounded
// (this is Supabase's own documented Expo/RN integration requirement, not an
// optional nicety — a stale-refresh session would surface as mysterious
// random logouts).
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});
