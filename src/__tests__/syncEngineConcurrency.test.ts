/**
 * Regression test for a concurrency bug found during Phase 2 gate review
 * (docs/architecture/phase-2-module-c.md §2.6 / docs/api/save-workout-session-v1.md
 * §2.6 both require the mobile sync engine to guarantee "a single
 * save_workout_session_v1 call in flight at a time" for the accepted-risk
 * posture on cross-call PR-achievement duplication to hold).
 *
 * `runSync` in src/sync/syncEngine.ts guards re-entrancy with a module-level
 * `syncing` boolean, but the guard is checked BEFORE an `await` and only SET
 * after it:
 *
 *   if (!currentUserId || syncing) return;
 *   const net = await Network.getNetworkStateAsync();   // <-- yields here
 *   ...
 *   syncing = true;                                      // <-- set AFTER the yield
 *
 * Two overlapping calls to `runSync` (e.g. the AppState 'active' listener and
 * the network-reconnect listener firing close together, or a `post-write`
 * call racing a `reconnect` call) can both pass the `if (syncing) return;`
 * check before either sets `syncing = true`, because both checks run before
 * either call reaches its first `await`. This test proves that TWO
 * overlapping `runSync` invocations both execute their full push/pull body
 * concurrently, in violation of the single-in-flight guarantee the RPC
 * contract depends on.
 *
 * Fixed by setting `syncing = true` synchronously, before the first `await`
 * (see `runSync` in `syncEngine.ts`). With the race closed, the second
 * overlapping call now correctly no-ops via the pre-existing `if (syncing)
 * return;` guard rather than running at all — it is dropped, not queued to
 * run after the first call finishes. That's the intended semantics here,
 * not a gap: `runSync`'s own doc comment already frames every trigger as
 * "sync opportunistically, not a persistent-connection assumption"
 * (mobile-architecture-standards) — whatever data prompted the dropped
 * call's trigger is still covered by the first call's own fresh
 * `getUnsynced`/`getDirtySets` reads if it landed before those ran, and by
 * the next trigger (another foreground/reconnect/post-write) otherwise.
 */

import * as Network from 'expo-network';
import { runSync, setSyncUser } from '../sync/syncEngine';

// All mocked async boundaries below resolve via a real macrotask
// (`setTimeout(fn, 0)`), not a microtask (`Promise.resolve()`) — this models
// genuine I/O latency (network/DB) realistically enough that two concurrent
// `runSync` call chains actually interleave turn-by-turn, the same way two
// real in-flight network requests would. A microtask-only mock would let one
// call's entire chain drain to completion before the event loop ever revisits
// the other call, hiding the overlap this test exists to catch.
const mockResolveSoon = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 0));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../lib/supabase', () => {
  const mockResolveSoonLocal = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 0));
  const chain: Record<string, unknown> = {};
  const builder = () => chain;
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.maybeSingle = jest.fn(() => mockResolveSoonLocal({ data: null, error: null }));
  chain.single = jest.fn(() => mockResolveSoonLocal({ data: null, error: null }));
  chain.upsert = jest.fn(() => chain);
  chain.update = jest.fn(() => chain);
  chain.insert = jest.fn(() => mockResolveSoonLocal({ data: null, error: null }));
  return {
    supabase: {
      from: jest.fn(builder),
      rpc: jest.fn(() => mockResolveSoonLocal({ data: null, error: null })),
    },
  };
});
jest.mock('../db/repositories/profileRepository', () => ({
  profileRepository: {
    getUnsynced: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 0))),
    reconcileFromServer: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve(undefined), 0))),
  },
}));
jest.mock('../db/repositories/profileHealthRepository', () => ({
  profileHealthRepository: {
    getUnsynced: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 0))),
  },
}));
jest.mock('../db/repositories/consentRepository', () => ({
  consentRepository: {
    getUnsynced: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 0))),
    reconcileFromServer: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve(undefined), 0))),
  },
}));
jest.mock('../db/repositories/wearableLinksRepository', () => ({
  wearableLinksRepository: {
    getUnsynced: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 0))),
  },
}));

// Instrumented stand-in for the gate-critical push path: records how many
// calls are IN FLIGHT at once so the test can detect overlap directly,
// instead of inferring it indirectly. Prefixed `mock*` — required by Jest's
// module-factory scoping rule (out-of-scope variables referenced inside a
// `jest.mock()` factory must be prefixed `mock`, case-insensitive).
let mockConcurrentInFlight = 0;
let mockMaxConcurrentObserved = 0;
const mockPushWorkoutSessions = jest.fn(async () => {
  mockConcurrentInFlight += 1;
  mockMaxConcurrentObserved = Math.max(mockMaxConcurrentObserved, mockConcurrentInFlight);
  // Two real macrotask turns — mirrors the real function's own sequential
  // `for` loop awaiting a network RPC (a genuine I/O round-trip, not an
  // instantly-resolving microtask).
  await mockResolveSoon(undefined);
  await mockResolveSoon(undefined);
  mockConcurrentInFlight -= 1;
});

jest.mock('../sync/activitySync', () => ({
  pullActivities: jest.fn(() => mockResolveSoon(undefined)),
  pullActivityAchievements: jest.fn(() => mockResolveSoon(undefined)),
  pullActivityRoutes: jest.fn(() => mockResolveSoon(undefined)),
  pullPersonalRecords: jest.fn(() => mockResolveSoon(undefined)),
  pushActivities: jest.fn(() => mockResolveSoon(undefined)),
  refreshActivityTypesIfNeeded: jest.fn(() => mockResolveSoon(undefined)),
}));

jest.mock('../sync/workoutSync', () => ({
  pullBodyMeasurements: jest.fn(() => mockResolveSoon(undefined)),
  pullBodyweightLogs: jest.fn(() => mockResolveSoon(undefined)),
  pullCustomExercises: jest.fn(() => mockResolveSoon(undefined)),
  pullPrograms: jest.fn(() => mockResolveSoon(undefined)),
  pullProgressPhotos: jest.fn(() => mockResolveSoon(undefined)),
  pullStrengthAchievements: jest.fn(() => mockResolveSoon(undefined)),
  pullStrengthRecords: jest.fn(() => mockResolveSoon(undefined)),
  pullWorkoutSessions: jest.fn(() => mockResolveSoon(undefined)),
  pullWorkoutTemplates: jest.fn(() => mockResolveSoon(undefined)),
  pushBodyMeasurements: jest.fn(() => mockResolveSoon(undefined)),
  pushBodyweightLogs: jest.fn(() => mockResolveSoon(undefined)),
  pushCustomExercises: jest.fn(() => mockResolveSoon(undefined)),
  pushPrograms: jest.fn(() => mockResolveSoon(undefined)),
  pushProgressPhotos: jest.fn(() => mockResolveSoon(undefined)),
  pushWorkoutSessions: jest.fn((_userId: string) => mockPushWorkoutSessions()),
  pushWorkoutTemplates: jest.fn(() => mockResolveSoon(undefined)),
  refreshExerciseLibraryIfStale: jest.fn(() => mockResolveSoon(undefined)),
}));

describe('runSync single-in-flight guard (RPC §2.6 sequencing requirement)', () => {
  beforeEach(() => {
    mockConcurrentInFlight = 0;
    mockMaxConcurrentObserved = 0;
    jest.clearAllMocks();
    (Network.getNetworkStateAsync as jest.Mock).mockImplementation(() =>
      mockResolveSoon({ isConnected: true, isInternetReachable: true })
    );
    setSyncUser('user-under-test');
  });

  it('never runs pushWorkoutSessions from two overlapping runSync calls at the same time', async () => {
    // Two callers fire runSync back-to-back, synchronously — exactly what
    // happens if the AppState 'active' listener and the network-reconnect
    // listener both fire in the same tick (a realistic real-device scenario:
    // unlocking the phone at the exact moment it reconnects to wifi).
    const first = runSync('foreground');
    const second = runSync('reconnect');

    await Promise.all([first, second]);

    expect(mockMaxConcurrentObserved).toBe(1);
    // The second call is correctly dropped by the guard, not queued to run
    // after the first — see the file-header comment for why that's the
    // intended fix, not a remaining gap.
    expect(mockPushWorkoutSessions).toHaveBeenCalledTimes(1);
  });
});
