import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * Dynamic Expo config. Supabase project URL + anon key come from environment
 * variables (see `.env.example`), never a hardcoded literal in source —
 * `production-standards` (no environment-specific URLs/keys in source) and
 * `mobile-architecture-standards`.
 *
 * The anon/publishable key is safe to ship in a mobile client (it identifies
 * the project and every table it touches is governed by RLS); it is still
 * routed through env config rather than inlined so per-environment
 * (dev/staging/prod Supabase projects) swaps are a config change, not a code
 * change, per `devops-engineer`'s environment story.
 *
 * FAIL LOUDLY if the env vars are missing rather than silently booting
 * against `undefined` (production-standards: input validation at the
 * boundary, fail specifically) — a misconfigured build should not produce an
 * app that opens and then mysteriously fails every network call.
 */
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env (or set them in your CI/EAS environment) before building.'
  );
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'MileLift',
  slug: 'milelift',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'milelift',
  userInterfaceStyle: 'dark',
  // New Architecture is the default (and only supported mode) as of this RN
  // version (0.86) / Expo SDK (57) — no explicit flag needed, and the
  // `ExpoConfig` type for this SDK no longer declares one.
  // Native splash screen config lives on the `expo-splash-screen` plugin
  // entry below, not this top-level `splash` key — that key is PWA/web-only
  // in this SDK's ExpoConfig type.
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.milelift.app',
    infoPlist: {
      // Purpose strings mirror the in-app priming-sheet copy exactly
      // (docs/design/screens-phase-0.md §E) — the OS prompt must not say
      // something different from what the user already agreed to.
      NSHealthShareUsageDescription:
        'MileLift can read your workouts, heart rate, and sleep from Apple Health so training load and recovery reflect what your body actually did.',
      NSHealthUpdateUsageDescription:
        'MileLift does not write data back to Apple Health in Phase 0.',
      NSLocationWhenInUseUsageDescription:
        'Location maps your route while an activity is recording, so you get distance, pace, and the map afterward. MileLift only uses location during an active recording.',
      NSCameraUsageDescription:
        'The camera lets you take progress photos to track how your body changes over time.',
      NSPhotoLibraryUsageDescription:
        'Choose a photo from your library to use as a progress photo.',
    },
  },
  android: {
    package: 'com.milelift.app',
    adaptiveIcon: {
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
      backgroundColor: '#0B0F16',
    },
    // No ACCESS_BACKGROUND_LOCATION — recording is deliberately foreground-
    // only (mobile-architecture-standards, and matching the existing E2
    // consent copy's promise: "never in the background between
    // activities"). Adding true background/screen-off recording later needs
    // a new consent purpose string and Google Play's background-location
    // prominent-disclosure review process — flagged, not silently assumed.
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'CAMERA'],
  },
  web: {
    favicon: './assets/favicon.png',
    bundler: 'metro',
  },
  plugins: [
    'expo-router',
    [
      'expo-build-properties',
      {
        // Health Connect's client library (react-native-health-connect)
        // requires minSdk 26; Expo's default of 24 fails the Android
        // manifest merge. 26 (Android 8.0) is well within the app's
        // realistic device support floor.
        android: {
          minSdkVersion: 26,
        },
      },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        resizeMode: 'contain',
        backgroundColor: '#0B0F16', // palette.graphite[950] — see docs/design/theme.ts
      },
    ],
    'expo-font',
    'expo-secure-store',
    'expo-sqlite',
    'expo-web-browser',
    'expo-localization',
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Location maps your route while an activity is recording, so you get distance, pace, and the map afterward.',
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission: 'The camera lets you take progress photos to track how your body changes over time.',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Choose a photo from your library to use as a progress photo.',
      },
    ],
    // CORE-03 (Android-only Health Connect). This plugin only wires the
    // required AndroidManifest intent-filter (permissions-rationale
    // activity) — no config options.
    'react-native-health-connect',
    // CORE-02 RouteMap, tiled from OpenStreetMap (no API key/account of any
    // kind needed, unlike react-native-maps' Google-Maps-SDK dependency on
    // Android). MapLibre's own location engine ("default") is used rather
    // than the optional Google Play Services one, keeping the whole map
    // stack Google-free.
    '@maplibre/maplibre-react-native',
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    // Consumed by src/lib/consent.ts as the `purpose_version` written to
    // user_consents — bump when a purpose string in the consent sheets
    // (docs/design/screens-phase-0.md §E) materially changes, so historical
    // consent rows stay tied to the disclosure text the user actually saw.
    consentPurposeVersion: '2026-07-19.1',
    eas: {
      // EAS project id for @macveren/milelift (created via `eas build` project
      // setup). This is a public project identifier, not a secret, and only
      // has meaning paired with the account's own EAS authentication.
      projectId: '4ad59e81-376d-4925-b341-e07794f011e0',
    },
  },
});
