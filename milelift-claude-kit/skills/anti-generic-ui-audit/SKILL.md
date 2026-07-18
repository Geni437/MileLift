---
name: anti-generic-ui-audit
description: Detection checklist for identifying generic, templated, or unreviewed visual design in an implemented UI. Use when reviewing implemented screens against the design system, before a UI/UX-affecting change ships, or whenever asked to check if the app "looks vibe coded" visually.
when_to_use: Invoke during design review of implemented screens, before release, or when auditing existing UI for visual consistency and distinctiveness.
---

# Anti-Generic UI Audit

Same principle as code review: "looks generic" isn't a vibe, it's a
checkable list of specific tells. Reference the actual token system
(`docs/design/` or equivalent) while reviewing — most of these checks are
"does this match what was decided, or did someone fall back to a default
when they weren't sure."

## Token-system consistency

- Colors used that aren't in the defined palette — a one-off hex value
  reached for because the "right" one wasn't obvious in the moment.
- Spacing values that don't follow the established scale — arbitrary
  padding/margins scattered through a screen instead of the defined
  increments.
- Component-library default colors/shadows/radii left untouched where the
  design system specifies otherwise (a button still using the framework's
  default blue, a card still using the default drop-shadow).
- The numeric/data typeface not applied where numbers are the actual content
  (a rep counter or weight value rendered in the body font instead of the
  designated data face).

## Structural genericness

- Every content type wrapped in the same generic card component regardless
  of what it represents — a workout summary, a settings row, and a chart
  all visually identical apart from their text.
- A dashboard that's an undifferentiated grid of icon+number+label with no
  visual hierarchy — nothing signals what the user should look at first.
- The default circular-ring or generic-bar-chart treatment used without
  evidence it was a deliberate choice among alternatives (check the design
  spec — if it names this as the intentional signature element, it's fine;
  if it's just what's fastest to build with the charting library's default
  config, flag it).
- Onboarding that follows the generic goal-cards → permission-carousel →
  dots-indicator pattern with no element specific to this app.

## Copy & tone

- Generic motivational copy doing emotional work the design should be doing
  visually — "You're crushing it! 💪" style filler.
- Inconsistent tone across screens (warm/encouraging on one screen, terse
  system-generated-sounding on another) — a signal no one made the voice
  decision explicit and different screens were written independently.
- Empty and error states using generic system-default text or a bare "No
  data" instead of the interface's own voice.
- A button/action's label not matching its confirmation ("Log set" that
  results in a generic "Success" toast instead of "Set logged").

## Motion

- Animation applied uniformly and decoratively (everything fades/scales on
  mount) rather than reserved for moments that earn it (completing a set,
  hitting a PR, finishing a workout).
- No motion reduction respected for users with `prefers-reduced-motion` or
  the platform equivalent.
- A celebratory moment (streak milestone, PR) with no distinct treatment at
  all — motion restraint is good, but a genuinely significant moment with
  zero acknowledgment reads as unfinished, not disciplined.

## Accessibility as visual craft

(Functional accessibility is covered in `mobile-architecture-standards`;
these are the craft-level checks specific to whether the visual design
itself holds up.)

- Insufficient contrast between text and background, or between an
  "active/completed" state and its neutral counterpart, especially where
  color alone (not an icon or weight change) is the only signal.
- Touch targets that look designed for a mockup on a large monitor rather
  than a thumb mid-workout — check actual rendered size, not just the
  spec value.

## How to report

For each finding: which screen, which specific element, what the design
system says should happen there (or, if there's no design system entry for
it, flag that gap too), and what it actually looks like. Group as
**Off-system** (contradicts an explicit design decision — straightforward
fix), **Undecided default** (no explicit decision was made, so a library or
platform default was used by omission — needs a design call, not just a
code fix), and **Genuinely generic** (matches a known category cliché with
no evidence of deliberate choice).

Don't flag a known category pattern (a ring, a flame icon, a card grid) as
an issue if the design spec explicitly chose it on purpose — the audit is
against *unreviewed default*, not against any specific visual motif being
inherently wrong.
