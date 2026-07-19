import { getDb } from '../client';

export type RecordingHeroMetric = 'duration' | 'distance' | 'pace';

export type LocalPreferences = {
  userId: string;
  trainingBalanceRun: number; // 0-100, "run" share; "lift" share = 100 - this
  onboardingCompletedAt: string | null;
  /** Which metric occupies the recording screen's hero slot — remembered locally per design doc CORE-01 ("The choice is remembered locally"). */
  recordingHeroMetric: RecordingHeroMetric;
};

type Row = {
  user_id: string;
  training_balance_run: number;
  onboarding_completed_at: string | null;
  recording_hero_metric: string;
};

/**
 * FLAGGED ASSUMPTION (see task report): the onboarding "training balance"
 * slider (docs/design/screens-phase-0.md §D Step 2, and Profile §F.2) has no
 * corresponding column in the live `profiles` schema
 * (supabase/migrations/20260718210814_create_profiles.sql only defines
 * username/display_name/avatar_url/unit_weight/unit_distance/
 * default_timezone/deletion_requested_at). Rather than inventing a server
 * column mobile-builder isn't scoped to add, or silently dropping a
 * specified interaction, this value is stored device-local-only: it's real,
 * durable (survives app restarts) local storage, not mock data — it just
 * doesn't sync across devices yet. This needs `architect`/`db-engineer` to
 * add a `training_balance_run` (or similar) column to `profiles` in a
 * follow-up migration before this can be treated as a synced preference.
 */
export const localPreferencesRepository = {
  async get(userId: string): Promise<LocalPreferences> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM local_preferences WHERE user_id = ?', [userId]);
    if (!row) {
      return { userId, trainingBalanceRun: 50, onboardingCompletedAt: null, recordingHeroMetric: 'duration' };
    }
    return {
      userId: row.user_id,
      trainingBalanceRun: row.training_balance_run,
      onboardingCompletedAt: row.onboarding_completed_at,
      recordingHeroMetric: (row.recording_hero_metric as RecordingHeroMetric) ?? 'duration',
    };
  },

  async setRecordingHeroMetric(userId: string, metric: RecordingHeroMetric): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO local_preferences (user_id, training_balance_run, onboarding_completed_at, recording_hero_metric, updated_at)
       VALUES (?, 50, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET recording_hero_metric = excluded.recording_hero_metric, updated_at = excluded.updated_at`,
      [userId, metric, now]
    );
  },

  async setTrainingBalance(userId: string, trainingBalanceRun: number): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    const clamped = Math.max(0, Math.min(100, Math.round(trainingBalanceRun)));
    await db.runAsync(
      `INSERT INTO local_preferences (user_id, training_balance_run, onboarding_completed_at, updated_at)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT(user_id) DO UPDATE SET training_balance_run = excluded.training_balance_run, updated_at = excluded.updated_at`,
      [userId, clamped, now]
    );
  },

  async markOnboardingComplete(userId: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO local_preferences (user_id, training_balance_run, onboarding_completed_at, updated_at)
       VALUES (?, 50, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET onboarding_completed_at = excluded.onboarding_completed_at, updated_at = excluded.updated_at`,
      [userId, now, now]
    );
  },
};
