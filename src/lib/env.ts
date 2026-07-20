import Constants from 'expo-constants';

/**
 * Typed, validated access to app.config.ts `extra` values. Fails loudly at
 * import time if config is missing rather than letting `undefined` leak into
 * a fetch call somewhere and produce a confusing runtime error later
 * (production-standards: fail specifically, at the boundary).
 */
type Extra = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  consentPurposeVersion: string;
  /**
   * Whether `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` was set at build time — NOT
   * the key itself (see app.config.ts's comment on why the key never enters
   * the JS bundle). Deliberately optional/non-fail-loud, unlike the
   * Supabase values above: an unset Maps key is an expected, supported
   * state (RouteMap's local-geometry fallback), not a broken build.
   */
  googleMapsApiKeyConfigured: boolean;
};

function readExtra(): Extra {
  const extra = Constants.expoConfig?.extra as Partial<Extra> | undefined;

  if (!extra?.supabaseUrl || !extra?.supabaseAnonKey || !extra?.consentPurposeVersion) {
    throw new Error(
      'App config `extra` is missing required Supabase/consent values. ' +
        'This means app.config.ts failed to load env vars — check .env exists and the app was rebuilt after changing it.'
    );
  }

  return {
    supabaseUrl: extra.supabaseUrl,
    supabaseAnonKey: extra.supabaseAnonKey,
    consentPurposeVersion: extra.consentPurposeVersion,
    googleMapsApiKeyConfigured: extra.googleMapsApiKeyConfigured === true,
  };
}

export const env = readExtra();
