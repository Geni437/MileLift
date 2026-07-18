---
name: ui-ux-design-standards
description: Design system and visual-identity standards for producing a distinctive, non-templated mobile UI — token system, typography, motion, screen-specific guidance, and microcopy voice. Use when designing new screens, establishing or extending the design system, or before any UI implementation work begins.
when_to_use: Invoke before mobile-builder implements a new screen or feature, and whenever the design system itself needs to be defined or extended.
---

# UI/UX Design Standards

Approach every screen the way a studio with a distinctive, recognizable
style would — not the way any competent contractor would default to. A
fitness app is a crowded category with a small set of extremely familiar
visual clichés; the standards below exist to name those clichés so you stop
reaching for them by default, and to give you a concrete process for
building something that's actually this app's own.

## What "generic" looks like in this category specifically

Name these to yourself before designing, so you notice when you're about to
reproduce one:

- A dashboard that's a grid of icon + big number + small label cards, no
  hierarchy, identical treatment regardless of what the number means.
- A circular progress ring as *the* visualization for everything, copied
  wholesale from Apple's Activity rings rather than considered as one option
  among several.
- A flame/fire icon for streaks, because Duolingo and Snapchat used one —
  fine if it's a deliberate choice for this brand's voice, a problem if it's
  the only idea considered.
- Hero imagery of generic stock athletes mid-jump with a gradient overlay.
- Untouched component-library defaults: Material's default indigo/teal,
  iOS system blue used everywhere with no palette decision made on top of it.
- "Good morning, {name}! 💪 Ready to crush today's workout?" — generic
  motivational copy with an emoji doing the emotional work the words didn't.
- Uniform rounded-corner-and-shadow cards for every content type, so a
  workout summary, a settings row, and a progress chart all look like the
  same box with different text inside.
- Also relevant from general AI-generated web/app design right now, worth
  recognizing even off the web: a warm cream background with high-contrast
  serif and a terracotta accent; a near-black background with one neon
  accent; dense hairline-rule "broadsheet" layouts. These are defaults, not
  choices — legitimate only if a specific reason for *this* brand leads
  there on purpose.

None of these are permanently forbidden — a flame icon for streaks might be
the right call if it's chosen deliberately after considering alternatives.
The failure mode is reaching for the default without noticing it was a
default.

## Process: plan, critique, build, critique again

1. **Ground it in the subject.** This app's actual differentiator (strength
   training focus? running? holistic wellness? a specific training
   philosophy?) should visibly shape the design — pull from that world's own
   vernacular (a strength app's visual language is not a meditation app's),
   not a generic "fitness" mood board. If this hasn't been decided, ask
   rather than guessing — it's the single input that most determines whether
   the result feels specific or generic.
2. **Build a compact token system** before touching any screen:
   - **Color**: 4–6 named hex values with a stated role for each (not just
     "primary/secondary" — what does each color *mean* in this app: a
     completed set, a personal record, a rest day, an alert).
   - **Type**: a display face used with restraint, a body face, and — this
     matters more here than in most apps — a distinct **numeric/data face**
     for reps, weight, time, and distance. Numbers are the actual content of
     a fitness app; treat tabular figures and a considered numeral style as
     a first-class design decision, not a font-family afterthought.
   - **Layout concept**: one-sentence descriptions (plus rough wireframes)
     for the core screens listed below.
   - **Signature element**: the one thing this app will be visually
     remembered by — a specific, ownable way of showing a completed set, a
     distinctive PR (personal record) moment, a progress visualization that
     isn't the default ring. Spend your boldness here; keep the rest quiet
     and disciplined around it.
3. **Critique the plan before building.** For each token/layout choice, ask:
   would I have produced this same answer for a generic "fitness app" brief
   with no other information? If yes, revise it and note what changed and
   why. Only proceed to implementation once the plan clears this check.
4. **Build to a quality floor that doesn't announce itself**: responsive
   across device sizes, visible focus states, `prefers-reduced-motion`
   respected, contrast ratios met (see the accessibility notes in
   `mobile-architecture-standards` — this skill owns the craft/distinctiveness
   layer, that one owns the functional-accessibility layer; both apply).
5. **Critique again after building.** Screenshot or otherwise review the
   actual result, not just the plan — a plan that read as distinctive on
   paper can still collapse into the generic default once real content and
   real spacing are in place.

## Screen-specific guidance

- **Onboarding**: this is the single highest-generic-risk surface — nearly
  every fitness app onboarding looks the same (goal-selection cards, a
  progress dots indicator, a permissions-request carousel). If there's room
  to differentiate anywhere, it's here, since it's the very first
  impression and the most-copied pattern in the category.
- **Dashboard/home**: resist the default icon-number-label grid. Ask what
  this specific user actually needs to see first *today* — that's a product
  question as much as a visual one, and the answer should shape the
  hierarchy, not just the color of the cards.
- **Active workout logging**: this screen is used mid-set, often
  one-handed, glanced at rather than read. Prioritize legibility and the
  numeric/data typeface here above decorative choices — this is the screen
  where restraint matters most.
- **Progress/history & data visualization**: a weight-over-time or
  volume-over-time chart is genuine design work, not a default chart
  library call — decide deliberately how to handle gaps (missed days),
  what the axis should emphasize, and whether a milestone (a PR) deserves a
  visual callout rather than just another data point.
- **Empty & error states**: treat these as an invitation to act, in the
  interface's own voice, not a generic "No data" or a default system alert.
  A first-use empty state ("log your first set to start your history") is
  a differentiation opportunity most apps waste on boilerplate.

## Microcopy voice

Write from the person's side of the screen: name things by what they
control, not by system internals. Use active voice — a button that says
"Log set" produces a confirmation that says "Set logged," not a mismatched
generic toast. Avoid stacking an emoji on top of copy that isn't doing its
own work — if the words need an emoji to land, rewrite the words. Decide
this app's specific tone (clinical and precise vs. warm and encouraging vs.
dry and no-nonsense) once, explicitly, and hold every screen to it — tone
that drifts screen to screen is as much a "looks unreviewed" signal as
inconsistent spacing.

## Handoff to implementation

Deliver the token system and screen specs as a written artifact
(`docs/design/` — token values, type scale, and per-screen notes) that
`mobile-builder` implements against, plus a quick static HTML mockup of the
core screens where useful: HTML/CSS is far faster to iterate on visually
than a mobile simulator, and it's a good framework-independent way to prove
out the design intent before committing platform-specific implementation
time to it.
