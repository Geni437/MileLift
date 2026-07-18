MileLift — Unified Fitness Platform Spec

| **MileLift** *Unified Fitness Platform — Product Feature Specification* |
| --- |

| **Strava** Energy / Activity | **MFP + Jefit** Trust / Data | **Fitbod** AI / Intensity | **Caliber** Coaching / Growth | **Platform** Foundation |
| --- | --- | --- | --- | --- |

*Consolidating Strava, MyFitnessPal, Jefit, Fitbod **&** Caliber into one platform*

Prepared July 2026

# **Table of Contents**

| **Naming** | **3** |
| --- | --- |
| **Purpose** | **4** |
| **Introduction** | **4** |
| **Overview** | **5** |
| **Design Rationale: The Color System** | **5** |
| **1. Foundational Modules (Common Features, Consolidated)** | **6** |
| **2. Unique Features Pulled From Each Source App** | **8** |
| **3. AI-Native Feature Layer (The Additions)** | **9** |
| **4. Proposed Module Architecture** | **11** |
| **5. Build Roadmap** | **12** |
| **6. What Makes This Different** | **13** |
| **Next Steps** | **13** |

# **Naming**

MileLift is the name selected for this platform — “Mile” for the endurance side, “Lift” for the strength side, together naming the hybrid athlete the whole platform is built around. Alternates considered during naming are included below for reference. MileLift still needs a formal trademark and domain-availability check before anything is finalized.

| **Name** | **Status** | **Rationale** |
| --- | --- | --- |
| MileLift | Selected | “Mile” carries the running/cycling/endurance side, “Lift” carries the strength side — both halves of the hybrid athlete this platform is built for, in one word. Verified clean: no competing fitness or health app found under this name. |
| UFit | Considered | Short and personal — the “U” signals personalization. Ultimately dropped: already in wide use by multiple existing fitness and AI-coaching apps. |
| Hybrio | Considered | Directly from “hybrid athlete” — the person who both lifts and does cardio. Verified clean, but less immediately descriptive than MileLift. |
| Steady Pulse | Considered | Caring (steady) + punchy vitality (pulse). Verified clean, but two words made it a less natural app-icon/handle name. |
| Cadenzo | Considered | From “cadence,” the pace/rhythm term runners and cyclists both use. Verified clean, but no strength-training connotation on its own. |
| FitOS | Considered | Reflected the four-module + AI-layer architecture — “one operating system for fitness.” Reads more technical/platform-y than consumer-friendly. |

# **Purpose**

This document defines MileLift — a single fitness platform intended to replace the fragmented stack of five separate apps that a fitness-serious person currently has to piece together to cover activity tracking, nutrition, strength training, AI coaching, and human accountability.

The purpose is threefold:

- Consolidate — bring the genuinely valuable features from Strava, MyFitnessPal, Jefit, Fitbod, and Caliber into one coherent data model and one subscription, instead of five disconnected histories that don't talk to each other.

- Correct — fix the specific, well-documented failure patterns — GPS/tracking reliability, paywall trust erosion, logging friction, and coaching that doesn't scale — that show up repeatedly across each source app's own user reviews.

- Extend — use AI to do what a coach, a nutritionist, and a data analyst would do for a client with unlimited time and attention, at a price and speed none of the five source apps currently offer.

This spec is the reference document for that build: what's included, why, and in what order.

# **Introduction**

Right now, someone serious about their fitness is running several apps in parallel, each covering one slice of the picture:

- Strava — GPS-tracked cardio, routes, and the social/competitive layer runners and cyclists rely on.

- MyFitnessPal — food logging and macro tracking.

- Jefit — detailed strength-training logs and a large exercise library.

- Fitbod — AI-generated daily workouts based on equipment and recovery.

- Caliber — real human coaching and accountability.

Each does its one job reasonably well, and each has a specific, well-documented weakness in exactly the part it doesn't own — GPS drift and dropped routes, features quietly moved behind a paywall, manual logging that takes too long to stick with, or a coaching relationship that doesn't hold up under its own promise of accountability.

None of them talk to each other. A run logged in Strava doesn't adjust the day's calorie target in MyFitnessPal. A hard leg day in Jefit doesn't factor into tomorrow's Fitbod-style recommendation. And nobody currently offers the thing users are most often missing: a coach who notices when you go quiet.

MileLift is built to close that gap — not by adding a sixth app, but by replacing the five with one: one login, one activity history, one AI layer that reads across nutrition, training, and recovery to do what a great coach would do, at the speed an app should.

# **Overview**

MileLift is a single fitness platform combining four functional modules — Activity & Movement Tracking, Nutrition & Food Logging, Strength Training & Workout Logging, and Community — under one account, with an AI layer sitting above all four that acts as the coach, nutritionist, and accountability partner none of the five source apps individually provide.

What it does, in practice:

- Tracks activity — GPS-recorded runs, rides, walks, and 40+ other activity types, synced with wearables.

- Logs nutrition — fast, largely automated food logging via photo or text, with a macro/calorie picture that updates in real time against synced training load.

- Plans and logs strength training — an AI-generated daily workout adjusted for available equipment and recovery, with a full logging and progress-analytics layer underneath for people who'd rather self-program.

- Coaches — a proactive AI layer that checks in when logging drops off, answers plain-language questions about your own data, and runs a first-pass form check from your phone camera, escalating to a real human coach (optional premium tier) when it matters.

- Connects — one social/community layer merging the competitive segment mechanics people like from Strava with the shared-routine and group-training patterns from Jefit and Caliber.

Who it's for: the same person who currently owns Strava, MyFitnessPal, and one of Jefit, Fitbod, or Caliber simultaneously — someone training seriously enough to want real data, not casually enough to be satisfied with a single generic app. The free tier is built to be genuinely usable on its own, which is deliberately not how the source apps' free tiers behave; the subscription pays for the AI layer and, optionally, human coaching on top of it.

At a glance:

- 4 core modules + 1 AI layer sitting above them

- 20 consolidated baseline features pulled from what all five source apps already do well

- 17 additional standout features pulled from what each app does uniquely well

- 20 new AI-native features built specifically to close the gaps identified in the competitive review

The remainder of this document lays out exactly what those features are, where each one came from, and the order they should be built in.

# **Design Rationale: The Color System**

The palette is derived directly from the five source apps rather than invented from scratch, so the visual identity carries the same logic as the feature consolidation:

- Navy (platform) — the neutral foundation everything else sits on; most of these apps default to a dark, serious base layer.

- Orange — pulled from Strava's signature color; used for activity, energy, and primary calls to action.

- Blue — shared by both MyFitnessPal and Jefit, which independently converged on blue for trust and data — reinforcing it as the platform's “tracking and accuracy” color.

- Red — drawn from Fitbod's bold, energetic identity; reserved for AI-driven and intensity-related features.

- Green/lime — drawn from Caliber's coaching-and-growth brand feel; used for human coaching, habit-formation, and progress milestones.

*Note on accuracy: hex values below are close approximations of each brand**'**s public visual identity, not verified official brand-guideline codes for all five apps — treat this as a derived, presentation-ready palette rather than a legal reproduction of third-party trademarks.*

# **1. Foundational Modules (Common Features, Consolidated)**

Features that appeared — in some form — across multiple source apps. Building these once, well, is the baseline the rest of the platform stands on.

## **Module A: Activity ****&**** Movement Tracking**

*Source: Strava*

| **ID** | **Feature** | **Notes** |
| --- | --- | --- |
| CORE-01 | GPS activity recording (run/ride/walk/hike + 40+ types) | Core recording engine |
| CORE-02 | Route mapping & activity history | Persistent per-activity map + stats |
| CORE-03 | Wearable/device sync (Garmin, Apple Watch, Wear OS) | Two-way sync, not just import |
| CORE-04 | Personal records & achievement tracking | Auto-detected PRs per activity type |
| CORE-05 | Activity feed & kudos/social reactions | Baseline social loop |

## **Module B: Nutrition ****&**** Food Logging**

*Source: MyFitnessPal*

| **ID** | **Feature** | **Notes** |
| --- | --- | --- |
| CORE-06 | Food logging with large searchable database | Most expensive asset to replicate — build vs. license decision |
| CORE-07 | Barcode scanning | Stays in the free tier — paywalling this was MyFitnessPal's top complaint |
| CORE-08 | Macro tracking (protein/carb/fat) |  |
| CORE-09 | Water intake tracking |  |
| CORE-10 | Recipe & meal saving for fast re-logging |  |
| CORE-11 | Manual exercise/calorie-burn logging | Auto-reconciles with Module A instead of double-counting |

## **Module C: Strength Training ****&**** Workout Logging**

*Source: Jefit + Fitbod + Caliber*

| **ID** | **Feature** | **Notes** |
| --- | --- | --- |
| CORE-12 | Set/rep/weight logging with rest timer | Core lifting log |
| CORE-13 | Exercise library with video demos | Target 1,400+ movements to match Jefit's benchmark |
| CORE-14 | Custom workout & program builder | Manual path for self-directed users |
| CORE-15 | Progress analytics (volume, 1RM, PRs) |  |
| CORE-16 | Progress photos & body measurements |  |
| CORE-17 | Offline logging with background sync | Non-negotiable — gym basements kill Wi-Fi |

## **Module D: Account, Community ****&**** Platform**

| **ID** | **Feature** | **Notes** |
| --- | --- | --- |
| CORE-18 | Single unified profile across all modules | The real differentiator vs. five separate apps |
| CORE-19 | Community feed, challenges, friend following | Merges the social layers of all five source apps |
| CORE-20 | Transparent free tier + single subscription | Pricing trust was a recurring failure point everywhere |

# **2. Unique Features Pulled From Each Source App**

The differentiators — the reason each individual app has a loyal user base. Pulling the best of each into one product, without inheriting the specific weakness that comes with it, is the actual point of this exercise.

| **Source** | **ID** | **Feature** | **Why It****'****s Worth Taking** |
| --- | --- | --- | --- |
| Strava | UNQ-01 | Segments & competitive leaderboards | No other app here has geography-based competition |
| Strava | UNQ-02 | Live segment updates mid-activity | Real-time feedback, not just post-hoc |
| Strava | UNQ-03 | Group challenges (monthly goals, badges) | Proven habit-formation mechanic |
| Strava | UNQ-04 | Route discovery via popularity/heatmaps | Natural AI upgrade target (see AI-16) |
| Strava | UNQ-05 | Privacy zones (hide route start/end) | Simple but important safety feature |
| MyFitnessPal | UNQ-06 | Restaurant-item database entries | Removes the “eating out breaks tracking” failure |
| MyFitnessPal | UNQ-07 | Net-carb / keto mode | Cheap to build, serves a large diet-specific segment |
| MyFitnessPal | UNQ-08 | Intermittent fasting timer | Popular standalone habit-tracking feature |
| Jefit | UNQ-09 | Massive muscle-categorized exercise library | Depth advantage worth matching or exceeding |
| Jefit | UNQ-10 | Community-shared routines/programs | Lets users adopt proven programs instead of building from scratch |
| Fitbod | UNQ-11 | Daily algorithmic workout generation | Seed for the full AI Coach module |
| Fitbod | UNQ-12 | Muscle recovery heatmap | Intuitive visual for training balance |
| Fitbod | UNQ-13 | Multiple equipment profiles (home/gym/travel) | Small feature, high real-world utility |
| Caliber | UNQ-14 | Real human coach option, in-app messaging | Optional premium tier on top of the AI coach, not a replacement |
| Caliber | UNQ-15 | Video form review | Becomes the escalation path once CV form-check (AI-01) exists |
| Caliber | UNQ-16 | Weekly structured progress reviews | Good cadence to borrow regardless of who's reviewing |
| Caliber | UNQ-17 | Bundled nutrition + training + habit coaching | Validates fusing Module B and Module C rather than siloing them |

# **3. AI-Native Feature Layer (The Additions)**

Where the platform stops being “five apps glued together” and becomes something none of the five could be individually. Each feature is tagged with the specific gap it closes.

## **AI Coach ****&**** Personalization**

| **ID** | **Feature** | **Closes Gap From** | **Description** |
| --- | --- | --- | --- |
| AI-01 | Computer-vision form checking | Fitbod | Phone-camera pose estimation scored against reference movement patterns; escalates to human review (UNQ-15) at low confidence |
| AI-02 | Proactive accountability agent | Caliber | Detects declining logging frequency and sends a specific, reasoned check-in instead of a generic push |
| AI-03 | Fast cold-start personalization | Fitbod | Richer intake (movement-screen video, 1RM estimate, wearable import) shrinks time-to-value |
| AI-04 | Conversational re-planning | Jefit + Caliber | LLM with function-calling into the workout engine re-plans instantly from plain language |
| AI-05 | Validated periodization templates, AI-adapted | Fitbod + Caliber | AI adapts within an established scheme instead of one generic engine for everyone |
| AI-06 | Adaptive training load from recovery signals | Strava + Fitbod | Adjusts week-to-week using recovery/sleep data where available |
| AI-07 | Natural-language training/nutrition Q&A | Strava + MyFitnessPal | LLM answers questions using the user's actual structured data |
| AI-08 | Predictive logging UX | Jefit | Pre-fills the likely next set/exercise/meal based on history and time of day |

## **Nutrition-Specific AI**

| **ID** | **Feature** | **Closes Gap From** | **Description** |
| --- | --- | --- | --- |
| AI-09 | AI meal parsing from photo or text | MyFitnessPal | Photo or one typed sentence to full nutrition breakdown in seconds |
| AI-10 | Auto portion estimation | MyFitnessPal | CV portion sizing with a one-tap manual override |
| AI-11 | Editable, self-correcting logs | MyFitnessPal | Every AI-populated entry stays editable; low-confidence entries prompt confirmation |
| AI-12 | Auto macro-goal adjustment from synced activity | MyFitnessPal + Strava | Daily targets adjust automatically after a logged workout |

## **Reliability ****&**** Trust (Cross-Cutting)**

| **ID** | **Feature** | **Closes Gap From** | **Description** |
| --- | --- | --- | --- |
| AI-13 | Multi-sensor fusion GPS tracking | Strava | On-device dead-reckoning during GPS dropout — the single highest-leverage reliability fix in this spec |
| AI-14 | Post-hoc route reconstruction | Strava | Map-matching repairs gaps instead of showing a broken line |
| AI-15 | Automated pre-release regression detection | Strava + Jefit | Telemetry comparison across app versions before a release ships wide |
| AI-16 | Smart route/segment recommendation | Strava | Collaborative filtering + real-time context instead of a static lookup |
| AI-17 | Segment/leaderboard integrity detection | Strava | Anomaly detection protects the competitive layer's credibility |
| AI-18 | Agentic subscription/billing support | Fitbod + Caliber + MFP | Real write access to subscription state, not canned replies |
| AI-19 | Wearable data fusion & dedup | Caliber + Strava | Reconciles overlapping device data into one clean activity record |
| AI-20 | AI-assisted review/feedback triage | Strava + Jefit | NLP clustering of reviews/tickets ranked by frequency × severity |

# **4. Proposed Module Architecture**

Four functional modules, one shared identity/data layer, one AI layer that reads from all of them:

| Unified Profile & Auth           (single account, single history)         /          │           │          \   Activity     Nutrition    Strength    Community   Module A     Module B     Module C     Module D         \          │           │          /                     AI Layer      (coach, vision, NL re-planning,          reliability, trust) |
| --- |

Why this shape, briefly:

- Each module owns its own data model, but all write into one canonical user timeline — this is what makes AI-06, AI-07, and AI-12 possible at all, since they need cross-module reads.

- The AI layer sits above the modules, not embedded inside each one — avoids duplicating the same LLM/function-calling plumbing four times and keeps model swaps a single change.

- Reliability features (AI-13, AI-14, AI-15) live on-device where possible — latency and offline function matter for a recording app, and it avoids streaming raw sensor data to a server continuously.

- Trust features (AI-18) need write access to billing systems specifically — this needs real access-control design, not just a good prompt; it's the one place where “convenient” and “safe” are in direct tension.

# **5. Build Roadmap**

MVP first proves the core thesis — one data model beats five separate apps — before any “smart” layer exists. This ordering matters: across every source app, the worst reviews were about broken basics, not missing intelligence.

| **Phase** | **Scope** |
| --- | --- |
| MVP | CORE-01 through CORE-20  •  UNQ-11 (human-reviewed only, no CV yet)  •  AI-09, AI-11, AI-13, AI-18 |
| Phase 2 | AI-01, AI-02, AI-03, AI-04, AI-06, AI-10, AI-12  •  UNQ-01 through UNQ-05 |
| Phase 3 | AI-05, AI-07, AI-08, AI-14 through AI-20  •  UNQ-14 / UNQ-16 (optional human-coach tier) |

# **6. What Makes This Different**

- Fast: logging speed is the single most-cited churn driver across the nutrition and strength apps — AI-08 and AI-09 attack that directly instead of adding more manual fields.

- Unique: nobody currently combines Strava's competitive/social layer, MyFitnessPal's database depth, and Caliber-grade coaching with AI doing the parts a human coach can't scale to do.

- User-friendly: one profile, one history, one subscription — removes the “why do I have three fitness apps that don't talk to each other” tax every source app currently imposes.

- Optimized: the reliability fixes (AI-13 through AI-15) aren't glamorous, but they're the actual #1 driver of 1-star reviews across the entire competitive set — shipping those first is the highest-ROI engineering decision in this spec.

# **Next Steps**

This document is the “what” and “why.” Good next slices to scope and build: the unified data schema across the four modules, the on-device sensor-fusion recording engine (AI-13), or the AI coach's function-calling architecture (AI-04 / AI-07).