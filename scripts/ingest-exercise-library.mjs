#!/usr/bin/env node
/**
 * CORE-13 exercise-library ingestion job (Phase 2 Module C, architecture
 * §2.1/§2.2/§12 item 1).
 *
 * Merges two free/open sources into public.exercises + public.exercise_media,
 * per the approved plan (architecture §12 item 1):
 *   - Free Exercise DB (yuhonas/free-exercise-db) — public-domain (Unlicense),
 *     ~870 movements with muscle/equipment/mechanic metadata + static images.
 *     No attribution obligation. PREFERRED on a name+equipment conflict.
 *   - wger (wger.de) exercise database — CC-BY-SA 4.0 (attribution +
 *     share-alike). Supplement layer for additional coverage. Attribution is
 *     stored per-entry/per-media (exercises.attribution, exercise_media.
 *     attribution/license) so the obligation can actually be surfaced in-app
 *     (architecture §6/§2.1 — see this file's final summary output for the
 *     explicit "where does this render" flag).
 *
 * Dedup rule (architecture §2.1): deterministic merge by normalized
 * (name, equipment), Free Exercise DB preferred over wger on a genuine
 * conflict. ALSO dedupes against db-engineer's illustrative 12-row
 * `milelift_authored` seed (20260721100000_create_exercises.sql) — where a
 * real ingested row covers the same normalized (name, equipment) as a seed
 * row, the seed row is SUPERSEDED IN PLACE (same `id`, updated in place with
 * real sourced data + the new canonical slug) rather than creating a
 * duplicate row.
 *
 * This is a repeatable, idempotent job: re-running it upserts by slug
 * (`fedb-<id>` / `wger-<uuid>`, stable across re-ingests) and refreshes each
 * exercise's media set (delete-then-reinsert scoped to that exercise's
 * ingested-source media only, so a re-run never accumulates duplicate media
 * rows). Static images only, per architecture §2.2 — video backfill is
 * explicitly out of scope for the Phase 2 gate.
 *
 * Write path: service_role ONLY (exercises/exercise_media are service-role-
 * write per db-engineer's RLS — see 20260721100000_create_exercises.sql /
 * 20260721100100_create_exercise_media.sql). service_role bypasses RLS AND
 * is not subject to the column-scoped-grant restrictions that apply to the
 * `authenticated` role (those grants only ever named `authenticated`, never
 * `service_role`) — so a full-column upsert here is safe and does not
 * reproduce the §8.1 naive-upsert footgun that applies to `authenticated`-role
 * writes elsewhere in this project. This script still uses an explicit
 * column list on every write (not a whole-row spread) as a matter of
 * discipline/readability, not because the grant requires it.
 *
 * Required environment variables (never hardcoded, never committed):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage: node scripts/ingest-exercise-library.mjs
 * Exit code 0 on success, 1 on any unrecoverable error.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'FAIL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set in the environment. ' +
      'Refusing to guess/hardcode credentials. service_role is required (and safe) here because ' +
      'exercises/exercise_media are service-role-write-only reference tables, not user data.'
  );
  process.exit(1);
}

const FREE_EXERCISE_DB_URL =
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';
const FREE_EXERCISE_DB_IMAGE_BASE = 'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises';
const WGER_API_BASE = 'https://wger.de/api/v2';
const WGER_ENGLISH_LANGUAGE_ID = 2;
const WGER_PAGE_LIMIT = 100;

// --- muscle_group enum (public.muscle_group, 20260721100000) ---------------
const MUSCLE_GROUP_VALUES = new Set([
  'chest', 'back', 'lats', 'traps', 'shoulders', 'biceps', 'triceps', 'forearms',
  'abs', 'obliques', 'quadriceps', 'hamstrings', 'glutes', 'calves',
  'adductors', 'abductors', 'neck', 'full_body', 'cardio',
]);

// --- equipment_type enum (public.equipment_type, 20260721100000) -----------
const EQUIPMENT_TYPE_VALUES = new Set([
  'barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'band', 'other',
]);

function slugify(input) {
  return input
    .toString()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeKey(name, equipment) {
  const normName = name
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${normName}|${equipment}`;
}

// -----------------------------------------------------------------------------
// Free Exercise DB mapping
// -----------------------------------------------------------------------------
const FEDB_MUSCLE_MAP = {
  abdominals: 'abs',
  hamstrings: 'hamstrings',
  calves: 'calves',
  shoulders: 'shoulders',
  adductors: 'adductors',
  glutes: 'glutes',
  quadriceps: 'quadriceps',
  biceps: 'biceps',
  forearms: 'forearms',
  abductors: 'abductors',
  triceps: 'triceps',
  chest: 'chest',
  'lower back': 'back',
  traps: 'traps',
  'middle back': 'back',
  lats: 'lats',
  neck: 'neck',
};

const FEDB_EQUIPMENT_MAP = {
  'body only': 'bodyweight',
  machine: 'machine',
  other: 'other',
  'foam roll': 'other',
  kettlebells: 'kettlebell',
  dumbbell: 'dumbbell',
  cable: 'cable',
  barbell: 'barbell',
  bands: 'band',
  'medicine ball': 'other',
  'exercise ball': 'other',
  'e-z curl bar': 'barbell',
};

function mapFedbMuscle(name) {
  if (!name) return null;
  const mapped = FEDB_MUSCLE_MAP[name.toLowerCase()];
  return mapped && MUSCLE_GROUP_VALUES.has(mapped) ? mapped : null;
}

function mapFedbEquipment(equipment) {
  // null equipment in FEDB is overwhelmingly stretches/plyo/bodyweight
  // movements (77/873 rows, verified: 62 stretching + 8 plyometrics +
  // 6 strength(bodyweight variants) + 1 cardio) — default to bodyweight.
  if (!equipment) return 'bodyweight';
  return FEDB_EQUIPMENT_MAP[equipment.toLowerCase()] ?? 'other';
}

async function fetchFreeExerciseDb() {
  console.log(`Fetching Free Exercise DB from ${FREE_EXERCISE_DB_URL} ...`);
  const res = await fetch(FREE_EXERCISE_DB_URL);
  if (!res.ok) throw new Error(`Free Exercise DB fetch failed: ${res.status} ${res.statusText}`);
  const raw = await res.json();
  console.log(`  ${raw.length} raw Free Exercise DB entries fetched.`);

  const rows = [];
  for (const item of raw) {
    if (!item.name || !item.id) continue;
    const primaryMuscle = mapFedbMuscle(item.primaryMuscles?.[0]);
    if (!primaryMuscle) continue; // every exercises row requires a NOT NULL primary_muscle

    const equipment = mapFedbEquipment(item.equipment);
    const isBodyweight = equipment === 'bodyweight';
    const isWeighted = !isBodyweight;
    const isTimeBased =
      item.category === 'stretching' || /\b(plank|hold|wall sit|dead ?hang)\b/i.test(item.name);

    const secondaryMuscles = Array.from(
      new Set((item.secondaryMuscles ?? []).map(mapFedbMuscle).filter((m) => m && m !== primaryMuscle))
    );

    const instructions = Array.isArray(item.instructions) ? item.instructions.join('\n') : null;

    const images = (item.images ?? []).map((path, idx) => ({
      url: `${FREE_EXERCISE_DB_IMAGE_BASE}/${path}`,
      isPrimary: idx === 0,
      sortOrder: idx,
    }));

    rows.push({
      slug: `fedb-${slugify(item.id)}`,
      name: item.name.trim(),
      primaryMuscle,
      secondaryMuscles,
      equipment,
      mechanic: item.mechanic === 'compound' || item.mechanic === 'isolation' ? item.mechanic : null,
      forceVector: ['push', 'pull', 'static'].includes(item.force) ? item.force : null,
      isDistanceBased: false, // FEDB is a bodybuilding/strength catalog; no reliable distance signal
      isTimeBased,
      isWeighted,
      isBodyweight,
      instructions,
      source: 'free_exercise_db',
      attribution: null, // public-domain (Unlicense) — no attribution obligation
      images,
      normKey: normalizeKey(item.name, equipment),
    });
  }
  console.log(`  ${rows.length} usable Free Exercise DB rows after mapping (dropped entries with no mappable primary muscle).`);
  return rows;
}

// -----------------------------------------------------------------------------
// wger mapping
// -----------------------------------------------------------------------------
// Anatomical muscle name -> our muscle_group. wger's own `name_en` field has
// gaps (several rows are blank), so this maps off the stable anatomical
// `name` field instead (db-engineer/backend-builder judgment call — flagged).
const WGER_MUSCLE_MAP = {
  'Anterior deltoid': 'shoulders',
  'Biceps brachii': 'biceps',
  'Biceps femoris': 'hamstrings',
  Brachialis: 'biceps',
  Gastrocnemius: 'calves',
  'Gluteus maximus': 'glutes',
  'Latissimus dorsi': 'lats',
  'Obliquus externus abdominis': 'obliques',
  'Pectoralis major': 'chest',
  'Quadriceps femoris': 'quadriceps',
  'Rectus abdominis': 'abs',
  'Serratus anterior': 'chest',
  Soleus: 'calves',
  Trapezius: 'traps',
  'Triceps brachii': 'triceps',
};

// wger exercisecategory.name -> fallback muscle_group when an exercise has no
// muscles[] entries at all (a coarse fallback, not a substitute for a real
// muscle tag — flagged).
const WGER_CATEGORY_FALLBACK = {
  Abs: 'abs',
  Arms: 'biceps',
  Back: 'back',
  Calves: 'calves',
  Cardio: 'cardio',
  Chest: 'chest',
  Legs: 'quadriceps',
  Shoulders: 'shoulders',
};

function mapWgerMuscle(muscleName) {
  const mapped = WGER_MUSCLE_MAP[muscleName];
  return mapped && MUSCLE_GROUP_VALUES.has(mapped) ? mapped : null;
}

// wger's equipment list has no dedicated "Cable"/"Machine" entry (verified
// live against /api/v2/equipment/) — inferred from the exercise name instead.
// Priority order below picks ONE equipment_type per exercise from wger's
// equipment[] array (a many-to-many in wger, but exercises.equipment is a
// single NOT NULL column here) — db-engineer/backend-builder judgment call,
// flagged in the task report.
function mapWgerEquipment(equipmentNames, exerciseName) {
  const nameLower = (exerciseName ?? '').toLowerCase();
  if (/\bcable\b/.test(nameLower)) return 'cable';
  if (/\b(machine|smith machine|leg press|lat pulldown|hack squat)\b/.test(nameLower)) return 'machine';
  if (equipmentNames.includes('Barbell') || equipmentNames.includes('SZ-Bar')) return 'barbell';
  if (equipmentNames.includes('Dumbbell')) return 'dumbbell';
  if (equipmentNames.includes('Kettlebell')) return 'kettlebell';
  if (equipmentNames.includes('Resistance band')) return 'band';
  if (equipmentNames.length === 0 || equipmentNames.includes('none (bodyweight exercise)')) return 'bodyweight';
  // Bench / Incline bench / Gym mat / Pull-up bar / Swiss Ball with no other
  // cue -> treat as a bodyweight-driven movement (the prop assists a
  // bodyweight movement rather than adding external load itself).
  return 'bodyweight';
}

function stripHtml(html) {
  if (!html) return null;
  const text = html
    .replace(/<\/(p|li|div)>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 0 ? text : null;
}

async function fetchWger() {
  console.log(`Fetching wger exercise database from ${WGER_API_BASE}/exerciseinfo/ ...`);
  const rows = [];
  let url = `${WGER_API_BASE}/exerciseinfo/?limit=${WGER_PAGE_LIMIT}&format=json`;
  let page = 0;
  let totalCount = null;

  while (url) {
    page += 1;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`wger fetch failed at page ${page}: ${res.status} ${res.statusText}`);
    const body = await res.json();
    totalCount = body.count;
    for (const item of body.results) {
      const translation = (item.translations ?? []).find(
        (t) => t.language === WGER_ENGLISH_LANGUAGE_ID && t.name && t.name.trim().length > 0
      );
      if (!translation) continue; // no English name -> skip (no reliable display name)

      const muscleNames = (item.muscles ?? []).map((m) => m.name);
      let primaryMuscle = muscleNames.length > 0 ? mapWgerMuscle(muscleNames[0]) : null;
      if (!primaryMuscle) {
        const categoryFallback = WGER_CATEGORY_FALLBACK[item.category?.name];
        primaryMuscle = categoryFallback ?? 'full_body';
      }

      const secondaryMuscles = Array.from(
        new Set(
          (item.muscles_secondary ?? [])
            .map((m) => mapWgerMuscle(m.name))
            .filter((m) => m && m !== primaryMuscle)
        )
      );

      const equipmentNames = (item.equipment ?? []).map((e) => e.name);
      const equipment = mapWgerEquipment(equipmentNames, translation.name);
      const isBodyweight = equipment === 'bodyweight';
      const isWeighted = !isBodyweight;
      const isTimeBased =
        item.category?.name === 'Cardio' && /\b(plank|hold|wall sit)\b/i.test(translation.name);

      const licenseAuthor = item.license_author?.trim();
      const attribution = licenseAuthor
        ? `wger.de contributor "${licenseAuthor}", CC BY-SA 4.0 (${item.license?.url ?? 'https://creativecommons.org/licenses/by-sa/4.0/'})`
        : `wger.de contributors, CC BY-SA 4.0 (${item.license?.url ?? 'https://creativecommons.org/licenses/by-sa/4.0/'})`;

      // wger's own `is_main` flag is not reliably exclusive — some exercises
      // upstream have MORE THAN ONE image with is_main === true, which would
      // violate this project's `uq_exercise_media_primary_per_exercise`
      // partial unique index ("at most one primary media item per exercise",
      // 20260721100100_create_exercise_media.sql) if mapped through naively
      // (live-confirmed: this exact conflict aborted the first full ingestion
      // run). Pick exactly ONE primary explicitly: the first image wger marks
      // is_main, falling back to the first image in the array if none are
      // marked -- every other image for this exercise is explicitly
      // is_primary: false, never left to a second truthy is_main.
      const wgerImages = (item.images ?? []).filter((img) => img.image);
      const primaryIdx = Math.max(
        0,
        wgerImages.findIndex((img) => img.is_main === true)
      );
      const images = wgerImages.map((img, idx) => ({
        url: img.image,
        isPrimary: idx === primaryIdx,
        sortOrder: idx,
        attribution,
        license: 'CC-BY-SA-4.0',
      }));

      rows.push({
        slug: `wger-${item.uuid}`,
        name: translation.name.trim(),
        primaryMuscle,
        secondaryMuscles,
        equipment,
        mechanic: null, // wger does not expose a compound/isolation classification
        forceVector: null,
        isDistanceBased: false,
        isTimeBased,
        isWeighted,
        isBodyweight,
        instructions: stripHtml(translation.description),
        source: 'wger',
        attribution,
        images,
        normKey: normalizeKey(translation.name, equipment),
      });
    }
    console.log(`  page ${page}: ${body.results.length} entries (${rows.length} usable so far / ${totalCount} total).`);
    url = body.next;
  }
  return rows;
}

// -----------------------------------------------------------------------------
// Ingestion
// -----------------------------------------------------------------------------
async function main() {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let [fedbRows, wgerRows] = await Promise.all([fetchFreeExerciseDb(), fetchWger()]);

  // Optional smoke-test limit (not for production runs) — e.g.
  // INGEST_LIMIT=10 node scripts/ingest-exercise-library.mjs to validate the
  // write path against a handful of rows before committing to the full run.
  const limit = process.env.INGEST_LIMIT ? Number(process.env.INGEST_LIMIT) : null;
  if (limit) {
    console.log(`\nINGEST_LIMIT=${limit} set — truncating both sources for a smoke test, NOT a real ingestion run.`);
    fedbRows = fedbRows.slice(0, limit);
    wgerRows = wgerRows.slice(0, limit);
  }

  console.log('\nFetching existing exercises for dedup (especially the milelift_authored illustrative seed) ...');
  const { data: existingRows, error: existingErr } = await admin
    .from('exercises')
    .select('id, slug, name, equipment, source');
  if (existingErr) throw new Error(`Failed to read existing exercises: ${existingErr.message}`);
  console.log(`  ${existingRows.length} existing exercises rows found.`);

  const seedByKey = new Map();
  for (const row of existingRows) {
    if (row.source === 'milelift_authored') {
      seedByKey.set(normalizeKey(row.name, row.equipment), row);
    }
  }
  console.log(`  ${seedByKey.size} milelift_authored seed rows are candidates for supersession.`);

  const claimedKeys = new Set();
  let insertedCount = 0;
  let updatedCount = 0;
  let supersededSeedCount = 0;
  let skippedDuplicateCount = 0;
  let mediaRowCount = 0;

  async function upsertExercise(row) {
    if (claimedKeys.has(row.normKey)) {
      skippedDuplicateCount += 1;
      return; // already covered by a higher-priority source in this same run
    }
    claimedKeys.add(row.normKey);

    const seedMatch = seedByKey.get(row.normKey);
    const exerciseFields = {
      slug: row.slug,
      name: row.name,
      primary_muscle: row.primaryMuscle,
      secondary_muscles: row.secondaryMuscles,
      equipment: row.equipment,
      mechanic: row.mechanic,
      force_vector: row.forceVector,
      is_distance_based: row.isDistanceBased,
      is_time_based: row.isTimeBased,
      is_weighted: row.isWeighted,
      is_bodyweight: row.isBodyweight,
      instructions: row.instructions,
      source: row.source,
      attribution: row.attribution,
      is_active: true,
    };

    let exerciseId;
    if (seedMatch) {
      // Supersede the illustrative seed row IN PLACE (same id) rather than
      // creating a duplicate — per task instruction "dedupe against it,
      // don't create duplicates".
      const { data, error } = await admin
        .from('exercises')
        .update(exerciseFields)
        .eq('id', seedMatch.id)
        .select('id')
        .single();
      if (error) throw new Error(`Failed to supersede seed exercise ${seedMatch.id} (${row.slug}): ${error.message}`);
      exerciseId = data.id;
      supersededSeedCount += 1;
      seedByKey.delete(row.normKey);
    } else {
      const { data, error } = await admin
        .from('exercises')
        .upsert(exerciseFields, { onConflict: 'slug' })
        .select('id')
        .single();
      if (error) throw new Error(`Failed to upsert exercise ${row.slug}: ${error.message}`);
      exerciseId = data.id;
    }

    // Media refresh: delete this exercise's previously-ingested media (scoped
    // to this row's own source, so a re-run never accumulates duplicates or
    // clobbers media from a different source layered onto the same exercise)
    // then reinsert fresh rows for this run's image set.
    const { error: deleteMediaErr } = await admin
      .from('exercise_media')
      .delete()
      .eq('exercise_id', exerciseId)
      .eq('source', row.source);
    if (deleteMediaErr) throw new Error(`Failed to clear stale media for ${row.slug}: ${deleteMediaErr.message}`);

    if (row.images.length > 0) {
      const mediaRows = row.images.map((img) => ({
        exercise_id: exerciseId,
        media_type: 'image',
        url_or_object_path: img.url,
        is_primary: img.isPrimary,
        source: row.source,
        attribution: img.attribution ?? row.attribution,
        license: img.license ?? (row.source === 'wger' ? 'CC-BY-SA-4.0' : null),
        sort_order: img.sortOrder,
      }));
      const { error: insertMediaErr } = await admin.from('exercise_media').insert(mediaRows);
      if (insertMediaErr) throw new Error(`Failed to insert media for ${row.slug}: ${insertMediaErr.message}`);
      mediaRowCount += mediaRows.length;
    }

    if (seedMatch) {
      // counted above as superseded, not inserted/updated
    } else {
      // Distinguish insert vs update for the summary by checking whether the
      // slug already existed among the pre-run snapshot.
      const alreadyExisted = existingRows.some((r) => r.slug === row.slug);
      if (alreadyExisted) updatedCount += 1;
      else insertedCount += 1;
    }
  }

  console.log('\nIngesting Free Exercise DB (preferred on conflict) ...');
  for (const row of fedbRows) {
    await upsertExercise(row);
  }
  console.log(`  Free Exercise DB pass complete.`);

  console.log('\nIngesting wger (supplement layer, skipped where Free Exercise DB already claimed the same normalized name+equipment) ...');
  for (const row of wgerRows) {
    await upsertExercise(row);
  }
  console.log(`  wger pass complete.`);

  const remainingUnsupersededSeedCount = seedByKey.size;

  console.log('\n=============================================================');
  console.log('Exercise-library ingestion summary');
  console.log('=============================================================');
  console.log(`Free Exercise DB usable rows fetched: ${fedbRows.length}`);
  console.log(`wger usable rows fetched:              ${wgerRows.length}`);
  console.log(`Total distinct (name, equipment) rows written: ${insertedCount + updatedCount + supersededSeedCount}`);
  console.log(`  Newly inserted:                      ${insertedCount}`);
  console.log(`  Updated (already-ingested, re-run):  ${updatedCount}`);
  console.log(`  Superseded milelift_authored seed rows: ${supersededSeedCount}`);
  console.log(`Skipped as cross-source duplicates (wger vs. Free Exercise DB, same run): ${skippedDuplicateCount}`);
  console.log(`Illustrative seed rows left un-superseded (no matching ingested movement found): ${remainingUnsupersededSeedCount}`);
  console.log(`exercise_media rows written: ${mediaRowCount}`);

  const { count: finalExerciseCount, error: countErr } = await admin
    .from('exercises')
    .select('id', { count: 'exact', head: true });
  if (countErr) throw new Error(`Failed to count final exercises: ${countErr.message}`);
  console.log(`\nFinal public.exercises row count: ${finalExerciseCount}`);

  console.log(
    '\nATTRIBUTION FLAG (architecture §6/§2.1): wger data is CC-BY-SA 4.0 and its ' +
      'attribution string is stored per-row (exercises.attribution) and per-media ' +
      '(exercise_media.attribution/license), but there is currently NO in-app ' +
      'library/credits screen to render it — that surface does not exist yet in ' +
      'this codebase (grep of src/ for "credits"/"attribution" found nothing). This ' +
      'is a real, unresolved compliance gap for shipping wger-sourced content, not ' +
      'just a documentation note: ui-ux-designer/mobile-builder must add a visible ' +
      'credits/attribution surface (e.g. an "About this exercise" section on the ' +
      'library detail screen, or a dedicated library-wide credits page) before this ' +
      'content ships to real users, per architecture §12 item 1 ("attribution that ' +
      'ships in-app, not just stored").'
  );
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
