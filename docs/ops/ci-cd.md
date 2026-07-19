# CI/CD — Phase 0 skeleton

Status: **Phase 0 CI skeleton.** This is intentionally narrow — lint/type-check/
test/migration-lint on every push and PR, nothing more. It is not a production
deploy pipeline; that's `deploy-checklist` / a later-phase `devops-engineer`
task once there's something real to deploy.

Owner: `devops-engineer`. Workflow file: `.github/workflows/ci.yml`.

---

## 1. What runs, and when

`.github/workflows/ci.yml` triggers on:

- `push` to `main` or `master` (this repo's default branch naming hasn't been
  finalized yet — see §5 — so both are wired for now; narrow to one once
  that's settled).
- Every `pull_request`, regardless of source/target branch.

Three independent jobs run in parallel:

| Job | What it does | Blocking? |
| --- | --- | --- |
| `app-checks` | `npm ci` → `npm run lint` (ESLint, zero warnings) → `npm run typecheck` (`tsc --noEmit`) → `npm test -- --ci` (Jest) | Yes — any failing step fails the job, and GitHub Actions stops at the first failing step by default (no `continue-on-error` on any of these). |
| `dependency-audit` | `npm audit --audit-level=high` (blocking), then `npm audit --audit-level=moderate` (informational only — see §4) | High/critical: yes. Moderate: no, by explicit, documented, visible decision. |
| `migration-lint` | `npm run lint:migrations` — real-PostgreSQL-grammar syntax check + filename/rollback-convention check on every file in `supabase/migrations/` (see §3) | Yes |

All three jobs run `npm ci` (not `npm install`) for a reproducible,
lockfile-exact install — see §2 for a real gotcha this surfaced.

**Not yet verified in the cloud.** This repo currently has no git remote
configured (confirmed at the start of this task) and nothing has been pushed
anywhere, so no workflow run has actually executed in GitHub's UI. What *is*
verified, locally, right now:

- The workflow YAML parses as valid YAML (checked with `js-yaml`).
- Every underlying command the workflow calls (`npm ci`, `npm run lint`,
  `npm run typecheck`, `npm test -- --ci`, `npm run lint:migrations`,
  `npm audit --audit-level=high`) was run directly on this machine and its
  real output is in the task report.

What remains genuinely unverified until a real remote exists and this
actually runs on a GitHub-hosted `ubuntu-latest` runner: whether the specific
pinned action versions (`actions/checkout@v4`, `actions/setup-node@v4`)
resolve correctly, whether `npm ci` behaves identically on a fresh Actions
runner vs. this machine, and whether GitHub's WASM/sandboxing environment has
any quirk that doesn't show up locally. This is a real gap, not a formality —
flag any first-run failure back to `devops-engineer` rather than assuming the
YAML is correct just because it parses.

---

## 2. A pre-existing install bug this work surfaced and fixed

Before this task, `npm ci` **did not work** in this repo — it failed with an
`ERESOLVE` peer-dependency conflict: the pinned `react@19.2.3` doesn't satisfy
`react-dom@19.2.7`'s peer requirement (`react-dom` is pulled in transitively
by `expo-router`'s optional web-only UI stack — `@expo/ui` / `vaul` /
`@radix-ui/*` — which only matters for the `expo start --web` target, not the
mobile app). This predates this task's changes (verified: the conflicting
`@radix-ui`/`vaul` subtree was already resolved in the pre-existing
`package-lock.json`).

This would have made every single CI run red on `npm ci`, the very first
step — a green-looking CI file wrapping a broken install, which is worse than
no CI. Fixed with a minimal `overrides` pin in `package.json`:

```json
"overrides": {
  "react-dom": "19.2.3"
}
```

`react-dom` is not a direct dependency of this app (React Native, not a web
app) — pinning it to match the already-deliberately-pinned `react` version is
the narrow fix; it does not touch any of the actual meaningful version pins
(`react`, `react-native`, `expo`) that were chosen deliberately elsewhere.
Verified after the fix: `npm ci` succeeds cleanly, and `lint`/`typecheck`/
`test` all still pass (see task report for output).

---

## 3. Supabase migration lint — what it checks and what it deliberately doesn't

`scripts/lint-migrations.mjs` (`npm run lint:migrations`) runs on every push/
PR. It checks, for real, on every run:

1. **SQL syntax** — every `supabase/migrations/*.sql` file is parsed with
   `pgsql-parser`, a WASM build of `libpg_query` (the actual parser Postgres
   itself uses, not a regex or lookalike grammar). A typo, unbalanced paren,
   or malformed statement fails the check.
2. **Filename convention** — every file matches
   `YYYYMMDDHHMMSS_description.sql`, so `supabase db reset` replays them in
   the intended order.
3. **Paired rollback existence** — every forward migration has a matching
   file under `supabase/migrations/rollbacks/`, per this project's own
   documented convention (`supabase/migrations/rollbacks/README.md`).

### What this is NOT, on purpose

It does **not** verify that the migrations actually *apply* cleanly, in
order, against a real Postgres/Supabase instance — no semantic check (a
migration referencing a column/table that doesn't exist yet, a constraint
conflict, etc. would not be caught). It also does not verify RLS policy
behavior, trigger behavior, or PostgREST grant correctness.

That level of check is exactly what `supabase-standards` calls for
(`supabase db reset`, replaying every migration against the Supabase CLI's
local stack) — but that stack runs via Docker, and this environment has no
verified Docker setup available (confirmed earlier in this engagement: no
`docker`, no `supabase` CLI installed locally). Rather than either skip the
check entirely or claim a full apply-dry-run that isn't actually being
verified, this Phase 0 skeleton does the honest, lighter thing: real
Postgres-grammar syntax validation + this repo's own conventions. This is a
genuine, non-trivial check (it caught what it was supposed to catch in
testing — see task report), just not a substitute for a full apply.

### Follow-up (real gap, not invented, tracked here)

A true apply-dry-run (`supabase db reset` against the Docker-based local
stack, or a hosted-project dry run via `supabase db push --dry-run` against
the one live linked project) is a legitimate next step once either:

- A CI runner with Docker is confirmed workable for the Supabase CLI's local
  stack (GitHub-hosted `ubuntu-latest` runners ship Docker by default, but
  this hasn't been exercised from this environment — verify it actually
  works before relying on it), or
- A second (dev/staging) Supabase project exists to dry-run against, so PR
  CI isn't pushing migration attempts at the one live production project on
  every run (see §5 — there is currently exactly one Supabase project).

---

## 4. Environment / secrets convention

### Local development

`.env` (gitignored, never committed) holds:

```
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
```

`.env.example` is committed and — deliberately — contains the *real* current
project's URL and anon key, not placeholders. This is safe specifically
because both values are meant to be public in a shipped mobile client: the
anon key identifies the Supabase project and every table it can touch is
governed by RLS, not by the key being secret (see the comment in
`.env.example` and `app.config.ts`). This is the one exception to "never
commit real values" and it's an intentional, documented one — not an
oversight.

**The service-role key (or any future genuinely-scoped secret) must never
appear in `.env.example`, `.env`, `app.config.ts`, or anywhere under
`app/`/`src/` — it belongs only in Edge Function environment secrets and
backend-only tooling**, per `supabase-standards`. It also must never be
baked into a shipped mobile binary.

### CI (GitHub Actions)

`EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` are wired into
the `app-checks` job via `${{ secrets.EXPO_PUBLIC_SUPABASE_URL }}` /
`${{ secrets.EXPO_PUBLIC_SUPABASE_ANON_KEY }}` — **not** hardcoded into the
workflow YAML, even though today's test suite doesn't actually need them (no
current test imports `app.config.ts` / `src/lib/env.ts`; verified locally by
running the test suite with no `EXPO_*` env vars set at all — it still
passed). This is wired now, ahead of actual need, so the convention exists
correctly before it's load-bearing: a future test that does exercise the
Supabase-config path won't require retrofitting CI wiring, and — more
importantly — the same `secrets.*` mechanism is already in place for the day
a *real* secret (an EAS build token, a Sentry DSN, a service-role key used by
a backend-only CI job) needs to be added. Adding it then is a one-line change
in an already-established pattern, not a new convention invented under
pressure.

**Action required, not yet done (can't be done from this environment — no
remote/no repo access to configure GitHub settings):** add
`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` as repository
secrets in GitHub once a remote exists. Until then, those env vars simply
resolve to empty strings in CI, which is a harmless no-op given nothing
currently consumes them in a CI-run code path — but don't mistake "CI is
green" for "secrets are configured" once a test does start needing them.

### The real gap: one Supabase project, no dev/staging/prod split

There is currently **exactly one live Supabase project** — the same project
referenced in `.env.example`, used for local development, and (per §3) the
only project any future migration dry-run could target. There is no
separate dev/staging/prod environment split yet.

This is a real, stated gap, not an oversight papered over with invented
environments that don't exist:

- Every local developer, and any future CI job that talks to Supabase, points
  at the same single project today.
- A migration applied by mistake, or a dry-run tool with a bug, has no
  blast-radius containment — there is no throwaway environment to test
  against first.
- **Follow-up, not done here:** stand up a separate dev (and eventually
  staging) Supabase project before this becomes a live product with real
  user data, and update `.env.example` / CI secrets / the migration-dry-run
  target accordingly. Until then, the convention above (secrets via CI
  store, never committed) is what to build against so the eventual split is
  a config change, not a re-architecture.

---

## 5. Dependency audit — why moderate severity doesn't block yet

`npm audit --audit-level=high` is the blocking gate. As of this task,
`npm audit` (default = moderate+) reports **11 moderate-severity findings**,
all transitively rooted in a single `uuid <11.1.1` advisory pulled in via
`xcode` → `@expo/config-plugins` → the Expo CLI/build-tooling chain (used for
native project generation / `expo prebuild`, not code that ships in the app
bundle or runs at runtime on a user's device). `npm audit fix --force` would
resolve it but pulls a breaking `expo-splash-screen` upgrade — not something
to do silently as a side effect of a CI-setup task.

Rather than either (a) blocking every PR on a pre-existing, dev-tooling-only,
non-trivial-to-fix finding on day one of CI existing, or (b) silently
excluding moderate findings from the audit entirely, this workflow does the
explicit, visible middle ground: the moderate-level audit still runs on every
CI run and prints a `::warning::` annotation (visible on the PR, not buried
in a log nobody opens) if anything is found, but does not fail the job. This
is a deliberate, stated, non-silent decision — not a swallowed failure — and
it is a decision that should be revisited: **follow-up** is to either fix the
underlying `uuid`/`xcode` chain (via `npm audit fix --force` once its
breaking-change impact has actually been evaluated, not blindly) or
explicitly accept and re-document the risk with an expiry/review date, rather
than let the warning sit unexamined indefinitely.

---

## 6. Explicitly deferred (not built here — later-phase / `deploy-checklist` territory)

Per the task scope ("CI/CD skeleton," not a full production release
pipeline), the following are intentionally **not** built in this pass:

- **A real CD pipeline** — no automated deploy of Edge Functions, no
  automated migration apply to any environment, no staged/percentage-based
  rollout mechanism for backend deploys, no automated rollback trigger. Per
  the `devops-engineer` role's CD responsibility, this needs a real target
  environment (§4's dev/staging gap) and a rollback plan before it's built —
  building deploy automation against a single, undifferentiated production
  project is exactly the kind of thing that turns into an unplanned incident.
- **Monitoring/alerting** (error rate, latency, crash-free rate with actual
  alert thresholds) — not part of this CI skeleton; a separate task once
  there's a deployed backend/shipped app to monitor.
- **Mobile release automation** (App Store / Play Store submission,
  privacy-label checklist, staged rollout percentage) — this is
  `deploy-checklist`'s "Mobile release" section, run explicitly before any
  real store submission, not something to script now against a Phase 0 app
  with nothing to ship yet.
- **EAS Build / EAS Submit wiring** — no `eas.json` profiles or CI-triggered
  builds are set up. Needed before Phase 0 closes out if a real device build
  is required, but out of scope for "lint/type-check/test/migration-lint on
  every PR."

None of the above should be read as "automated" in any report of this task —
they are explicit, named gaps.
