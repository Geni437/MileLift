import type { SyncStatus } from '../db/types';

/**
 * The "worst" (most attention-worthy) sync state across a set of rows that
 * share one visible summary — e.g. the water day-total's `SyncStatusPill`
 * (design doc §CORE-Sync: "the water day-total" is one of the required
 * pill call-sites, even though it aggregates many individual
 * `water_intake` writes into a single total). Priority mirrors
 * `SyncStatusPill`'s own state machine, worst-first: a single `failed` row
 * needs attention over everything else; `pending` needs attention before a
 * merely-`local` (not-yet-queued) row; `local` still needs to be shown as
 * distinct from a fully `synced` day. `null` means nothing logged at all,
 * so no pill should render.
 */
export function aggregateSyncStatus(rows: { syncStatus: SyncStatus }[]): SyncStatus | null {
  if (rows.length === 0) return null;
  if (rows.some((r) => r.syncStatus === 'failed')) return 'failed';
  if (rows.some((r) => r.syncStatus === 'pending')) return 'pending';
  if (rows.some((r) => r.syncStatus === 'local')) return 'local';
  return 'synced';
}
