# `search_foods_v1` / `resolve_barcode_v1` — RPC contract

Status: implemented and live. Backing migrations:
`supabase/migrations/20260722110000_enable_pg_trgm.sql`,
`supabase/migrations/20260722110100_create_food_search_index_and_rpcs.sql`.

Design ref: `docs/architecture/phase-3-module-b.md` §2.2, §5, §8, §13.
Conventions ref: `api-contract-standards`, `supabase-standards`.

**Ownership note:** §13's implementation routing lists "the foods search
index with the search RPC" under `db-engineer` but separately lists
`search_foods_v1` by name under `backend-builder`'s RPC list. This is
resolved as: `db-engineer` ships a correct, production-safe, but
intentionally straightforward ranking implementation now (exact/prefix name
match + a small data-quality/source tie-break) so the §2.2 access-pattern
contract is live and testable immediately — never a stub. `backend-builder`
may ship richer fuzzy-matching/typo-tolerant ranking later as
`search_foods_v2` (this project's versioning-without-URL-versions
convention) without breaking this contract; `search_foods_v1` must keep
working for any app version already in the field.

These are Postgres functions, both `SECURITY DEFINER` (a deliberate,
justified exception to this project's `SECURITY INVOKER` default — see the
"Why `SECURITY DEFINER`" section below), called via PostgREST's
`/rest/v1/rpc/<function_name>` endpoint.

---

## 1. Response shape

Same envelope as every other RPC in this project: always **HTTP 200** from
PostgREST, body shaped as either `{ "data": { ... } }` or
`{ "error": { "code": "...", "message": "...", "field": "..." } }`. The
mobile client must branch on the presence of `error` in the body, not on
HTTP status.

---

## 2. Why `SECURITY DEFINER`

`public.foods`, `public.food_nutrients`, and `public.food_servings` carry
**no client GRANT of any kind** — not even `SELECT` — to `authenticated` or
`anon` (see `20260722100000_create_foods.sql`'s migration header for the
full reasoning: this is the strictest available reading of the
architecture doc's "no unbounded list grant/endpoint" rule, foreclosing any
future `.select('*')` on a table 3+ orders of magnitude larger than the
`exercises` library, which would silently truncate at
`supabase/config.toml`'s `max_rows = 1000`).

A `SECURITY INVOKER` function running as `authenticated` could not read
these tables at all, regardless of RLS. Both RPCs below are `SECURITY
DEFINER` instead, and — per `supabase-standards`' explicit requirement for
this exception — both validate authorization *inside the function body*
(`auth.uid() is not null`) and filter `is_active` explicitly in every query,
since RLS does not filter for a `SECURITY DEFINER` function running as the
table owner. **`EXECUTE` is revoked from `anon`**, so only a signed-in user
can call either function.

---

## 3. `search_foods_v1(p_query, p_cursor, p_limit)`

Bounded, ranked, cursor-paginated food-name search. **The only text-search
read path** — the catalog has no other query surface (§2.2).

### 3.1 Parameters

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `p_query` | text | yes | Non-blank, ≤ 200 chars. |
| `p_cursor` | jsonb | no | `null` for the first page; otherwise the previous response's `data.next_cursor`, passed back verbatim. |
| `p_limit` | integer | no | Default 20, max 50 (both named constants, well under `max_rows = 1000`). |

### 3.2 Ranking

`exact case-insensitive name match` (100) > `case-insensitive name prefix
match` (80) > `name contains the query` (60) > `pg_trgm similarity score`
(0–50) — each **plus** a small `data_quality` boost (high=3, medium=2,
low=1) and a small `source` tie-break (`usda_fdc`=0.5,
`milelift_authored`=0.25, `open_food_facts`=0), both deliberately small
relative to the match-tier gaps so they only break ties among otherwise-
similar name matches.

### 3.3 Pagination

Keyset pagination on `(rank_score DESC, id ASC)` — a stable total order.
Never `OFFSET`-based. `data.next_cursor` is `null` once the results are
exhausted.

### 3.4 Response shape (success)

```jsonc
{
  "data": {
    "items": [
      {
        "food_id": "uuid",
        "source": "usda_fdc" | "open_food_facts" | "milelift_authored",
        "name": "text",
        "brand": "text | null",
        "barcode": "text | null",
        "basis": "per_100g" | "per_100ml",
        "energy_kcal": "numeric",
        "protein_g": "numeric | null",
        "carb_g": "numeric | null",
        "fat_g": "numeric | null",
        "data_quality": "high" | "medium" | "low",
        "attribution": "text | null",
        "default_serving": { "id": "uuid", "label": "text", "gram_or_ml_weight": "numeric" } | null
      }
    ],
    "next_cursor": { "rank_score": "numeric", "id": "uuid" } | null
  }
}
```

### 3.5 Error codes

`UNAUTHENTICATED`, `VALIDATION_ERROR` (blank/too-long query, limit out of
range, malformed cursor), `SEARCH_FAILED` (unexpected DB error — never a
raw Postgres error to the client).

---

## 4. `resolve_barcode_v1(p_barcode)`

Exact point lookup on the indexed `barcode` column — never a scan (§2.2 item
2, §2.4). Searches **only** `public.foods` (the global reference catalog) —
**not** `custom_foods`; the user's own custom foods are read directly by the
mobile client under normal RLS + grants, a separate query.

### 4.1 Response shape (hit)

```jsonc
{
  "data": {
    "food_id": "uuid", "source": "...", "name": "...", "brand": "... | null",
    "barcode": "...", "basis": "per_100g" | "per_100ml",
    "energy_kcal": "numeric", "protein_g": "numeric | null",
    "carb_g": "numeric | null", "fat_g": "numeric | null",
    "data_quality": "...", "attribution": "... | null",
    "servings": [{ "id": "uuid", "label": "text", "gram_or_ml_weight": "numeric", "is_default": "boolean" }]
  }
}
```

### 4.2 Response shape (miss) — never a silent empty result

```jsonc
{ "error": { "code": "BARCODE_NOT_FOUND", "message": "...", "field": "barcode" } }
```

Per the CORE-07 barcode-miss flow (§2.4 step 3), the client routes a
`BARCODE_NOT_FOUND` response to custom-food creation (a `custom_foods` row
carrying the scanned barcode, creatable offline) — never a dead end.

### 4.3 Multi-match tie-break

If more than one active `foods` row shares a barcode (a real, expected
possibility before the ingestion job's deterministic merge resolves it,
§2.1), the highest-precedence source wins (`usda_fdc` > `milelift_authored`
> `open_food_facts`), then the most recently updated row — a documented
tie-break, not a silent arbitrary pick.

### 4.4 Error codes

`UNAUTHENTICATED`, `VALIDATION_ERROR` (blank barcode), `BARCODE_NOT_FOUND`,
`BARCODE_LOOKUP_FAILED`.
