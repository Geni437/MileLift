import * as Localization from 'expo-localization';

import type { UnitDistance, UnitWeight } from '../db/types';

// The handful of locales that use imperial units for everyday distance/weight.
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

/**
 * Locale-inferred unit defaults (screens-phase-0.md §D: "Default from device
 * locale"). Used both as the onboarding Step 3 field's initial value and as
 * the "Skip for now" fallback (§D: "every step has a valid default ... so
 * Skip always yields a usable account").
 */
export function inferUnitsFromLocale(): { unitWeight: UnitWeight; unitDistance: UnitDistance } {
  const region = Localization.getLocales()[0]?.regionCode ?? undefined;
  const imperial = region ? IMPERIAL_REGIONS.has(region) : false;
  return imperial ? { unitWeight: 'lb', unitDistance: 'mi' } : { unitWeight: 'kg', unitDistance: 'km' };
}

export function inferTimezone(): string {
  return Localization.getCalendars()[0]?.timeZone ?? 'UTC';
}
