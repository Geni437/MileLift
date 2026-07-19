#!/usr/bin/env node
/**
 * CI migration lint / dry-run — Phase 0 CI/CD skeleton.
 *
 * What this DOES verify, for real, on every run:
 *   1. Every `supabase/migrations/*.sql` file parses as syntactically valid
 *      PostgreSQL, using `pgsql-parser` — a WASM build of `libpg_query`, the
 *      actual parser Postgres itself uses (not a lookalike/regex check). A
 *      typo, unbalanced paren, bad dollar-quoting, or malformed statement
 *      fails this step.
 *   2. Every migration filename follows the Supabase CLI convention
 *      (`YYYYMMDDHHMMSS_description.sql`), so `supabase db reset` replays
 *      them in the intended order.
 *   3. Every forward migration has a paired rollback script under
 *      `supabase/migrations/rollbacks/`, per this project's documented
 *      convention (`supabase/migrations/rollbacks/README.md`) — the Supabase
 *      CLI has no native down-migration mechanism, so the paired rollback is
 *      how this project satisfies `db-schema-standards`' "every migration has
 *      a working reversal" rule.
 *
 * What this deliberately does NOT verify (documented, not silently skipped):
 *   - That the migrations actually APPLY cleanly, in order, against a real
 *     Postgres/Supabase instance (no create-table-then-reference-it-wrong
 *     semantic check, no constraint-conflict check). That requires the
 *     Supabase CLI's local stack (`supabase db reset`), which itself requires
 *     Docker. This environment/CI runner does not have a verified Docker
 *     setup available, so a real apply-dry-run is out of scope for this
 *     Phase 0 CI skeleton — tracked as a follow-up (see docs/ops/ci-cd.md).
 *   - RLS policy behavior, trigger behavior, or PostgREST-exposed grant
 *     correctness. Those require an actual running instance with `auth.*`
 *     and real roles, i.e. the same Docker-based local stack above.
 *
 * This is intentionally a syntax + convention lint, not a full dry-run —
 * calling it more than that would overstate what's actually checked.
 */

import { parse } from 'pgsql-parser';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(MIGRATIONS_DIR, 'rollbacks');

const FILENAME_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

async function main() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`FAIL: migrations directory not found at ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (migrationFiles.length === 0) {
    // Zero files found is far more likely a broken path/glob than a real
    // "no migrations yet" state for this project (Phase 0 already has
    // several) — fail loudly rather than let an empty result look like a
    // silent pass (production-standards: no silent fallback that masks a
    // real configuration problem).
    console.error(`FAIL: no .sql migration files found in ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const problems = [];

  for (const filename of migrationFiles) {
    if (!FILENAME_PATTERN.test(filename)) {
      problems.push(
        `${filename}: filename does not match the required ` +
          `YYYYMMDDHHMMSS_description.sql convention`
      );
    }

    const rollbackPath = path.join(ROLLBACKS_DIR, filename);
    if (!existsSync(rollbackPath)) {
      problems.push(
        `${filename}: no paired rollback script found at ` +
          `supabase/migrations/rollbacks/${filename} (see rollbacks/README.md convention)`
      );
    }
  }

  const results = await Promise.all(
    migrationFiles.map(async (filename) => {
      const filePath = path.join(MIGRATIONS_DIR, filename);
      const sql = readFileSync(filePath, 'utf8');
      try {
        await parse(sql);
        return { filename, ok: true };
      } catch (err) {
        return { filename, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  for (const result of results) {
    if (result.ok) {
      console.log(`OK    ${result.filename}`);
    } else {
      console.log(`FAIL  ${result.filename}: ${result.error}`);
      problems.push(`${result.filename}: SQL syntax error — ${result.error}`);
    }
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} migration lint problem(s) found:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nFAIL: migration lint failed.');
    process.exit(1);
  }

  console.log(`\nOK: ${migrationFiles.length} migration file(s) passed syntax + convention lint.`);
}

await main();
