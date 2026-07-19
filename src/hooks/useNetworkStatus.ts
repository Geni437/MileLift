import { useNetworkState } from 'expo-network';

/**
 * Simple online/offline signal for InlineBanner-style unhappy-path copy
 * (screens-phase-0.md §B/§C "You're offline" states). `isInternetReachable`
 * can be `null` transiently on some platforms right after launch — treat
 * `null` as "assume online" so we don't flash a false offline banner on cold
 * start; a real offline state will resolve to `false` quickly.
 */
export function useNetworkStatus(): { isOnline: boolean } {
  const state = useNetworkState();
  const isOnline = state.isConnected !== false && state.isInternetReachable !== false;
  return { isOnline };
}
