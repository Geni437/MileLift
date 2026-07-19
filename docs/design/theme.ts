/**
 * MileLift Design Tokens — canonical, machine-readable source of truth.
 *
 * This file is the single origin for every color, type, spacing, and motion
 * value in the app. `docs/design/tokens.md` explains the *reasoning and roles*;
 * this file carries the *values* `mobile-builder` imports. If a screen needs a
 * value that isn't here, that's a signal to add a named token here first — never
 * a one-off literal in a component (see production-standards: no magic values).
 *
 * Stack: React Native + Expo. Fonts are loaded via @expo-google-fonts/* and the
 * per-weight family strings below are exactly the identifiers those packages
 * export (RN requires a distinct fontFamily per weight for custom fonts — there
 * is no fontWeight-maps-to-file behavior for loaded fonts).
 *
 * Theme model: dark is the default and primary brand expression (the spec calls
 * for a "dark, serious base layer"). A light theme is defined for later
 * outdoor/daylight surfaces (mobile-architecture-standards: sunlight contrast).
 * Both expose an identical set of semantic keys, so components reference
 * `theme.color.accent.primary`, never a raw palette value or a hex literal.
 */

// ---------------------------------------------------------------------------
// 1. PALETTE — raw scales. Components should NOT reference these directly;
//    they exist to be mapped into the semantic `themes` object below.
// ---------------------------------------------------------------------------

export const palette = {
  // Foundation — "Iron": a cool, blue-tinted graphite. Deliberately not a
  // corporate navy; reads as cold steel / pre-dawn sky, the shared base both
  // the run and the lift sit on.
  graphite: {
    950: '#0B0F16',
    900: '#0F141D',
    850: '#131A24',
    800: '#19212D',
    750: '#212B39',
    700: '#2B3646',
    600: '#3A4657',
    500: '#4E5B6E',
    400: '#697687',
    300: '#8B97A7',
    200: '#B2BBC8',
    100: '#D7DCE4',
    50: '#EEF1F6',
    25: '#F7F8FB',
  },

  // Activity / Energy — "Ember/Dawn". The primary brand accent and CTA color.
  // Honors the spec's Strava-derived "orange = activity/energy" ROLE, but is
  // pulled to a golden amber (hue ~32°, the light of a sunrise first mile),
  // deliberately away from Strava's saturated red-orange (hue ~17°). See
  // tokens.md "Originalization notes" — this is the hardest role to originalize.
  ember: {
    700: '#B85C0E',
    600: '#DA700F',
    500: '#F5871F',
    400: '#FF9F45',
    300: '#FFB871',
    200: '#FFD3A6',
    tint: 'rgba(245,135,31,0.12)',
  },

  // Trust / Data / Accuracy — "Steel Cyan". Honors the MFP+Jefit "blue =
  // trust/data" role, re-derived as an instrument-panel cyan/teal rather than
  // a royal app-blue, so it reads as precision/telemetry and pairs with the
  // graphite foundation instead of competing with the ember accent.
  cyan: {
    700: '#1E6F86',
    600: '#2A8BA6',
    500: '#38A9C9',
    400: '#5DC1DC',
    300: '#8AD5E8',
    tint: 'rgba(56,169,201,0.14)',
  },

  // AI / Intensity — "Voltage". The spec's Fitbod-derived "red = AI/intensity"
  // role, deliberately re-cast as an electric violet. Two reasons: (1) it moves
  // furthest from the competitor's actual color, and (2) it keeps the warm
  // channel exclusively for activity and frees a clean functional red for
  // errors. Reads as high-voltage / smart-system. Used sparingly (near-zero in
  // Phase 0).
  plasma: {
    700: '#4E32C4',
    600: '#6544E8',
    500: '#7C5CFF',
    400: '#9B82FF',
    300: '#BCACFF',
    tint: 'rgba(124,92,255,0.16)',
  },

  // Coaching / Growth / Success — "Growth". Honors the Caliber "green/lime =
  // coaching/growth" role, re-derived as a fresh emerald (not neon lime) so it
  // also carries the functional success/confirmed/synced meaning cleanly.
  growth: {
    700: '#1B8B54',
    600: '#23A968',
    500: '#2FC978',
    400: '#57DA95',
    300: '#8CE8B7',
    tint: 'rgba(47,201,120,0.14)',
  },

  // Functional-only reds/golds (not part of the brand-role mapping).
  danger: {
    600: '#D33A28',
    500: '#EF4E3A',
    400: '#F47563',
    tint: 'rgba(239,78,58,0.14)',
  },
  gold: {
    600: '#DA9E17',
    500: '#F5B830',
    tint: 'rgba(245,184,48,0.14)',
  },

  common: {
    white: '#FFFFFF',
    black: '#000000',
    transparent: 'transparent',
  },
} as const;

// ---------------------------------------------------------------------------
// 2. SEMANTIC THEMES — what components actually consume. Same keys in both.
// ---------------------------------------------------------------------------

const darkColor = {
  bg: {
    canvas: palette.graphite[950], // app background, deepest
    surface: palette.graphite[900], // primary panels
    raised: palette.graphite[850], // cards / raised surfaces (elevation via lightness, not shadow)
    inset: palette.graphite[800], // inputs, wells
    overlay: 'rgba(6,9,13,0.72)', // modal scrim
  },
  border: {
    subtle: palette.graphite[750],
    default: palette.graphite[700],
    strong: palette.graphite[600],
  },
  text: {
    primary: palette.graphite[50], // ~13:1 on canvas
    secondary: palette.graphite[300], // ~5.6:1 on canvas — AA normal text
    tertiary: palette.graphite[400], // ~4.5:1 — AA large / meta only
    disabled: palette.graphite[500],
    onAccent: palette.graphite[950], // dark ink on ember/growth fills
    onDanger: palette.common.white,
  },
  accent: {
    primary: palette.ember[500], // activity + primary CTA
    primaryPressed: palette.ember[600],
    primaryTint: palette.ember.tint,
    data: palette.cyan[500], // tracking / trust / accuracy
    dataTint: palette.cyan.tint,
    ai: palette.plasma[500], // AI / intensity
    aiTint: palette.plasma.tint,
    growth: palette.growth[500], // coaching / growth
    growthTint: palette.growth.tint,
  },
  feedback: {
    success: palette.growth[500],
    successTint: palette.growth.tint,
    danger: palette.danger[500], // danger TEXT/ICON/BORDER on dark (5.3:1 on canvas)
    dangerSolid: palette.danger[600], // danger FILL carrying white text.onDanger (4.8:1)
    dangerTint: palette.danger.tint,
    warning: palette.gold[500],
    warningTint: palette.gold.tint,
    info: palette.cyan[500],
    infoTint: palette.cyan.tint,
  },
  // Map — route rendering over map tiles (Phase 1, CORE-02). The route line is
  // "the Mile drawn on the earth," so it IS accent.primary (ember) — these are
  // semantic aliases, NOT a new hue, so the map component references a named
  // role instead of a raw palette value, and gains a tile-contrast casing plus
  // start/finish markers the flat accent tokens don't express. Rationale in
  // tokens.md §2.1. No new color family is introduced (design-reviewer floor).
  map: {
    route: palette.ember[500], // simplified_path stroke
    routeCasing: 'rgba(11,15,22,0.55)', // graphite-950 @55% — dark casing so the ember line holds contrast over any tile color
    startMarker: palette.growth[500], // start = go/begin (growth = "go")
    finishMarker: palette.ember[500], // finish = the Meridian origin (ember)
  },
  // Focus ring is intentionally cyan, NOT the ember CTA color, so a focused
  // primary button still shows a visible ring distinct from its own fill.
  focusRing: palette.cyan[400],
};

/**
 * NOTE (mobile-builder, type-check fix only — no token VALUES changed):
 * `palette` above is `as const`, so every `palette.x[y]` lookup already has
 * its own string-literal type (e.g. `"#0B0F16"`), regardless of whether
 * `darkColor` itself uses `as const`. That made `lightColor: typeof
 * darkColor` impossible to satisfy — a literal type can only ever hold that
 * one exact string — and failed `tsc --noEmit` outright even though the
 * shapes match. `Widen<T>` keeps the useful part of `typeof darkColor`
 * (lightColor must define the exact same keys as darkColor — a real,
 * worthwhile completeness check) while widening every leaf string to plain
 * `string`, so different color values are allowed. Doesn't affect the
 * `Theme`/`ThemeName` exports below (those come from the `as const` on the
 * outer `themes` object, independent of this).
 */
type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };

const lightColor: Widen<typeof darkColor> = {
  bg: {
    canvas: palette.graphite[25],
    surface: palette.common.white,
    raised: palette.common.white,
    inset: palette.graphite[50],
    overlay: 'rgba(11,15,22,0.48)',
  },
  border: {
    subtle: palette.graphite[100],
    default: palette.graphite[200],
    strong: palette.graphite[300],
  },
  text: {
    primary: palette.graphite[900],
    secondary: palette.graphite[600],
    tertiary: palette.graphite[500],
    disabled: palette.graphite[400],
    onAccent: palette.graphite[950],
    onDanger: palette.common.white,
  },
  accent: {
    // Use the 600 steps on light for adequate contrast of fills/text.
    primary: palette.ember[600],
    primaryPressed: palette.ember[700],
    primaryTint: palette.ember.tint,
    data: palette.cyan[600],
    dataTint: palette.cyan.tint,
    ai: palette.plasma[600],
    aiTint: palette.plasma.tint,
    growth: palette.growth[600],
    growthTint: palette.growth.tint,
  },
  feedback: {
    success: palette.growth[600],
    successTint: palette.growth.tint,
    danger: palette.danger[600],
    dangerSolid: palette.danger[600],
    dangerTint: palette.danger.tint,
    warning: palette.gold[600],
    warningTint: palette.gold.tint,
    info: palette.cyan[600],
    infoTint: palette.cyan.tint,
  },
  map: {
    route: palette.ember[600],
    routeCasing: 'rgba(255,255,255,0.70)', // light casing over light daytime tiles
    startMarker: palette.growth[600],
    finishMarker: palette.ember[600],
  },
  focusRing: palette.cyan[600],
};

// ---------------------------------------------------------------------------
// 3. TYPOGRAPHY
//    Three families with distinct jobs:
//    - display  = Archivo (Expanded width axis): structural, stamped-metal,
//                 stadium-signage headlines. Used with restraint.
//    - body     = Inter: the legibility workhorse; scales well with Dynamic Type.
//    - metric   = JetBrains Mono: the FIRST-CLASS numeric/data face. Tabular
//                 figures + slashed zero for reps/weight/pace/time/units.
//    fontFamily strings match @expo-google-fonts/* exports exactly.
// ---------------------------------------------------------------------------

export const fontFamily = {
  displaySemibold: 'Archivo_600SemiBold',
  displayBold: 'Archivo_700Bold',
  bodyRegular: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemibold: 'Inter_600SemiBold',
  metricMedium: 'JetBrainsMono_500Medium',
  metricBold: 'JetBrainsMono_700Bold',
} as const;

/**
 * Archivo on RN needs the Expanded width applied via fontVariationSettings
 * (variable-font 'wdth' axis). Spread `displayVariation` onto display Text.
 * The numeric face uses tabular figures via fontVariant.
 */
export const fontVariation = {
  display: { fontVariationSettings: "'wdth' 125" as const },
  metric: { fontVariant: ['tabular-nums'] as ('tabular-nums')[] },
} as const;

export const type = {
  // Display — Archivo Expanded. Reserve for hero/brand moments.
  displayXl: { fontFamily: fontFamily.displayBold, fontSize: 40, lineHeight: 44, letterSpacing: -0.5 },
  displayLg: { fontFamily: fontFamily.displayBold, fontSize: 32, lineHeight: 38, letterSpacing: -0.25 },
  displayMd: { fontFamily: fontFamily.displaySemibold, fontSize: 26, lineHeight: 32, letterSpacing: -0.25 },
  title: { fontFamily: fontFamily.displaySemibold, fontSize: 20, lineHeight: 26, letterSpacing: 0 },

  // Body — Inter.
  heading: { fontFamily: fontFamily.bodySemibold, fontSize: 17, lineHeight: 22, letterSpacing: 0 },
  bodyLg: { fontFamily: fontFamily.bodyRegular, fontSize: 16, lineHeight: 24, letterSpacing: 0 },
  body: { fontFamily: fontFamily.bodyRegular, fontSize: 15, lineHeight: 22, letterSpacing: 0 },
  bodyStrong: { fontFamily: fontFamily.bodySemibold, fontSize: 15, lineHeight: 22, letterSpacing: 0 },
  label: { fontFamily: fontFamily.bodyMedium, fontSize: 13, lineHeight: 18, letterSpacing: 0.2 },
  caption: { fontFamily: fontFamily.bodyRegular, fontSize: 12, lineHeight: 16, letterSpacing: 0.1 },
  overline: { fontFamily: fontFamily.bodySemibold, fontSize: 11, lineHeight: 14, letterSpacing: 1.2 }, // uppercase in use

  // Metric — JetBrains Mono (apply fontVariation.metric). The content of a
  // fitness app is numbers; these are a design decision, not a fallback.
  metricXl: { fontFamily: fontFamily.metricBold, fontSize: 44, lineHeight: 46, letterSpacing: -0.5 },
  metricLg: { fontFamily: fontFamily.metricBold, fontSize: 28, lineHeight: 32, letterSpacing: -0.25 },
  metricMd: { fontFamily: fontFamily.metricMedium, fontSize: 20, lineHeight: 24, letterSpacing: 0 },
  metricSm: { fontFamily: fontFamily.metricMedium, fontSize: 15, lineHeight: 20, letterSpacing: 0 },
} as const;

// ---------------------------------------------------------------------------
// 4. SPACING — 8pt base with 4pt half-steps. Reference by name, not number.
// ---------------------------------------------------------------------------

export const space = {
  none: 0,
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16, // default gutter / screen edge padding
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
  huge: 48,
  giant: 64,
  colossal: 80,
} as const;

export const screen = {
  edge: space.md, // 16pt horizontal safe gutter
  edgeWide: space.lg, // 20pt for roomier content columns
  sectionGap: space.xxl, // 24pt between stacked sections
} as const;

// ---------------------------------------------------------------------------
// 5. SHAPE — radii, borders. Corners are consistent per component ROLE, not
//    applied uniformly (a chip, a card, and a button are intentionally
//    different — avoids the "everything is the same rounded box" tell).
// ---------------------------------------------------------------------------

export const radius = {
  none: 0,
  sm: 6, // chips, inputs
  md: 10, // buttons, small cards
  lg: 14, // content cards, sheets
  xl: 20, // hero panels, bottom sheets
  pill: 999, // toggles, segmented controls
} as const;

export const border = {
  hairline: 1,
  thick: 2, // focus ring / selected state
} as const;

// ---------------------------------------------------------------------------
// 6. ELEVATION — on dark, depth is primarily carried by surface LIGHTNESS
//    (bg.surface -> bg.raised), with shadow used minimally. Shadow tokens are
//    defined mainly for the light theme and for floating elements (sheets).
// ---------------------------------------------------------------------------

export const elevation = {
  none: {
    shadowColor: palette.common.black,
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  sm: {
    shadowColor: palette.common.black,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  md: {
    shadowColor: palette.common.black,
    shadowOpacity: 0.24,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  lg: {
    shadowColor: palette.common.black,
    shadowOpacity: 0.32,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
} as const;

// ---------------------------------------------------------------------------
// 7. MOTION — honor prefers-reduced-motion. Any value marked "signature" is
//    the Meridian animation; under reduced motion it renders complete/static
//    (crossfade, no draw). See tokens.md motion section.
// ---------------------------------------------------------------------------

export const duration = {
  instant: 0,
  fast: 120, // press feedback
  base: 200, // most transitions
  slow: 320, // sheet / screen transitions
  deliberate: 480, // signature Meridian draw
} as const;

export const easing = {
  // cubic-bezier control points; feed to Easing.bezier(...) in Reanimated/RN.
  standard: [0.2, 0, 0, 1] as const,
  decelerate: [0, 0, 0.2, 1] as const,
  accelerate: [0.4, 0, 1, 1] as const,
} as const;

export const spring = {
  // Reanimated withSpring config for the origin "settle" on the Meridian.
  settle: { damping: 18, stiffness: 180, mass: 1 } as const,
} as const;

// ---------------------------------------------------------------------------
// 8. INTERACTION — touch targets, opacity states, layering.
// ---------------------------------------------------------------------------

export const touchTarget = {
  min: 44, // pt — enforced floor; sweaty/gloved/one-handed use (mobile-arch)
  comfortable: 52, // primary CTAs
} as const;

export const opacity = {
  disabled: 0.4,
  pressed: 0.85,
  scrim: 0.72,
  ghost: 0.6,
} as const;

export const zIndex = {
  base: 0,
  sticky: 10,
  overlay: 100,
  modal: 200,
  toast: 300,
} as const;

// ---------------------------------------------------------------------------
// 9. THEME ASSEMBLY
// ---------------------------------------------------------------------------

const shared = {
  fontFamily,
  fontVariation,
  type,
  space,
  screen,
  radius,
  border,
  elevation,
  duration,
  easing,
  spring,
  touchTarget,
  opacity,
  zIndex,
} as const;

export const themes = {
  dark: { name: 'dark' as const, color: darkColor, ...shared },
  light: { name: 'light' as const, color: lightColor, ...shared },
} as const;

export type Theme = typeof themes.dark;
export type ThemeName = keyof typeof themes;

/** Default theme. Dark is the primary brand surface for Phase 0. */
export const defaultTheme = themes.dark;
