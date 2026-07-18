---
name: nutrition-data-standards
description: Standards for sourcing and maintaining the food/nutrition database from free/open data (USDA FoodData Central, Open Food Facts) rather than a licensed provider — data quality handling, attribution compliance, merge/dedup strategy, and ongoing sync. Use for CORE-06, CORE-07, and any feature reading nutrition data.
when_to_use: Invoke when building or reviewing food database ingestion, search, barcode resolution, or any nutrition-data-dependent feature.
---

# Nutrition Data Standards

CORE-06 uses free/open sources (USDA FoodData Central, Open Food Facts)
rather than a licensed provider. This is the right call to avoid ongoing
per-call licensing cost, but it trades that for real data-quality and
maintenance work this skill exists to make explicit rather than discovered
later as a string of confusing support tickets about wrong calorie counts.

## Know what each source actually is

- **USDA FoodData Central (FDC)**: authoritative for generic/whole foods
  and government-verified branded-food entries. Public domain, well
  structured, but weaker coverage of restaurant items and newer branded
  products than a commercial provider — this is expected, not a bug to
  chase.
- **Open Food Facts (OFF)**: crowd-sourced, much larger raw coverage
  (especially branded/packaged products with barcodes) but variable data
  quality — entries can be incomplete, mis-scanned, or wrong, because
  anyone can contribute. Treat OFF entries as lower-trust by default than
  FDC entries covering the same product.

## Data quality handling is not optional polish here

Because neither source is a paid, SLA-backed provider, the app's own
handling of uncertain data matters more than it would with a licensed
database:

- Surface a data-quality/confidence signal per entry (e.g., FDC entries and
  OFF entries with complete, internally-consistent macros default to
  higher confidence; sparse or inconsistent OFF entries default to lower)
  and feed it into the same confidence-escalation pattern
  `ai-orchestration-standards` requires elsewhere — a low-confidence
  nutrition entry should prompt the user to confirm or correct it, not
  silently log a possibly-wrong calorie count as fact.
- CORE-11's "editable, self-correcting logs" principle (AI-11) is
  specifically what compensates for open-data quality gaps — make sure
  every nutrition entry, however it was sourced, is genuinely editable by
  the user, and that a user correction is retained (ideally contributed
  back to a local override table) rather than being overwritten the next
  time the same barcode is scanned.

## Merge and dedup strategy

- Define a deterministic resolution order when both sources have an entry
  for the same product (e.g., prefer FDC for generic/whole foods, prefer
  OFF for barcode-scanned branded items where FDC has no match, and flag
  — don't silently pick one — when both exist and materially disagree on
  macros for the same barcode).
- Normalize serving size and units before comparing or merging entries —
  this is one of the most common real-world nutrition-app bugs: two
  sources reporting "per 100g" vs. "per serving" vs. "per package" for
  what looks like the same field, silently producing numbers that are
  off by whatever the serving-size ratio happens to be.

## Attribution and licensing compliance

- FDC data is public domain but USDA still expects citation; Open Food
  Facts is published under the Open Database License (ODbL), which carries
  share-alike and attribution obligations. Confirm the current license
  terms for each source before shipping (terms and specific requirements
  can change) and make sure attribution actually appears where the license
  requires it, not just noted in an internal doc and forgotten in the
  shipped app.

## Barcode resolution flow (CORE-07)

1. Look up the scanned barcode against the local cached OFF/FDC dataset
   first (fast, offline-capable, per CORE-17's offline-logging
   requirement — don't make barcode scanning require connectivity for data
   this common).
2. On no match, allow the user to manually create the entry and (if there's
   a mechanism to do so within the license terms) contribute it back
   locally so re-scanning the same barcode doesn't repeat the miss.
3. Every barcode-resolved entry still passes through the same
   confidence/edit path as any other nutrition entry — a barcode match
   isn't automatically higher-confidence than a text/photo-parsed entry if
   the underlying source data for that barcode is itself sparse.

## Keeping the dataset current

This is not a one-time import. FDC releases periodic dataset updates; OFF
changes continuously as a live crowd-sourced database. Define an explicit
ingestion/sync job (not a manual, occasional re-download) with a documented
cadence, and version the local dataset snapshot so a bad upstream update
can be rolled back rather than silently corrupting search results for every
user until someone notices.
