/**
 * Pure loop-prevention decision for CORE-03 two-way Health Connect sync
 * (architecture §3.3): "wearable_links records ... the outbound Health
 * Connect record id we created (so read-back SKIPS our own writes)."
 * Kept separate from the native Health Connect I/O so the actual decision
 * logic is unit-testable without a device (test-strategy).
 */

export type HealthConnectSessionSummary = {
  recordId: string;
  externalDataOriginPackageName?: string | null;
};

const MILELIFT_PACKAGE_NAME = 'com.milelift.app';

/**
 * A record should be skipped on import if either:
 *   1. It's a record MileLift itself wrote back (its id is in our own
 *      `outbound` wearable_links — the authoritative check), or
 *   2. Its Health Connect `dataOrigin` package name is MileLift's own
 *      (defense-in-depth: catches a record whose id we haven't linked yet,
 *      e.g. a link write that failed to sync — never double-count our own
 *      data because one bookkeeping row didn't make it).
 */
export function shouldSkipInboundRecord(record: HealthConnectSessionSummary, ourOutboundRecordIds: ReadonlySet<string>): boolean {
  if (ourOutboundRecordIds.has(record.recordId)) return true;
  if (record.externalDataOriginPackageName === MILELIFT_PACKAGE_NAME) return true;
  return false;
}

/** Filters a batch of inbound Health Connect sessions down to the ones actually worth importing. */
export function filterImportableRecords<T extends HealthConnectSessionSummary>(
  records: readonly T[],
  ourOutboundRecordIds: ReadonlySet<string>,
  alreadyImportedExternalIds: ReadonlySet<string>
): T[] {
  return records.filter((record) => {
    if (shouldSkipInboundRecord(record, ourOutboundRecordIds)) return false;
    if (alreadyImportedExternalIds.has(record.recordId)) return false; // already-linked inbound record — re-read is a no-op, not a re-import
    return true;
  });
}
