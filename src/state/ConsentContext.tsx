import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useAuth } from './AuthContext';
import { consentRepository } from '../db/repositories/consentRepository';
import { runSync } from '../sync/syncEngine';
import { generateUuidV4 } from '../lib/uuid';
import { env } from '../lib/env';
import { locationPermission } from '../permissions/locationPermission';
import { cameraPermission } from '../permissions/cameraPermission';
import type { OsPermissionStatus } from '../permissions/types';
import type { ConsentCategory, LocalConsent } from '../db/types';

export type CategoryState = {
  consent: LocalConsent | null; // active (non-revoked) consent row, if any
  osStatus: OsPermissionStatus | 'not_applicable'; // 'not_applicable' for health — no native permission in Phase 0
};

type ConsentContextValue = {
  loading: boolean;
  categories: Record<ConsentCategory, CategoryState>;
  refresh: () => Promise<void>;
  /** Runs the OS permission request (where applicable) THEN writes the consent grant. Call only after the priming sheet's "Allow". */
  grant: (category: ConsentCategory) => Promise<{ ok: true; osStatus: OsPermissionStatus | 'not_applicable' } | { ok: false; reason: string }>;
  /** "Not now" on the priming sheet — records nothing (declining is not itself consent history; see design note in body). */
  decline: (category: ConsentCategory) => void;
  revoke: (category: ConsentCategory) => Promise<void>;
  refreshOsStatus: (category: ConsentCategory) => Promise<void>;
};

const ConsentContext = createContext<ConsentContextValue | null>(null);

const EMPTY_CATEGORY: CategoryState = { consent: null, osStatus: 'undetermined' };

export function ConsentProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<Record<ConsentCategory, CategoryState>>({
    health: { consent: null, osStatus: 'not_applicable' },
    location: EMPTY_CATEGORY,
    camera: EMPTY_CATEGORY,
  });

  const refresh = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [health, location, camera, locationOs, cameraOs] = await Promise.all([
      consentRepository.getActive(userId, 'health'),
      consentRepository.getActive(userId, 'location'),
      consentRepository.getActive(userId, 'camera'),
      locationPermission.getStatus(),
      cameraPermission.getStatus(),
    ]);
    setCategories({
      health: { consent: health, osStatus: 'not_applicable' },
      location: { consent: location, osStatus: locationOs },
      camera: { consent: camera, osStatus: cameraOs },
    });
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    // react-hooks/set-state-in-effect: `refresh` synchronizes local consent
    // state with two external systems (local SQLite + OS permission status)
    // on mount and whenever `userId` changes — the documented legitimate use
    // of an effect, not a React-Compiler hazard (this project doesn't use
    // the compiler). See the longer note in app/(onboarding)/profile-setup.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const refreshOsStatus = useCallback(async (category: ConsentCategory) => {
    if (category === 'health') return; // no native permission surface yet — see healthPermission note below
    const status = category === 'location' ? await locationPermission.getStatus() : await cameraPermission.getStatus();
    setCategories((prev) => ({ ...prev, [category]: { ...prev[category], osStatus: status } }));
  }, []);

  const grant = useCallback(
    async (category: ConsentCategory) => {
      if (!userId) return { ok: false as const, reason: 'Not signed in.' };

      let osStatus: OsPermissionStatus | 'not_applicable' = 'not_applicable';

      if (category === 'location') {
        osStatus = await locationPermission.request();
      } else if (category === 'camera') {
        osStatus = await cameraPermission.request();
      }
      // category === 'health': Phase 0 has no HealthKit/Health Connect native
      // module wired up (no wearable-sync feature exists yet — that's
      // CORE-03, Phase 1). We deliberately do NOT fire a native permission
      // request for a capability the app doesn't use yet
      // (health-data-compliance: request only what the current feature
      // needs). We still record the user's consent decision now so Phase 1
      // can honor it without re-prompting for the same purpose text.

      if ((category === 'location' || category === 'camera') && osStatus === 'denied') {
        // User allowed in-app but the OS prompt itself was declined — this
        // is the "declined" degrade-gracefully path, not a grant. Don't
        // write a consent row for a permission we don't actually have.
        setCategories((prev) => ({ ...prev, [category]: { ...prev[category], osStatus } }));
        return { ok: false as const, reason: 'os_denied' };
      }
      if ((category === 'location' || category === 'camera') && osStatus === 'blocked') {
        setCategories((prev) => ({ ...prev, [category]: { ...prev[category], osStatus } }));
        return { ok: false as const, reason: 'os_blocked' };
      }

      const id = generateUuidV4();
      await consentRepository.grant({ id, userId, category, purposeVersion: env.consentPurposeVersion });
      void runSync('post-write').then(refresh);
      await refresh();
      return { ok: true as const, osStatus };
    },
    [userId, refresh]
  );

  const decline = useCallback((_category: ConsentCategory) => {
    // Declining "Not now" is a first-class UX outcome (screens-phase-0.md
    // §E rule 4) but is NOT itself written as a consent row — there is
    // nothing to revoke later because nothing was ever granted. The
    // triggering feature's own declined-state UI (§E "Declined" states)
    // handles the graceful degrade; this function exists so callers have an
    // explicit, named action to call instead of silently doing nothing.
  }, []);

  const revoke = useCallback(
    async (category: ConsentCategory) => {
      if (!userId) return;
      const active = categories[category].consent;
      if (!active) return;
      await consentRepository.revoke(active.id);
      void runSync('post-write').then(refresh);
      await refresh();
    },
    [userId, categories, refresh]
  );

  const value = useMemo<ConsentContextValue>(
    () => ({ loading, categories, refresh, grant, decline, revoke, refreshOsStatus }),
    [loading, categories, refresh, grant, decline, revoke, refreshOsStatus]
  );

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

export function useConsent(): ConsentContextValue {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error('useConsent must be used within a ConsentProvider');
  return ctx;
}
