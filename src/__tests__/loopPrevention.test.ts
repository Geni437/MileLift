import { filterImportableRecords, shouldSkipInboundRecord } from '../features/health-connect/loopPrevention';

describe('shouldSkipInboundRecord', () => {
  it('skips a record MileLift itself wrote back', () => {
    const outbound = new Set(['abc-123']);
    expect(shouldSkipInboundRecord({ recordId: 'abc-123' }, outbound)).toBe(true);
  });

  it('skips a record whose data origin is MileLift, even without a link row yet', () => {
    const outbound = new Set<string>();
    expect(
      shouldSkipInboundRecord({ recordId: 'not-linked-yet', externalDataOriginPackageName: 'com.milelift.app' }, outbound)
    ).toBe(true);
  });

  it('does not skip a genuine third-party record (e.g. a real Garmin/Wear OS session)', () => {
    const outbound = new Set(['abc-123']);
    expect(
      shouldSkipInboundRecord({ recordId: 'garmin-session-1', externalDataOriginPackageName: 'com.garmin.android.apps.connectmobile' }, outbound)
    ).toBe(false);
  });
});

describe('filterImportableRecords', () => {
  it('drops our own outbound writes and already-imported records, keeps the rest', () => {
    const records = [
      { recordId: 'own-writeback' },
      { recordId: 'already-imported' },
      { recordId: 'new-watch-run' },
    ];
    const outbound = new Set(['own-writeback']);
    const alreadyImported = new Set(['already-imported']);

    const result = filterImportableRecords(records, outbound, alreadyImported);
    expect(result.map((r) => r.recordId)).toEqual(['new-watch-run']);
  });

  it('returns an empty array (not a throw) when nothing is importable', () => {
    const records = [{ recordId: 'own-writeback' }];
    expect(filterImportableRecords(records, new Set(['own-writeback']), new Set())).toEqual([]);
  });
});
