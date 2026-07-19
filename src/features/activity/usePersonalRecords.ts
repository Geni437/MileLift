import { useCallback, useEffect, useMemo, useState } from 'react';

import { personalRecordsRepository } from '../../db/repositories/personalRecordsRepository';
import { activityTypesRepository } from '../../db/repositories/activityTypesRepository';
import { runSync } from '../../sync/syncEngine';
import type { ActivityType, LocalPersonalRecord } from '../../db/types';

export type RecordGroup = { activityType: ActivityType; records: LocalPersonalRecord[] };
export type RecordsLoadState = 'loading' | 'empty' | 'ready' | 'error';

/** Records screen (Activity → Records segment, CORE-04) — cumulative "current best" per type. */
export function usePersonalRecords(userId: string | null) {
  const [loadState, setLoadState] = useState<RecordsLoadState>('loading');
  const [groups, setGroups] = useState<RecordGroup[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!userId) {
      setLoadState('empty');
      return;
    }
    setLoadState('loading');
    try {
      const [records, types] = await Promise.all([personalRecordsRepository.getAllForUser(userId), activityTypesRepository.getAll()]);
      const typeMap = new Map(types.map((t) => [t.code, t]));

      const byType = new Map<string, LocalPersonalRecord[]>();
      for (const record of records) {
        const list = byType.get(record.activityTypeCode) ?? [];
        list.push(record);
        byType.set(record.activityTypeCode, list);
      }

      const nextGroups: RecordGroup[] = Array.from(byType.entries())
        .map(([code, recs]) => {
          const activityType = typeMap.get(code);
          if (!activityType) return null;
          return { activityType, records: recs };
        })
        .filter((g): g is RecordGroup => g !== null)
        .sort((a, b) => a.activityType.sortOrder - b.activityType.sortOrder);

      setGroups(nextGroups);
      setLoadState(nextGroups.length === 0 ? 'empty' : 'ready');
    } catch {
      setLoadState('error');
    }
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await runSync('manual');
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const totalRecordCount = useMemo(() => groups.reduce((sum, g) => sum + g.records.length, 0), [groups]);

  return { loadState, groups, refreshing, refresh, totalRecordCount };
}
