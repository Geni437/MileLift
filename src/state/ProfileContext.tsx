import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useAuth } from './AuthContext';
import { profileRepository } from '../db/repositories/profileRepository';
import { profileHealthRepository } from '../db/repositories/profileHealthRepository';
import { localPreferencesRepository, type LocalPreferences } from '../db/repositories/localPreferencesRepository';
import { runSync } from '../sync/syncEngine';
import type {
  LocalProfile,
  LocalProfileHealth,
  ProfileHealthWritableFields,
  ProfileWritableFields,
} from '../db/types';

type LoadState = 'loading' | 'empty' | 'ready' | 'error';

type ProfileContextValue = {
  loadState: LoadState;
  loadError: string | null;
  profile: LocalProfile | null;
  profileHealth: LocalProfileHealth | null;
  preferences: LocalPreferences | null;
  refresh: () => Promise<void>;
  updateProfile: (fields: ProfileWritableFields) => Promise<void>;
  updateProfileHealth: (fields: ProfileHealthWritableFields) => Promise<void>;
  setTrainingBalance: (runShare: number) => Promise<void>;
  completeOnboarding: () => Promise<void>;
};

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<LocalProfile | null>(null);
  const [profileHealth, setProfileHealth] = useState<LocalProfileHealth | null>(null);
  const [preferences, setPreferences] = useState<LocalPreferences | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setLoadState('empty');
      setProfile(null);
      setProfileHealth(null);
      setPreferences(null);
      return;
    }
    setLoadState('loading');
    setLoadError(null);
    try {
      const [p, h, prefs] = await Promise.all([
        profileRepository.getLocal(userId),
        profileHealthRepository.getLocal(userId),
        localPreferencesRepository.get(userId),
      ]);
      setProfile(p);
      setProfileHealth(h);
      setPreferences(prefs);
      setLoadState(p ? 'ready' : 'empty');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your profile.');
      setLoadState('error');
    }
  }, [userId]);

  useEffect(() => {
    // react-hooks/set-state-in-effect: `load` synchronizes local profile/
    // health/preferences state with the local SQLite store whenever `userId`
    // changes — the legitimate "synchronize with an external system" case,
    // not a React-Compiler hazard (this project doesn't use the compiler).
    // See the longer note in app/(onboarding)/profile-setup.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const updateProfile = useCallback(
    async (fields: ProfileWritableFields) => {
      if (!userId) return;
      const next = await profileRepository.applyLocalEdit(userId, fields);
      setProfile(next);
      void runSync('post-write').then(load);
    },
    [userId, load]
  );

  const updateProfileHealth = useCallback(
    async (fields: ProfileHealthWritableFields) => {
      if (!userId) return;
      const next = await profileHealthRepository.applyLocalEdit(userId, fields);
      setProfileHealth(next);
      void runSync('post-write').then(load);
    },
    [userId, load]
  );

  const setTrainingBalance = useCallback(
    async (runShare: number) => {
      if (!userId) return;
      await localPreferencesRepository.setTrainingBalance(userId, runShare);
      setPreferences((prev) => (prev ? { ...prev, trainingBalanceRun: runShare } : prev));
    },
    [userId]
  );

  const completeOnboarding = useCallback(async () => {
    if (!userId) return;
    await localPreferencesRepository.markOnboardingComplete(userId);
    await load();
  }, [userId, load]);

  const value = useMemo<ProfileContextValue>(
    () => ({
      loadState,
      loadError,
      profile,
      profileHealth,
      preferences,
      refresh: load,
      updateProfile,
      updateProfileHealth,
      setTrainingBalance,
      completeOnboarding,
    }),
    [
      loadState,
      loadError,
      profile,
      profileHealth,
      preferences,
      load,
      updateProfile,
      updateProfileHealth,
      setTrainingBalance,
      completeOnboarding,
    ]
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within a ProfileProvider');
  return ctx;
}
