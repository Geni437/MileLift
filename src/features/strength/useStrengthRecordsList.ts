import { useCallback, useEffect, useMemo, useState } from 'react';

import { strengthRecordsRepository } from '../../db/repositories/strengthRecordsRepository';
import { exercisesRepository } from '../../db/repositories/exercisesRepository';
import { customExercisesRepository } from '../../db/repositories/customExercisesRepository';
import { runSync } from '../../sync/syncEngine';
import type { LocalStrengthRecord } from '../../db/types';

export type LoadState = 'loading' | 'empty' | 'ready' | 'error';

export type StrengthRecordGroup = {
  exerciseRef: string;
  exerciseName: string;
  records: LocalStrengthRecord[];
};

/** The Strength Records segment (CORE-15) — grouped by exercise, mirroring `usePersonalRecords`. */
export function useStrengthRecordsList(userId: string | null) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [groups, setGroups] = useState<StrengthRecordGroup[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!userId) {
      setLoadState('empty');
      return;
    }
    setLoadState('loading');
    try {
      const records = await strengthRecordsRepository.getAllForUser(userId);
      const byRef = new Map<string, LocalStrengthRecord[]>();
      for (const record of records) {
        const ref = record.exerciseId ?? `custom:${record.customExerciseId}`;
        const list = byRef.get(ref) ?? [];
        list.push(record);
        byRef.set(ref, list);
      }

      const result: StrengthRecordGroup[] = [];
      for (const [ref, recordList] of byRef) {
        const first = recordList[0]!;
        const name = first.exerciseId
          ? (await exercisesRepository.getById(first.exerciseId))?.name ?? 'Exercise'
          : (await customExercisesRepository.getById(first.customExerciseId!))?.name ?? 'Custom exercise';
        result.push({ exerciseRef: ref, exerciseName: name, records: recordList });
      }
      result.sort((a, b) => a.exerciseName.localeCompare(b.exerciseName));

      setGroups(result);
      setLoadState(result.length === 0 ? 'empty' : 'ready');
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

  return useMemo(() => ({ loadState, groups, refreshing, refresh }), [loadState, groups, refreshing, refresh]);
}
