# Phase 0 — Foundation: Canonical Timeline, Unified Profile/Auth, and Foundational Tech Choices

Status: **DRAFT — requires the person's explicit confirmation before `db-engineer`
builds any schema against it** (per the Master Build Prompt Phase 0 gate).

Owner: `architect`. Downstream consumers of this doc: `db-engineer` (schema + RLS),
`ui-ux-designer` (auth/onboarding/consent screens), `mobile-builder` (app shell,
local store), `devops-engineer` (Supabase environments).

Scope of this doc (narrow, per the delegation and the roadmap):
- The **canonical timeline** data model — the single shared structure every module
  writes into.
- The **CORE-18 unified profile/auth** model.
- The **foundational tech choices** the project has not yet made (backend platform,
  mobile framework, physical timeline representation).
- Where **RLS responsibility begins** (boundary definition; `db-engineer` writes the
  policies).

**Explicitly out of scope** (Phase 1–3, do not design here): Module A/B/C/D internal
detail schemas — route points, GPS samples, food entries and macros, exercise sets,
rest timers, the exercise/food reference libraries. This doc defines only the shared
spine those modules attach to, and the *contract* between spine and module.

---

## 0. The one decision this whole doc exists to make

Every module (Activity, Nutrition, Strength, Community) owns its own detailed data
model, but every user-facing thing that *happened at a point or interval in time*
is written as a row in **one shared, physically-single `timeline_events` table**,
carrying a small fixed set of normalized cross-module metrics. Module-specific
detail hangs off that row in a per-module detail table sharing the same primary key.

This is chosen specifically so that the cross-module reads the AI layer depends on
(AI-06 recovery→load, AI-07 NL Q&A, AI-12 activity→macro, CORE-11 burn
reconciliation) are **a normal single-table indexed query, not a per-feature
integration**. The justification and the two rejected alternatives are in §4.

Everything else in this doc follows from that decision.

---

## 1. Data model

### 1.1 What is and is not a "timeline event"

A timeline event is **something that happened at a time, owned by one user**: a
recorded run, a logged meal, a completed workout session, a water-intake entry, a
body measurement, a wearable-sourced sleep/HR sample, a manual calorie-burn entry,
a native community post.

**Not** timeline events (do not attach to the spine):
- Reference/definition data shared across users — the exercise library, the food
  database. Global, read-mostly, not user-owned. (Ownership boundary noted in §5;
  full design is Phase 2/3.)
- User-owned *definitions/templates* that are not a point-in-time occurrence — saved
  recipes, workout program templates, equipment profiles. These are owned by the
  user but are not events; they live in their own module tables, not the spine.
- The social graph — follow relationships, block lists. Edges, not events.
- Identity/preferences — the profile itself (§2).

Keeping this line sharp is load-bearing: the spine stays the *log*, which is what
makes time-ordered cross-module reads fast and what makes export/deletion a single
walk (§7).

### 1.2 `timeline_events` — the spine (column-level spec)

`db-engineer` owns exact Postgres types, constraints, and the migration; the columns,
semantics, and integrity rules below are the design contract to build against.

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `id` | uuid, PK | **Client-generated** on-device (`db-schema-standards`: offline-originating records generate their own key). Doubles as the idempotency key (§3.4). |
| `user_id` | uuid, FK → `profiles.id`, NOT NULL | Ownership anchor for RLS. `ON DELETE CASCADE`. |
| `source_module` | enum: `activity`\|`nutrition`\|`strength`\|`community` | Which module produced the event. Enum, extend by migration (add value only — non-breaking, per `supabase-standards`). |
| `event_type` | enum | Fine-grained subtype; determines which detail table joins. Representative Phase-0-known values in §1.4. Extend by migration. |
| `occurred_at` | timestamptz (UTC), NOT NULL | When it happened in the real world. For interval events (a run, a workout) this is the start; `duration_seconds` gives the span. |
| `local_date` | date, NOT NULL | The user's **local calendar day** at the moment of the event, computed on-device from device timezone (`api-contract-standards`: streaks/daily aggregation must not break at DST/timezone boundaries). Do **not** derive this server-side from `occurred_at`. |
| `event_timezone` | text (IANA), NOT NULL | Snapshot of the device tz at event time. Lets us recompute local-day correctly and is required to explain a value later. |
| `energy_kcal` | numeric, nullable | **Signed cross-module energy currency.** Convention (named constant, enforced by CHECK): **positive = intake** (nutrition), **negative = expenditure** (activity/workout/manual burn). Daily energy balance = `SUM(energy_kcal)` over a `local_date`. This is the column CORE-11 / AI-12 read across the module boundary. |
| `load_score` | numeric, nullable | Normalized **training-stress currency** for AI-06 (recovery-adjusted load). The *formula* (sRPE, TSS-like, etc.) is a Module C / AI-06 decision — the **slot** lives here so "load this week vs. recovery signals this week" is one time-ordered query. Open question §8. |
| `duration_seconds` | integer, nullable | Span of an interval event. Cross-used (activity duration feeds energy estimates; feed rendering; session length). |
| `source` | enum: `manual`\|`wearable`\|`import`\|`ai_parsed`\|`system` | How the row originated. Drives dedup (AI-19), audit, and the AI-confidence pattern below. Wearable sub-provider (garmin/apple_health/wear_os) goes in detail, not on the spine. |
| `confidence` | numeric (0–1), nullable | For AI-populated events (AI-09 meal parsing, AI-10 portion est.). NULL for human-entered. |
| `needs_confirmation` | boolean, NOT NULL default false | The **confidence-escalation pattern baked into the spine** (Master Build Prompt project-wide rule; `ai-orchestration-standards`). A low-confidence AI event is a *suggestion* until the user confirms. Putting this on the spine means every module inherits the pattern instead of reinventing it. |
| `visibility` | enum: `private`\|`followers`\|`public`, NOT NULL default `private` | The **single shared social-visibility dimension** (§1.3). Community reads the timeline through this; it is not a per-module invention. Fail-closed default. |
| `client_created_at` | timestamptz | When the client first created the row (offline clock). For audit/ordering; never trusted for security. |
| `created_at` | timestamptz, NOT NULL default now() | Server insert time. |
| `updated_at` | timestamptz, NOT NULL default now() | Server-maintained (trigger). **The sync cursor and the last-write-wins key** (§3). |
| `deleted_at` | timestamptz, nullable | Soft-delete tombstone (syncs as an update). A separate hard-purge path satisfies deletion rights (§7). |

**Integrity rules to enforce at the DB level** (`db-schema-standards`: constraints in
the database, not only app code):
- CHECK: expenditure `event_type`s must have `energy_kcal <= 0`; intake types
  `>= 0`. A wrong-signed energy value is exactly the kind of silent corruption that
  breaks a day's balance.
- CHECK: `occurred_at` not in the future beyond a bounded client clock-skew tolerance
  (named constant, e.g. 24h). Input validation at the boundary
  (`production-standards`).
- Measured quantities are `numeric`, never float (`db-schema-standards`).
- `energy_kcal`, `load_score`, `duration_seconds` are **snapshots at log time**, not
  live-recomputed (§8 open question on recompute policy).

**The rule for what earns a fixed spine column:** a metric gets a typed column on the
spine **only if a *different* module reads it**. Energy (nutrition ↔ activity), load
(strength ↔ recovery), duration (feed + energy) qualify. Module-private metrics —
distance, pace, macros, sets, reps, GPS points — stay in detail tables. This keeps
the hot, heavily-written spine lean (indexes cost every insert) and keeps the
cross-module query a single narrow scan.

We deliberately reject a generic key-value / JSONB "metrics" bag on the spine: it
would forfeit type safety, DB-level constraints, and index-ability
(`db-schema-standards` typing rules), to buy flexibility for a metric set that is
small, known, and rarely changes. Adding a genuinely new cross-cutting metric later
is one nullable-column migration — cheap and rare.

### 1.3 Shared visibility (made once, here — not per module)

`visibility` on the spine is the entire social-sharing mechanism. Because each event
carries its own visibility, sharing is **per-event and therefore per-data-type by
construction** — a user can make activities `followers` while body measurements stay
`private`. This directly satisfies `health-data-compliance`'s "granular, not
all-or-nothing sharing" requirement without a separate mechanism.

- Fail-closed default: every event is `private` unless explicitly widened.
- Body measurements / progress photos / bodyweight / raw biometric samples are
  **never shareable** — enforce as a non-widenable default (a CHECK or policy that
  forbids `visibility != private` for those `event_type`s). This one is an assertion,
  not a product option — sharing someone's bodyweight to a feed is a
  health-data-compliance and trust failure. The *default sharing level for
  activities* (Strava-style followers-visible vs. private) **is** a product call
  (§8).

### 1.4 `event_type` taxonomy (representative, migration-extensible)

Enough to build Phase 0 against; module phases add values (add-only migrations).

- `source_module = activity`: `gps_activity`, `sleep_session`, `hr_sample`,
  `hrv_sample`, `resting_hr` (recovery/biometric samples arrive via wearable sync,
  which is Module A's ingestion domain, and feed AI-06).
- `source_module = nutrition`: `food_log_entry`, `water_intake`,
  `manual_calorie_burn` (CORE-11).
- `source_module = strength`: `strength_session`, `body_measurement`, `bodyweight`,
  `progress_photo`.
- `source_module = community`: `native_post` (a text/photo post not tied to an
  activity). Note most community *reads* are over other modules' events via
  `visibility`; kudos/reactions/follows are edges (Module D graph tables, Phase 4),
  not timeline events.

(Which module ingests wearable recovery samples is a minor boundary worth confirming
— §8.)

### 1.5 Spine ↔ module detail contract (the seam, not the module internals)

Each module attaches detail via a **table-per-subtype** pattern:

- One detail table per subtype (`activity_details`, `strength_sessions`,
  `nutrition_entries`, …). **Columns are Phase 1–3 work — not defined here.**
- Detail primary key **is** `timeline_event_id`, a 1:1 FK to `timeline_events.id`
  (shared-PK supertype/subtype). One event ↔ one detail row, inserted in the same
  transaction.
- Detail tables **denormalize `user_id`** (copied from the spine at insert). This is
  a deliberate denormalization so every detail table's RLS policy is a direct
  `user_id = auth.uid()` check and its `(user_id, …)` indexes work, instead of a join
  back to the spine in every policy and query. Tradeoff: a redundant column that must
  stay consistent — enforce with a FK + a trigger/insert rule so it can't diverge.
- Deeper child collections (sets within a strength session, GPS points within an
  activity) hang off the **detail** table, not the spine, and are Phase 1–3.

Snapshot rule at the seam (`db-schema-standards`, historical integrity): when a detail
row references shared reference data (an exercise, a food), it **snapshots** the human-
meaningful fields (name, unit) onto the log row in addition to the FK, so editing the
library later never retroactively rewrites history. This is a module-phase
implementation detail, but it is **flagged now** because the spine's `energy_kcal` /
`load_score` are themselves snapshots and the same discipline applies end-to-end.

### 1.6 Profile/auth (CORE-18) — see §2. Consent + sensitive-attribute tables — see §6/§7.

---

## 2. Unified profile & auth (CORE-18)

One account per person, one history, regardless of sign-in method.

- **`auth.users`** — Supabase-managed. Do **not** add application columns to it
  (`supabase-standards`).
- **`public.profiles`** — 1:1 with `auth.users.id`, created by a trigger on user
  creation. **This is where CORE-18's single unified profile lives**, and its `id` is
  the `user_id` every `timeline_events` row and every detail table traces ownership
  back to.
- Email/password and any OAuth/social provider **funnel into the same `profiles`
  row** — one person = one profile = one timeline, regardless of how they signed in
  (`supabase-standards` auth section; use Supabase identity linking so a second
  provider on the same verified email does not fork a second account).

`profiles` columns (identity + preferences — low sensitivity):

| Column | Notes |
| --- | --- |
| `id` (PK, = `auth.users.id`) | Ownership anchor. |
| `username` | Unique, for community. Public-readable field. |
| `display_name`, `avatar_url` | Public-readable community fields (`avatar_url` served via signed URL, not a public bucket). |
| `unit_weight` (`kg`\|`lb`), `unit_distance` (`km`\|`mi`) | Per-user defaults **copied onto each record at write time** (`db-schema-standards`: store the unit used per historical entry; never rely on a live global default). |
| `default_timezone` (IANA) | Fallback only; the authoritative per-event tz is `timeline_events.event_timezone`. |
| `created_at`, `updated_at` | |

Health-sensitive demographic/biometric attributes (sex, date of birth, height) are
**not** in `profiles` — they are minimized, consent-gated, and modeled separately
(§6). Whether they are collected at all, and when, is an open decision (§8).

Bodyweight is **not** a profile scalar — it is a timeline event
(`event_type = bodyweight`), because it changes over time and history matters
(`db-schema-standards`). "Current weight" is a query over the timeline, not a mutable
column.

---

## 3. Sync / offline (the decision, made once here — modules inherit it)

Detailed client implementation is `mobile-architecture-standards`' job; the *rules
below are architectural and are decided here so no module re-invents them.*

### 3.1 Does this data need to work offline? Yes — it is the core requirement.
CORE-17 calls offline logging "non-negotiable." The timeline is the offline-first
substrate for the whole product.

### 3.2 Source of truth
The **on-device local store (SQLite-based) is the UI's source of truth.** Screens read
local, never a live network call. The local store mirrors the spine + detail shape so
the same model holds on both sides.

### 3.3 Write path
Optimistic local write → queued background sync → server **upsert**. The user never
waits on a network round-trip to see a set/meal recorded. A visible sync-status
indicator distinguishes local-saved / synced / sync-failed.

### 3.4 Idempotency (the "why do I have two copies of my workout" bug)
The client-generated `id` (UUID) is the idempotency key. Server writes are
`INSERT … ON CONFLICT (id) DO UPDATE` upserts against the unique PK — **not**
application-level check-then-insert, which races under retry (`supabase-standards`,
`api-contract-standards`). Retrying a flaky sync is always safe.

### 3.5 Conflict resolution (documented, not accidental)
**Last-write-wins by server `updated_at`, at the event-row grain**, for edits to
already-synced events. An in-progress, not-yet-committed local workout is *local
domain state* (`mobile-architecture-standards` layer 2), not subject to LWW until it
commits. This is the single documented rule for the whole platform; if a specific
module later needs field-level merge instead, that is an explicit deviation approved
here, not a silent per-module choice.

### 3.6 Pull / sync cursor
Cursor-based incremental pull on `updated_at` (`?since=`), so a client fetches only
what changed. History/feed pagination is cursor-based on `(occurred_at, id)` (stable
under concurrent inserts), never offset. Every list endpoint that can grow unbounded
is paginated from day one (`api-contract-standards`).

### 3.7 Timestamps
Stored/transmitted UTC ISO-8601. Daily/streak logic runs on `local_date`
(device-computed), never server tz.

### 3.8 Delete
Soft-delete via `deleted_at` (syncs as an update); a separate scheduled hard-purge
job satisfies deletion rights (§7). Every read filters `deleted_at IS NULL` by
default scope, not by remembering the clause per query (`db-schema-standards`).

---

## 4. Physical representation — the chosen shape and why

**Chosen: one shared `timeline_events` table + per-module detail tables sharing its
PK (§1.2, §1.5).**

Justification against the cross-module read requirement — the deciding factor:

- **AI-12 / CORE-11** (activity burn → macro target, without double-counting):
  `SELECT SUM(energy_kcal) FROM timeline_events WHERE user_id = auth.uid() AND
  local_date = $1` gives the day's net energy across nutrition and activity in **one
  indexed scan**. Reconciling a manual burn (CORE-11) against a GPS activity is a
  normal query over `source`, `occurred_at`, `duration_seconds` on the same table —
  not a bespoke integration.
- **AI-06** (recovery → load): recovery samples and strength/activity load are rows
  in the same table; "rolling load vs. rolling recovery" is one time-ordered scan.
- **AI-07** (NL Q&A over the user's real data): the LLM/function-calling layer points
  at **one canonical timeline** (via views/RPC) instead of learning four different
  module schemas. This collapses the function-calling surface dramatically and is a
  direct reason to pick this shape.

**Rejected — pure per-module tables + a `UNION ALL` view as the "timeline":** every
cross-module read becomes an N-way UNION recomputed each time, with no shared index to
order by time, no shared place for visibility/sync/AI-confidence, and painful
pagination across heterogeneous tables. It pushes the cost onto every read forever.

**Rejected — single table with a JSONB `payload` for all module data:** forfeits
type safety, DB-level CHECK/FK constraints, and index-ability on the very fields
(energy, units, timestamps) that `db-schema-standards` insists be typed and
constrained; it invites exactly the silent-corruption class this app can least afford.

The chosen shape is the middle: a **narrow typed shared spine** for what crosses
module boundaries, **typed detail tables** for what does not.

---

## 5. API surface sketch (`api-contract-standards` + `supabase-standards`)

Supabase changes the REST conventions: for anything Postgres exposes directly, RLS is
the authorization mechanism and there are no `/v1` URL versions (§ below).

- **CRUD on the timeline → direct PostgREST table access under RLS.** Create an event
  = upsert with the client `id`; read own history = filtered select; the feed = a
  select the RLS policy itself scopes by `visibility` + follow relationship. RLS alone
  fully expresses the authorization rule here, so this is correct as direct table
  access (`supabase-standards`).
- **Aggregations/computations → Postgres RPC functions, `SECURITY INVOKER`** (RLS
  still applies): `get_daily_energy_balance(local_date)`, streak computation,
  rolling-load. Computed server-side, not reassembled on the client.
- **AI cross-module reads + third-party calls → Edge Functions** (Deno): the AI
  layer's function-calling, wearable ingestion, and (Phase 4) payment webhooks.
  External calls never happen on a hot request path.
- **Resource naming:** plural nouns, ≤2 levels nesting, filter params past that
  (`/timeline_events?event_type=…&since=…`), consistent casing — documented once and
  not mixed.
- **Error envelope** (Edge Functions): the single `{ "error": { "code", "message",
  "field" } }` shape with a stable machine-readable `code`; never a raw
  stack/ORM/Postgres error to the client.
- **Versioning without URL versions** (`supabase-standards`): evolve schema by
  add-nullable-then-backfill-then-tighten; expose a **Postgres view as the stable
  public shape** when the base table must change structurally; suffix RPCs
  (`get_daily_energy_balance_v2`) on incompatible contract changes. An old mobile app
  version in the field must keep working.
- **Contract is written down** (OpenAPI/equivalent) and kept in sync — the builder
  agents implement against it.

---

## 6. Data sensitivity (`health-data-compliance` — flag early, cheap now)

**This model touches health/biometric/special-category data throughout** — bodyweight,
body measurements, progress photos, heart rate / HRV / sleep from wearables, GPS
routes (location). Flag `health-data-compliance` for every downstream phase that
persists these. Consequences baked into the model now because retrofitting them into a
data model is expensive:

- **Consent, first-class:** a `user_consents` table (`user_id`, `category` e.g.
  `health` / `location` / `camera`, `purpose_version`, `granted_at`, `revoked_at`).
  Consent is per-category, explicit, at point of use — **not** bundled into signup or
  inferred from continued use. Processing of a category is gated on an active consent
  row. Withdrawal must be functional: revoking degrades gracefully, never crashes and
  never keeps using stale authorized data. This is a real UI surface — `ui-ux-designer`
  must design the per-category, specific-purpose prompts before `mobile-builder`
  implements them (do not ship a single bundled permission prompt).
- **Data minimization:** request only the HealthKit / Health Connect types a feature
  actually uses; don't persist raw wearable streams we don't display or compute from —
  prefer storing the derived value on the spine (that's exactly why recovery arrives as
  bounded `event_type`s carrying the needed metric, not raw firehose).
- **Sensitive demographic attributes** (sex/DOB/height) live in a separate, owner-only,
  consent-gated `profile_health` table (or are omitted) — **not** in `profiles`, so
  their access and consent can be reasoned about independently. Whether we collect them
  at all is §8.
- **Third-party leakage guard:** analytics/crash SDKs must never receive raw health
  values in event payloads. Architectural note for every phase: no `toJSON()` of a
  timeline event into an analytics call.
- **Storage** (progress photos, form videos, avatars): owner-only bucket policies,
  fail-closed, served via short-expiry signed URLs — never a public bucket
  (`supabase-standards`, `security-review`). Phase 2+ but the boundary is stated now.

---

## 7. User-rights code paths the model must support (and this design makes easy)

The unified timeline is a direct win here — one spine to walk:

- **Export:** a real, tested code path reading a user's whole timeline + detail +
  consents into a portable format — not a manual support process.
- **Deletion:** `profiles` → `timeline_events` → detail → child collections via
  `ON DELETE CASCADE`, **plus** storage-object cleanup, **plus** the scheduled
  hard-purge of soft-deleted rows. Deletion must not leave orphaned health rows
  because only `users` was wired up. Hard-delete-vs-anonymize and the post-deletion
  retention window are §8 (legal call).
- **Correction:** a user edits an incorrect logged weight/measurement directly (it's a
  normal editable timeline event), no support ticket.

---

## 8. RLS responsibility boundary (`db-engineer` writes the policies; here is the
boundary)

The ownership boundary is simple and singular: **`auth.uid()` maps 1:1 to
`profiles.id`, and every user-owned row carries (or, via the denormalized `user_id`,
directly exposes) that id.** RLS is enabled in the same migration as each table, never
after (Master Build Prompt project-wide rule).

| Table | RLS posture |
| --- | --- |
| `profiles` | Owner (`id = auth.uid()`) full access. Cross-user SELECT limited to public fields (`username`, `display_name`, `avatar_url`) — via a column-safe view or a scoped policy, so private preference/demographic fields never leak. |
| `timeline_events` | Owner full CRUD (`user_id = auth.uid()`). **The one table with a real cross-user read policy:** SELECT of another user's event is allowed only when `visibility` permits **and** a follow relationship exists — the visibility rule is **encoded in the policy**, never filtered in app code after an over-broad query (`supabase-standards`). |
| every module detail table | Owner-only via the denormalized `user_id = auth.uid()` (that's why §1.5 denormalizes it). |
| `user_consents`, `profile_health` | Owner-only. `profile_health` never widened. |
| reference tables (exercise/food library) | **Not user-owned, not timeline.** Public read; writes restricted to the service role. Full design Phase 2/3 — stated here only to fix the boundary: RLS "owner = user" does **not** apply to shared reference data. |
| storage buckets (photos/videos) | Owner-only, fail-closed, signed URLs. Phase 2+. |

`db-engineer` also owns the index set. From `db-schema-standards`, the spine needs at
least: composite `(user_id, occurred_at)` and `(user_id, local_date)` (the dominant
"this user's events in a date range" pattern), `(user_id, event_type, occurred_at)`
for module-filtered reads, an index supporting the `updated_at` sync cursor, a partial
index for the feed on non-private rows, and the unique PK on `id` for idempotency.
**The spine is the hottest write path in the app** (every log writes it) — each index
must be justified against insert cost, not added reflexively.

---

## 9. Foundational technology choices

### 9.1 Backend / data platform: **Supabase — confirmed.**
The spec and the kit assume it; it is the right call and here is why, not just
deference:
- **RLS is the authorization model**, and the entire timeline is per-user-owned with
  exactly one widening (visibility). That maps onto Postgres RLS almost perfectly —
  the authz rule *is* the row-ownership rule.
- **Postgres is relational**, which is what the spine + detail + cross-module
  JOIN/aggregate design needs; it also brings PostGIS (Module A routes) and strong
  time-series indexing.
- **Supabase Auth** funnels every sign-in method into one `profiles` row (CORE-18),
  and issues short-lived JWTs + refresh tokens the mobile client stores in platform
  secure storage.
- **Edge Functions** give the AI layer, wearable ingestion, and payment webhooks a
  place to make external calls with independent deploy/rollback — off the hot path.
- **Storage with RLS-equivalent policies** covers progress photos / form videos with
  the same fail-closed default.
One caveat to carry forward: PostgREST + RLS is the CRUD path; the AI/orchestration and
third-party work belongs in Edge Functions, not stuffed into the auto-API. Don't let
"everything is a table endpoint" pull orchestration logic into the wrong layer.

### 9.2 Physical timeline representation: **decided in §4** (shared spine + per-module
detail, shared PK).

### 9.3 Mobile client framework: **recommendation, needs the person's confirmation
(§8/team-dependent).**
Constraints the framework must serve: offline-first local store; HealthKit / Health
Connect; wearable SDKs (Garmin/Apple/Wear OS); camera; **on-device sensor-fusion GPS
(AI-13, Phase 8)** and **on-device pose/CV form-check (AI-01, Phase 9)** — the two
heaviest, and both are native-heavy in *any* framework.

**Recommendation: React Native + Expo (with dev/config-plugin builds enabling native
modules).** Reasoning: Phases 0–7 are the bulk of the CORE/UNQ surface and benefit
most from single-codebase velocity and the mature Supabase JS SDK; the genuinely
native-heavy work (AI-13, AI-01) lands late and is isolated to native modules behind a
clean interface regardless of framework, so it doesn't argue for going fully native
now. Local store: a SQLite-based offline layer mirroring the spine + detail shape.

This is a **real decision with a team-skills dependency** (does the team lean
React/JS, or Swift/Kotlin, or Dart?), and the two Phase 8/9 native modules are where a
wrong call hurts. I am flagging it (§10) rather than treating my recommendation as
final, because reversing it after several phases is very expensive.

---

## 10. Third-party integration failure modes (for the pieces that touch the timeline)

- **Wearables (Garmin / Apple Health / Wear OS)** write into the timeline as events
  tagged `source = wearable`. Failure mode if the provider API is down/slow: ingestion
  runs **opportunistically and async via an Edge Function + queue**, never on a hot
  path or a synchronous UI call. Because the local timeline is the UI's source of
  truth, a down wearable API degrades gracefully — no new synced events arrive,
  everything already stored is intact and usable. (Dedup of overlapping device data is
  AI-19, Phase 11 — the spine's `source` + `occurred_at` make it a normal query.)
- **Push notifications** (accountability agent, AI-02) — Phase 9, out of scope here;
  noted so it isn't wired into the timeline hot path later.
- **Payment provider** (Phase 4) — entitlement state hangs off the profile, **not**
  the timeline; webhooks are signature-verified and processed idempotently/async
  (`api-contract-standards`). Out of scope now; boundary stated.

---

## 11. Explicit tradeoffs — what we chose NOT to do, and why

- **No JSONB/EAV metric bag on the spine.** We chose a small fixed set of typed
  cross-module columns instead. We give up "add a metric with zero migration" to keep
  type safety, DB constraints, and index-ability. Revisit only if the cross-module
  metric set starts changing often (it shouldn't).
- **No pure per-module tables with a UNION view as the timeline.** Rejected because it
  pushes cross-module cost onto every read forever and has nowhere to put shared
  visibility/sync/AI-confidence (§4).
- **We are not merging a manual calorie-burn (CORE-11) and a GPS activity into one
  physical row.** They stay two rows; reconciliation happens at read/aggregate time so
  user-entered data is never destroyed. *Which one "wins" for the day's total* is a
  reconciliation policy → §12.
- **We are not building module detail schemas, the exercise/food libraries, community
  graph, or subscription model here.** Phase 1–4 per the roadmap. This doc defines only
  the seam.
- **We are not putting biometric time-series (bodyweight, HR) as profile columns.**
  They are timeline events, so history and health-data handling are uniform.
- **We are not designing field-level merge conflict resolution.** Last-write-wins by
  server `updated_at` is the default; field-level merge is a deliberate future
  deviation if a module proves it needs one, not a default.

---

## 12. Decisions (resolved 2026-07-18) and remaining open questions

**Resolved by the person:**

1. **Mobile framework: React Native + Expo — confirmed.** `mobile-builder` builds the
   app shell against this. Native modules for AI-13/AI-01 (Phase 8/9) stay isolated
   behind a clean interface per §9.3.
2. **Deletion policy: hard-delete after a short grace window (e.g. 30 days), confirmed
   as the working default.** `db-engineer` builds cascade delete (§7) against this.
   Flagged as pending real legal review before public launch — not a blocker for
   Phase 0 schema work, but revisit before Phase 4 (billing/entitlements) if launch
   jurisdiction review surfaces a conflict.
3. **Sensitive demographics (sex, DOB, height): collected, optional, at point-of-use —
   confirmed.** `profile_health` table exists per §6, consent-gated, never required at
   signup. `ui-ux-designer` designs the point-of-use prompts, not a signup field.
4. **Default activity sharing visibility: private by default — confirmed.** Matches
   the spine's fail-closed default (§1.3) with no override needed; users opt in to
   `followers`/`public` per activity or via a global preference in a later phase.

**Still open, deferred — do not block Phase 0 on these:**

5. **Launch jurisdiction(s)** — determines the specific privacy framework governing
   `user_consents` semantics. Working default: build consent to the strictest common
   denominator (GDPR-baseline: explicit per-category consent, functional withdrawal)
   so the model doesn't need rework once jurisdiction is confirmed. Revisit before
   public launch.
6. **Snapshot recompute policy** for `energy_kcal`/`load_score` — architect's
   recommendation (frozen snapshot, not live-recomputed) stands as the working default
   per §1.2; revisit only if analytics needs surface a real conflict.
7. **CORE-11 reconciliation policy** (which of a manual burn vs. GPS activity wins the
   day's total) — needed before Phase 3, not Phase 0. Spine already carries what's
   needed (`source`, `occurred_at`, `duration_seconds`) to implement whatever is
   chosen.
8. **`load_score` normalization formula** — Module C / AI-06's decision (Phase 2/8).
   The spine slot is accepted as-is.
9. **(Minor) Which module ingests wearable recovery samples** — currently modeled
   under `activity`; confirm or reassign when Module A's wearable sync is designed in
   Phase 1.

Two items from the Master Build Prompt's "in parallel with Phase 0" list are
non-engineering and should be started now if they haven't been: the **MileLift
trademark/domain check** (the spec's own Naming section flags it outstanding) and the
**wearable developer-program applications** (Garmin/Apple HealthKit/Wear OS — approval
lead time gates CORE-03 in Phase 1).

---

## 13. UI-surface note (sequencing for the rest of Phase 0)

The timeline model itself has no direct UI. But Phase 0 does have real UI surfaces —
sign-up/login, the profile, onboarding, and the **per-category consent prompts** (§6).
Per the roadmap and the standing rule that a screen must not be built against no design
decision: **`ui-ux-designer` runs before `mobile-builder`** on these. The consent-at-
point-of-use requirement in particular is a UX design problem (specific purpose
strings, per-category prompts, graceful degradation on revocation), not something to
improvise during implementation.
