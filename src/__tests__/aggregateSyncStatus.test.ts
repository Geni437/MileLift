import { aggregateSyncStatus } from '../lib/syncStatus';
import type { SyncStatus } from '../db/types';

function rowsOf(...statuses: SyncStatus[]) {
  return statuses.map((syncStatus) => ({ syncStatus }));
}

describe('aggregateSyncStatus', () => {
  it('returns null for an empty set — nothing logged, no pill', () => {
    expect(aggregateSyncStatus([])).toBeNull();
  });

  it('returns synced when every row is synced', () => {
    expect(aggregateSyncStatus(rowsOf('synced', 'synced'))).toBe('synced');
  });

  it('surfaces a single failed row over everything else — the worst state wins', () => {
    expect(aggregateSyncStatus(rowsOf('synced', 'failed', 'pending', 'local'))).toBe('failed');
  });

  it('surfaces pending over local and synced when nothing has failed', () => {
    expect(aggregateSyncStatus(rowsOf('synced', 'local', 'pending'))).toBe('pending');
  });

  it('surfaces local when nothing is failed or pending', () => {
    expect(aggregateSyncStatus(rowsOf('synced', 'local'))).toBe('local');
  });

  it('is order-independent — priority, not first-match', () => {
    expect(aggregateSyncStatus(rowsOf('local', 'failed', 'synced'))).toBe('failed');
    expect(aggregateSyncStatus(rowsOf('pending', 'local'))).toBe('pending');
  });
});
