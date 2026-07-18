---
name: on-device-ml-standards
description: Standards for on-device machine learning — CV pose estimation (form checking) and multi-sensor GPS fusion. Covers the on-device-vs-cloud decision, battery/thermal budgeting, and the real-world validation these features need beyond unit tests. Use for AI-01 (form check), AI-13 (sensor fusion GPS), and AI-14 (route reconstruction).
when_to_use: Invoke when implementing or reviewing any on-device computer vision or sensor fusion feature.
---

# On-Device ML Standards

Two feature areas in this spec are genuinely different engineering from
everything else in the app: CV-based form checking (AI-01) and multi-sensor
GPS fusion (AI-13/14). Both run on-device, both have hard real-time and
battery constraints, and both fail in ways that only show up on real
hardware in real conditions — not in a simulator.

## Why on-device, specifically

The spec's own reasoning holds and should stay the design constraint, not
just the initial justification: latency (a form-check needs to give
feedback within the set, not after a round trip), offline function (GPS
recording during an activity has zero guarantee of connectivity), and not
continuously streaming raw sensor/camera data to a server, which is both a
cost problem and a data-minimization concern relevant to
`health-data-compliance` given how sensitive continuous location and video
data is.

## CV form checking (AI-01)

- Use a lightweight, mobile-optimized pose estimation model (not a
  server-grade model shrunk down) — inference needs to run at a usable
  frame rate on a mid-range phone, not just a flagship test device.
- Score against reference movement patterns with an explicit confidence
  output per rep/movement, following `ai-orchestration-standards`'
  confidence-escalation rule: low-confidence scoring routes to the human
  review path (UNQ-15), it does not silently present a possibly-wrong score
  as authoritative feedback on someone's lifting form, which has real
  injury-risk stakes if wrong.
- Test against real failure conditions deliberately, not just clean studio
  footage: gym mirrors and reflective surfaces confusing pose estimation,
  poor gym lighting, partial occlusion from equipment, a body type or range
  of motion outside whatever set trained the reference patterns. If the
  reference/training data has known demographic or body-type skew, say so
  explicitly rather than letting it surface later as a fairness bug.
- Camera access requests and any locally-stored video follow
  `health-data-compliance` and `mobile-architecture-standards` — minimum
  necessary retention, clear purpose at the permission prompt, and secure
  local storage if video is cached before upload for human review.

## Multi-sensor GPS fusion (AI-13) and route reconstruction (AI-14)

- Fuse GPS with accelerometer/gyroscope/magnetometer (dead reckoning)
  during GPS dropout, correcting drift once signal returns rather than
  presenting a route with a visible teleport or a broken gap — this is the
  spec's own "highest-leverage reliability fix," so treat gaps and
  discontinuities in the recorded route as the primary defect to eliminate,
  not a cosmetic nice-to-have.
- Define and document the fusion approach's actual failure mode: what the
  recorded route looks like when dead-reckoning drift accumulates beyond a
  reasonable bound during an extended dropout (a long tunnel, a dense urban
  canyon) — decide explicitly whether to show a lower-confidence route
  segment, interpolate, or flag the gap to the user, rather than letting
  whatever the algorithm happens to produce be the undocumented answer.
- **Validate in real GPS-denied environments, not just simulated/replayed
  GPS data.** A tunnel, an underground parking garage, or a dense urban
  canyon are the actual test cases this feature exists for — synthetic
  dropout simulation is a useful first pass, not a substitute for testing
  in the conditions that cause the 1-star reviews this feature is meant to
  fix.
- Route reconstruction (AI-14, map-matching to repair gaps post-hoc) is a
  distinct pass from real-time fusion (AI-13) — real-time fusion reduces
  how bad the raw recording is during the activity; post-hoc reconstruction
  cleans up what's left afterward. Don't treat them as the same feature
  shipped once.

## Battery and thermal budget

- Set an explicit power budget before implementation (e.g., a target
  battery-drain percentage per hour of active recording with GPS + sensor
  fusion running) and test against it on real devices, not just
  estimate it — continuous high-rate sensor fusion and camera-based CV
  inference are both genuinely battery- and thermal-intensive, and a
  feature that makes a phone hot and dead by mile 4 of a long run
  undermines the exact reliability story this feature exists to fix.
- Prefer adaptive sampling (reduce sensor/inference rate when movement is
  steady-state, increase during likely-dropout conditions) over a fixed
  maximum rate at all times.

## Model updates

Decide and document whether on-device models ship bundled with app
releases (simpler, but a model fix requires a full app update and store
review cycle) or are fetched/updated independently (faster iteration, but
adds a model-distribution and version-compatibility surface to manage).
Don't let this default silently to "whatever the first implementation
happened to do."

## Testing

Standard unit/integration tests (`test-strategy`) cover the deterministic
parts of this code (data structures, the confidence-threshold branching
logic, serialization). They do not substitute for device-level validation
of model accuracy and sensor fusion behavior under real conditions — budget
for both, and report them separately rather than letting a passing unit
test suite imply the on-device behavior has been verified.
