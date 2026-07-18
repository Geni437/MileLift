---
name: billing-agentic-guardrails
description: Mandatory guardrails for AI-18 (agentic subscription/billing support with real write access) — the one feature the spec itself flags as having convenience and safety in direct tension. Use before designing or implementing any AI agent with write access to subscription, payment, or billing state.
when_to_use: Invoke before any implementation work on AI-18 begins, and required reading for security-auditor's review of it.
---

# Billing Agentic Guardrails

The spec names this tension explicitly: giving an AI agent real write access
to subscription/billing state is where "convenient" and "safe" stop being
compatible defaults. This skill exists so that tension gets resolved by
deliberate design, not by whichever behavior falls out of a general-purpose
agent given billing tools and a helpful system prompt.

## The action set is enumerated, not open-ended

The agent does not get a general "manage the user's billing" capability. It
gets a specific, finite list of functions, each independently reviewed:

- Look up subscription status / current plan / renewal date (read-only,
  low risk).
- Apply a discount code that already exists in the billing system's own
  rules (bounded by the billing system's own validation, not the agent's
  judgment about whether the user "deserves" one).
- Initiate a refund **only** within a pre-defined policy (e.g., within N
  days of purchase, below a defined amount, limited frequency per account)
  — anything outside that policy routes to a human, full stop.
- Cancel a subscription at the user's explicit, unambiguous request.

Anything not on this list is not something the agent can talk itself into
doing, regardless of how the conversation goes. The enumerated list *is*
the security boundary — the system prompt is not the security boundary, and
should never be treated as sufficient on its own to prevent an out-of-scope
action, per `ai-orchestration-standards`.

## Every state-changing action needs a check beyond the LLM's judgment

For each action above the read-only tier, require one of:

- A deterministic rule the code enforces regardless of what the LLM
  concluded (a refund request outside the policy window is rejected by the
  function itself, not by the model choosing not to call it), or
- Explicit user confirmation captured through the actual UI (not inferred
  from chat text) before the action executes, mirroring the same
  confirm-before-acting standard used for any other consequential,
  irreversible action in this app.

## Audit everything

Every action this agent takes — including ones it considered and didn't
take, if that's loggable — is recorded with who (user), what (action and
parameters), when, and the reasoning/conversation context that led to it.
This log is immutable from the agent's own access level. A billing agent
with write access and no audit trail is not an acceptable shipping
configuration regardless of how well-tested the happy path is.

## Rate and amount limits

Bound the blast radius of a bug or an adversarial user regardless of how
good the guardrails above are: a per-account and a system-wide cap on
agent-initiated refund volume/frequency, alerting if either is approached.
Treat this the same way you'd treat a circuit breaker on any other
high-consequence automated system — not a sign of distrust in the design,
a standard safety margin for a system doing financial write actions.

## Test adversarially, not just on the happy path

Before this ships, test it against a user actively trying to talk the agent
into an out-of-scope action — "my situation is special," "just this once,"
"my friend at another company got one," escalating persistence, claimed
authority ("I spoke to your manager already"). The correct behavior in
every case is the same: the enumerated action set doesn't expand because
the conversation was persuasive. If a red-team pass finds a phrasing that
gets the agent to act outside its enumerated scope, that's a blocking
finding, not a minor one.

## Sign-off requirement

`security-auditor` produces a written threat model for this feature
specifically — the enumerated action list, the check applied to each, the
audit mechanism, and the rate limits — **before** implementation starts,
not as a post-hoc review of what got built. This is the one feature area in
the spec where design-before-code is a hard requirement, not a general best
practice.
