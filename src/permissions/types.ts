/** Normalized OS permission outcome, independent of which native API produced it. */
export type OsPermissionStatus = 'granted' | 'denied' | 'undetermined' | 'blocked';

/**
 * `blocked` = the user (or the OS) has denied this permission in a way that
 * a fresh in-app prompt can no longer re-trigger the native OS dialog
 * (`canAskAgain: false` on iOS/Android) — the only path forward is Settings.
 * This is the "OS-denied" state screens-phase-0.md §E requires a distinct
 * InlineBanner + "Open Settings" affordance for, never a repeated dead-end
 * in-app prompt.
 */
export function toOsPermissionStatus(response: { status: string; canAskAgain?: boolean }): OsPermissionStatus {
  if (response.status === 'granted') return 'granted';
  if (response.status === 'denied' && response.canAskAgain === false) return 'blocked';
  if (response.status === 'denied') return 'denied';
  return 'undetermined';
}
