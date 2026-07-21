import type { ConsentCategory } from '../../db/types';
import { theme } from '../../theme';

export type ConsentContent = {
  title: string;
  purpose: string;
  wontDo: string;
  allowLabel: string;
  declineLabel: string;
  footnote: string;
  accentColor: string;
};

/**
 * Copy verbatim from docs/design/screens-phase-0.md §E1/E2/E3. This module
 * owns classification only — the words are the design spec's, not a
 * mobile-builder paraphrase, so a copy change is a design-doc change that
 * gets re-synced here, not silent drift.
 */
export const CONSENT_CONTENT: Record<ConsentCategory, ConsentContent> = {
  health: {
    title: 'Connect your health data?',
    purpose:
      'MileLift can read your workouts, heart rate, and sleep from Apple Health / Health Connect so training load and recovery reflect what your body actually did — not just what you typed in.',
    wontDo:
      'It never shares your health data for ads or sells it — Apple and Google forbid it, and so do we. You choose per type what’s shared with people you train with; nothing is shared by default.',
    allowLabel: 'Connect health data',
    declineLabel: 'Not now',
    footnote:
      'Turn this off anytime in Settings › Permissions & data. What you’ve already recorded stays; we just stop reading new data.',
    accentColor: theme.color.accent.data,
  },
  location: {
    title: 'Use location while recording?',
    purpose: 'Location maps your route while an activity is recording, so you get distance, pace, and the map afterward.',
    wontDo:
      'MileLift only uses location during an active recording — never in the background between activities, and never to build a profile of where you go. You can hide the start and end of any route.',
    allowLabel: 'Allow while recording',
    declineLabel: 'Not now',
    footnote: 'You can record without a map — we’ll still count time and any data from a connected watch.',
    accentColor: theme.color.accent.primary,
  },
  camera: {
    title: 'Use your camera for progress photos?',
    purpose: 'The camera lets you take progress photos to track how your body changes over time.',
    wontDo:
      'Progress photos are private to your account and stored encrypted — they’re never shown in any feed and never shareable. Only you can see them.',
    allowLabel: 'Allow camera',
    declineLabel: 'Not now',
    footnote: 'You can also add a photo from your library instead. Change camera access anytime in Settings.',
    accentColor: theme.color.accent.growth,
  },
  // Phase 2 (CORE-16) — copy verbatim from docs/design/screens-phase-2.md
  // §CORE-16 "The body_image consent priming sheet," approved as designed
  // (§Decisions item 4). Deliberately styled WITHOUT a bright brand accent —
  // its icon sits in text.primary on bg.inset with a lock glyph, because
  // this is a protection, not a feature to sell. `accentColor` here is
  // `text.primary` (not one of the three feature-accent colors above) so
  // ConsentSheet's "what MileLift won't do" label renders neutral, per that
  // design decision — the sheet itself still adds the lock glyph treatment.
  body_image: {
    title: 'Save progress photos?',
    purpose:
      'Progress photos let you see how your body changes over time — front, side, and back, compared across dates. They live only in your account.',
    wontDo:
      'Progress photos are the most private thing in MileLift. They’re stored encrypted, only you can open them, they’re never in any feed and can never be shared or made public — that’s built into the app, not a setting you have to find. We never use them to train anything or send them to anyone.',
    allowLabel: 'Save progress photos',
    declineLabel: 'Not now',
    footnote:
      'This is separate from health data — you can keep photos off while everything else stays on, or turn photos off later on their own, in Settings › Permissions & data. Turning it off stops new photos; what you’ve saved stays until you delete it.',
    accentColor: theme.color.text.primary,
  },
};
