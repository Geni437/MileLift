import * as Notifications from 'expo-notifications';

/**
 * The CORE-12 rest timer's one server-free, network-free requirement: fire a
 * local notification at zero so a backgrounded/screen-locked rest still
 * reaches the user ("Rest done — next set up.", design doc §CORE-12). Pure
 * client-side scheduling — no network, no server design beyond the two
 * `workout_set_logs` rest columns (§9.5).
 */
const REST_DONE_IDENTIFIER = 'milelift-rest-timer-done';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let permissionRequested = false;

/** Best-effort permission request — a denied/undetermined notification permission degrades to "the in-app timer still counts down and shows Rest done, it just won't reach you if you've left the app," never a crash. */
export async function ensureRestTimerNotificationPermission(): Promise<void> {
  if (permissionRequested) return;
  permissionRequested = true;
  try {
    const settings = await Notifications.getPermissionsAsync();
    if (settings.status !== 'granted') {
      await Notifications.requestPermissionsAsync();
    }
  } catch {
    // Notifications are a best-effort enhancement on top of the in-app
    // timer, not a hard requirement — never let a permission-check failure
    // interrupt the rest timer itself.
  }
}

export async function scheduleRestDoneNotification(secondsFromNow: number): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(REST_DONE_IDENTIFIER).catch(() => undefined);
    await Notifications.scheduleNotificationAsync({
      identifier: REST_DONE_IDENTIFIER,
      content: { title: 'Rest done', body: 'Rest done — next set up.', sound: true },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: Math.max(1, Math.round(secondsFromNow)) },
    });
  } catch {
    // Best-effort — see ensureRestTimerNotificationPermission comment.
  }
}

export async function cancelRestDoneNotification(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(REST_DONE_IDENTIFIER);
  } catch {
    // Nothing to cancel, or the platform rejected it — either way, not fatal.
  }
}
