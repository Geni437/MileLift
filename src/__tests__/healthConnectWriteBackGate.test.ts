/**
 * Round-A M2 regression coverage: Health Connect write-back must be gated
 * on an active `health` consent row on every sync, not just at initial
 * connect time — write-back is entirely on-device, so this check is the
 * only enforcement point (no server/RLS backstop exists for it, unlike
 * stored HR data). See useHealthConnect.ts's `writeBackOutbound` and
 * ConsentContext.tsx's `revoke`.
 */
import { writeBackOutbound } from '../features/health-connect/useHealthConnect';
import { consentRepository } from '../db/repositories/consentRepository';
import { activityRepository } from '../db/repositories/activityRepository';
import { wearableLinksRepository } from '../db/repositories/wearableLinksRepository';
import { healthConnectClient } from '../features/health-connect/healthConnectClient';
import { getDb } from '../db/client';
import type { LocalActivity, LocalConsent } from '../db/types';

// `useHealthConnect.ts` transitively imports `src/lib/supabase.ts` ->
// `src/lib/env.ts`, which reads `Constants.expoConfig.extra` and throws
// (by design — production-standards "fail loudly at the boundary") outside
// a real Expo runtime with app.config.ts's env vars loaded. This suite
// otherwise touches no native module (per jest.setup.js's documented
// pure-business-logic scope), so rather than widening that global setup for
// one test file, stub just enough of `expo-constants` here to satisfy
// `env.ts`'s required fields. (`jest.mock` calls are hoisted above these
// imports by babel-plugin-jest-hoist regardless of source order, so this is
// still safe.)
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'test-anon-key',
        consentPurposeVersion: 'test-1',
        googleMapsApiKeyConfigured: false,
      },
    },
  },
}));

jest.mock('../db/client', () => ({
  getDb: jest.fn(),
}));
jest.mock('../db/repositories/consentRepository', () => ({
  consentRepository: { getActive: jest.fn() },
}));
jest.mock('../db/repositories/activityRepository', () => ({
  activityRepository: { getManualConfirmedForUser: jest.fn() },
}));
jest.mock('../db/repositories/wearableLinksRepository', () => ({
  wearableLinksRepository: {
    hasOutboundForActivity: jest.fn(),
    recordLink: jest.fn(),
  },
}));
jest.mock('../features/health-connect/healthConnectClient', () => ({
  healthConnectClient: { writeBackSession: jest.fn() },
}));

const mockGetDb = getDb as jest.MockedFunction<typeof getDb>;
const mockConsentGetActive = consentRepository.getActive as jest.MockedFunction<typeof consentRepository.getActive>;
const mockGetManualConfirmed = activityRepository.getManualConfirmedForUser as jest.MockedFunction<
  typeof activityRepository.getManualConfirmedForUser
>;
const mockHasOutbound = wearableLinksRepository.hasOutboundForActivity as jest.MockedFunction<
  typeof wearableLinksRepository.hasOutboundForActivity
>;
const mockRecordLink = wearableLinksRepository.recordLink as jest.MockedFunction<typeof wearableLinksRepository.recordLink>;
const mockWriteBackSession = healthConnectClient.writeBackSession as jest.MockedFunction<typeof healthConnectClient.writeBackSession>;

const USER_ID = 'user-1';

const ACTIVE_HEALTH_CONSENT: LocalConsent = {
  id: 'consent-1',
  userId: USER_ID,
  category: 'health',
  purposeVersion: '2026-07-19.1',
  grantedAt: '2026-07-01T00:00:00.000Z',
  revokedAt: null,
  syncStatus: 'synced',
  lastSyncError: null,
};

const ACTIVITY: LocalActivity = {
  id: 'activity-1',
  userId: USER_ID,
  activityTypeCode: 'run',
  activityTypeNameSnapshot: 'Run',
  title: 'Morning run',
  description: null,
  occurredAt: '2026-07-18T08:00:00.000Z',
  localDate: '2026-07-18',
  eventTimezone: 'UTC',
  durationSeconds: 1800,
  movingTimeSeconds: 1800,
  distanceM: 5000,
  unitDistanceSnapshot: 'km',
  elevationGainM: null,
  elevationLossM: null,
  averageSpeedMps: null,
  maxSpeedMps: null,
  averageHr: null,
  maxHr: null,
  hasGpsRoute: true,
  energyKcal: -300,
  caloriesSource: 'estimated',
  source: 'manual',
  visibility: 'private',
  clientCreatedAt: '2026-07-18T08:30:00.000Z',
  createdAt: '2026-07-18T08:30:00.000Z',
  updatedAt: '2026-07-18T08:30:00.000Z',
  deletedAt: null,
  kudosCount: 0,
  kudosCountFetchedAt: null,
  syncStatus: 'synced',
  lastSyncError: null,
};

describe('writeBackOutbound — M2 consent gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDb.mockResolvedValue({
      withTransactionAsync: async (fn: () => Promise<void>) => fn(),
    } as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  it('skips write-back entirely when there is no active health consent row', async () => {
    mockConsentGetActive.mockResolvedValue(null);

    await writeBackOutbound(USER_ID);

    expect(mockConsentGetActive).toHaveBeenCalledWith(USER_ID, 'health');
    // Must bail out before touching any candidate activities or writing
    // anything to Health Connect — a revoked-but-not-yet-reconciled
    // consent must not leak a write.
    expect(mockGetManualConfirmed).not.toHaveBeenCalled();
    expect(mockWriteBackSession).not.toHaveBeenCalled();
    expect(mockRecordLink).not.toHaveBeenCalled();
  });

  it('proceeds to write back candidates when health consent is active', async () => {
    mockConsentGetActive.mockResolvedValue(ACTIVE_HEALTH_CONSENT);
    mockGetManualConfirmed.mockResolvedValue([ACTIVITY]);
    mockHasOutbound.mockResolvedValue(false);
    mockWriteBackSession.mockResolvedValue('hc-record-1');

    await writeBackOutbound(USER_ID);

    expect(mockWriteBackSession).toHaveBeenCalledTimes(1);
    expect(mockWriteBackSession).toHaveBeenCalledWith(
      expect.objectContaining({ activityTypeCode: 'run', clientRecordId: 'activity-1' })
    );
    expect(mockRecordLink).toHaveBeenCalledWith(
      expect.objectContaining({ timelineEventId: 'activity-1', provider: 'health_connect', direction: 'outbound' })
    );
  });

  it('does not re-write an activity that already has an outbound link (idempotency)', async () => {
    mockConsentGetActive.mockResolvedValue(ACTIVE_HEALTH_CONSENT);
    mockGetManualConfirmed.mockResolvedValue([ACTIVITY]);
    mockHasOutbound.mockResolvedValue(true);

    await writeBackOutbound(USER_ID);

    expect(mockWriteBackSession).not.toHaveBeenCalled();
    expect(mockRecordLink).not.toHaveBeenCalled();
  });
});
