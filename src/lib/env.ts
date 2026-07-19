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
  };
}

export const env = readExtra();
