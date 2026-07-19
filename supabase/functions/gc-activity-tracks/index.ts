// =============================================================================
// gc-activity-tracks — scheduled orphan-blob GC for the `activity-tracks`
// Storage bucket.
//
// Design ref: docs/architecture/phase-1-module-a.md §2.1, §7, §10;
//             docs/api/save-activity-v1.md
//
// Why this exists (§2.1): "upload the blob first, then call the save RPC
// (save_activity_v1) with raw_track_object_path; a retry of either step is
// safe. An orphaned blob from a failed RPC is reclaimed by a periodic GC job
// that deletes track objects with no matching activity_routes row."
//
// If a client uploads the raw-track blob to Storage but the subsequent
// save_activity_v1 call never completes (app killed, network drop, user
// abandons the flow), the blob is left in Storage with no `activity_routes`
// row ever pointing at it — an orphan that would otherwise sit there forever
// (private-bucket blobs are never listed/served to the owner unless a row
// references them, and there is no client-facing DELETE on this bucket by
// design, see 20260719133900_create_activity_tracks_storage_bucket.sql).
//
// Why this is an Edge Function, not a Postgres job (supabase-standards /
// Phase 0 §5/§9.1 "Edge Functions ... off the hot path" + "PostgREST +
// RLS is the CRUD path; ... don't let 'everything is a table endpoint' pull
// orchestration logic into the wrong layer"): this needs the Storage HTTP
// API (list/remove on storage.objects with cross-user reach), which is not
// something a plain SQL/plpgsql migration can drive — and it must run under
// the service-role key (bypasses RLS, since it operates across every user's
// objects), which per supabase-standards belongs only in an Edge Function's
// environment secrets, never in a client-callable Postgres function.
//
// Scale/design note (explicit, not silently assumed away): Supabase Storage's
// list() API is per-"directory" (non-recursive), and this bucket's layout is
// {user_id}/{timeline_event_id}/track.bin — a 2-level walk. This function
// therefore does a bounded, paginated top-down walk (users -> activities ->
// track.bin) each run, capped by MAX_* constants below so a single run has a
// predictable upper bound on work and can never run unbounded. Because this
// is a GC sweep (idempotent, no cross-run state required), any objects a
// capped run doesn't reach are simply picked up on the next scheduled run —
// this is a real, accepted scaling limit for a Phase 1 user base size, not a
// production-scale materialized-index solution; see the "Follow-up" note in
// docs/api/save-activity-v1.md for the flagged next step if/when this
// becomes a bottleneck.
//
// Authorization: this function must only ever run as the scheduler (pg_cron
// / Supabase's scheduled-invocation mechanism, both of which authenticate
// with the service-role key), never a normal end user hitting the function
// URL. Supabase's edge runtime already verifies the incoming JWT's signature
// before this code runs (default `verify_jwt = true` — do NOT disable this
// for this function); this handler additionally checks the verified JWT's
// `role` claim is exactly `service_role` and rejects anything else with 403,
// so a valid-but-ordinary user JWT can reach the handler but is still turned
// away before any Storage/DB access happens.
//
// Invocation (deploy-time config, devops-engineer's follow-up — documented
// here, not built into this file, per this project's CI/CD doc's explicit
// "no automated deploy" boundary, docs/ops/ci-cd.md §6):
//   Option A — pg_cron + `net.http_post`, e.g.
//     select cron.schedule(
//       'gc-activity-tracks-daily', '0 4 * * *',
//       $$ select net.http_post(
//         ...
//       ) $$
//     );
//   posts to https://<project-ref>.functions.supabase.co/gc-activity-tracks
//   with `Authorization: Bearer <service_role_key>` (stored in Vault, not
//   inlined in the cron job SQL).
//   Option B — Supabase Dashboard's native "Scheduled Edge Functions" cron
//   trigger (Functions -> gc-activity-tracks -> Schedule), which invokes
//   with the service role automatically.
// Either is compatible with this handler's authorization check as written;
// pick whichever this project's Supabase plan/CLI version supports (not
// determinable from this environment — see task report).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET_NAME = "activity-tracks";

// A freshly-uploaded blob with no activity_routes row yet is *expected*,
// not orphaned -- the save_activity_v1 call may simply not have landed yet.
// Only objects older than this are eligible for deletion.
const GRACE_PERIOD_HOURS = 24;

// Pagination page size for every Storage list() call.
const LIST_PAGE_SIZE = 100;

// Bounded per-run work caps (see the scale note above) -- a run stops
// early rather than running unbounded; leftover work is picked up by the
// next scheduled run.
const MAX_USER_FOLDERS_PER_RUN = 500;
const MAX_TRACK_OBJECTS_PER_RUN = 2000;

// Storage remove() batch size (keeps individual API calls small).
const DELETE_BATCH_SIZE = 100;

interface GcSummary {
  dryRun: boolean;
  userFoldersScanned: number;
  trackObjectsScanned: number;
  orphansFound: number;
  orphansDeleted: number;
  deleteErrors: string[];
  cappedByUserFolderLimit: boolean;
  cappedByObjectLimit: boolean;
}

function decodeJwtPayload(authorizationHeader: string | null): Record<string, unknown> | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  // ---------------------------------------------------------------------
  // Authorization: service_role callers only (see header comment). The
  // platform has already verified this JWT's signature/expiry before this
  // code runs (verify_jwt defaults to true for this function); we only
  // need to check the role claim it carried.
  // ---------------------------------------------------------------------
  const claims = decodeJwtPayload(req.headers.get("Authorization"));
  if (!claims || claims.role !== "service_role") {
    return new Response(
      JSON.stringify({
        error: { code: "FORBIDDEN", message: "gc-activity-tracks may only be invoked with the service-role key.", field: null },
      }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("gc-activity-tracks: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in function environment");
    return new Response(
      JSON.stringify({ error: { code: "MISCONFIGURED", message: "Missing Supabase service credentials in function environment.", field: null } }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const summary: GcSummary = {
    dryRun,
    userFoldersScanned: 0,
    trackObjectsScanned: 0,
    orphansFound: 0,
    orphansDeleted: 0,
    deleteErrors: [],
    cappedByUserFolderLimit: false,
    cappedByObjectLimit: false,
  };

  const orphanObjectPaths: string[] = []; // paths as understood by storage.remove(): "{user_id}/{timeline_event_id}/track.bin"
  const gracePeriodCutoff = new Date(Date.now() - GRACE_PERIOD_HOURS * 60 * 60 * 1000);

  // ---------------------------------------------------------------------
  // Level 1: top-level "folders" in the bucket == user_id segments.
  // ---------------------------------------------------------------------
  let userOffset = 0;
  outer: while (true) {
    const { data: userEntries, error: listUsersError } = await supabase.storage
      .from(BUCKET_NAME)
      .list("", { limit: LIST_PAGE_SIZE, offset: userOffset, sortBy: { column: "name", order: "asc" } });

    if (listUsersError) {
      console.error("gc-activity-tracks: failed listing top-level bucket folders", listUsersError.message);
      return new Response(
        JSON.stringify({ error: { code: "STORAGE_LIST_FAILED", message: listUsersError.message, field: null } }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }
    if (!userEntries || userEntries.length === 0) break;

    for (const userEntry of userEntries) {
      // Supabase Storage represents a "folder" as an entry with id === null.
      if (userEntry.id !== null) continue; // a stray top-level object, not a user folder -- ignore
      const userId = userEntry.name;

      if (summary.userFoldersScanned >= MAX_USER_FOLDERS_PER_RUN) {
        summary.cappedByUserFolderLimit = true;
        break outer;
      }
      summary.userFoldersScanned++;

      // -----------------------------------------------------------------
      // Level 2: {user_id}/{timeline_event_id} activity folders.
      // -----------------------------------------------------------------
      let activityOffset = 0;
      while (true) {
        const { data: activityEntries, error: listActivitiesError } = await supabase.storage
          .from(BUCKET_NAME)
          .list(userId, { limit: LIST_PAGE_SIZE, offset: activityOffset, sortBy: { column: "name", order: "asc" } });

        if (listActivitiesError) {
          console.error(`gc-activity-tracks: failed listing activities for user ${userId}`, listActivitiesError.message);
          break; // move on to the next user rather than aborting the whole run
        }
        if (!activityEntries || activityEntries.length === 0) break;

        for (const activityEntry of activityEntries) {
          if (activityEntry.id !== null) continue; // not a folder
          const timelineEventId = activityEntry.name;

          if (summary.trackObjectsScanned >= MAX_TRACK_OBJECTS_PER_RUN) {
            summary.cappedByObjectLimit = true;
            break outer;
          }

          // ---------------------------------------------------------
          // Level 3: the track.bin object itself, for its created_at.
          // ---------------------------------------------------------
          const activityPath = `${userId}/${timelineEventId}`;
          const { data: trackEntries, error: listTrackError } = await supabase.storage
            .from(BUCKET_NAME)
            .list(activityPath, { limit: 10 });

          if (listTrackError || !trackEntries) {
            console.error(`gc-activity-tracks: failed listing track object at ${activityPath}`, listTrackError?.message);
            continue;
          }

          const trackFile = trackEntries.find((e) => e.name === "track.bin");
          if (!trackFile) continue; // nothing to reconcile (unexpected empty activity folder)

          summary.trackObjectsScanned++;

          const createdAt = trackFile.created_at ? new Date(trackFile.created_at) : null;
          if (!createdAt || createdAt > gracePeriodCutoff) {
            // Too new -- may still be mid-flight (blob uploaded, save_activity_v1
            // not yet called/retried). Never delete inside the grace window.
            continue;
          }

          // activity_routes.raw_track_object_path stores the FULL path
          // including the bucket name prefix (see
          // 20260719133300_create_activity_routes.sql's CHECK constraint) --
          // the Storage object `name` itself does not include it.
          const expectedDbPath = `${BUCKET_NAME}/${userId}/${timelineEventId}/track.bin`;

          const { data: routeRow, error: routeLookupError } = await supabase
            .from("activity_routes")
            .select("timeline_event_id")
            .eq("raw_track_object_path", expectedDbPath)
            .maybeSingle();

          if (routeLookupError) {
            console.error(`gc-activity-tracks: activity_routes lookup failed for ${expectedDbPath}`, routeLookupError.message);
            continue; // do not delete on an inconclusive lookup
          }

          if (routeRow) continue; // referenced -- not an orphan

          summary.orphansFound++;
          orphanObjectPaths.push(`${activityPath}/track.bin`);
        }

        activityOffset += LIST_PAGE_SIZE;
        if (activityEntries.length < LIST_PAGE_SIZE) break;
      }
    }

    userOffset += LIST_PAGE_SIZE;
    if (userEntries.length < LIST_PAGE_SIZE) break;
  }

  // ---------------------------------------------------------------------
  // Delete orphans in batches (unless dry-run).
  // ---------------------------------------------------------------------
  if (!dryRun) {
    for (let i = 0; i < orphanObjectPaths.length; i += DELETE_BATCH_SIZE) {
      const batch = orphanObjectPaths.slice(i, i + DELETE_BATCH_SIZE);
      const { data: removed, error: removeError } = await supabase.storage.from(BUCKET_NAME).remove(batch);
      if (removeError) {
        console.error("gc-activity-tracks: batch delete failed", removeError.message, { batchSize: batch.length });
        summary.deleteErrors.push(removeError.message);
        continue;
      }
      summary.orphansDeleted += removed?.length ?? 0;
    }
  }

  console.log("gc-activity-tracks: run complete", JSON.stringify(summary));

  return new Response(JSON.stringify({ data: summary }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
