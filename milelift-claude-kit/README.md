# MileLift — Claude Code Build Kit

This is the full agent/skill/orchestration setup for building MileLift:
Supabase (Postgres + Auth + RLS + Storage + Edge Functions) on the backend,
VS Code + Claude Code as the development environment.

## Start here

1. Read `docs/spec/MileLift-Product-Spec.md` — the canonical product spec.
   Every agent and skill in this kit references it by feature ID
   (CORE-XX, UNQ-XX, AI-XX).
2. Read `MASTER-BUILD-PROMPT.md` — the actual phased build instruction.
   This is what you paste into a fresh Claude Code session to start
   building. It sequences all 57 features into 13 phases, each with an
   explicit validation gate that requires your approval before the next
   phase starts.
3. Install the kit (below), then start a Claude Code session in your
   project and paste in `MASTER-BUILD-PROMPT.md`.

## Install

```bash
mkdir -p .claude/agents .claude/skills docs/spec
cp milelift-claude-kit/agents/*.md .claude/agents/
cp -r milelift-claude-kit/skills/* .claude/skills/
cp milelift-claude-kit/docs/spec/MileLift-Product-Spec.md docs/spec/
cp milelift-claude-kit/MASTER-BUILD-PROMPT.md .
```

Commit `.claude/agents/`, `.claude/skills/`, `docs/spec/`, and
`MASTER-BUILD-PROMPT.md` to version control. Restart Claude Code (or start
a fresh session) so it picks up the new `.claude/agents/` directory.

## Agents (12)

| Agent | Role | Read-only? |
|---|---|---|
| `architect` | System design, canonical cross-module timeline, routes work to specialists | Mostly |
| `ui-ux-designer` | Design token system + screen specs, original identity (not competitor-derived) | Mostly |
| `db-engineer` | Schema, migrations, RLS policies | No |
| `backend-builder` | Edge Functions, PostgREST/RPC decisions, payment webhooks | No |
| `mobile-builder` | Mobile UI, offline sync, screen implementation | No |
| `mobile-ml-engineer` | On-device CV form-check (AI-01), sensor fusion GPS (AI-13/14) | No |
| `ai-systems-engineer` | LLM function-calling orchestration — AI Coach, recommendations, billing agent logic | No |
| `qa-engineer` | Automated tests, coverage, AI feature evaluation sets | No |
| `security-auditor` | OWASP + health-data + billing-agent threat modeling | **Yes** |
| `code-reviewer` | Anti-vibe-code gate | **Yes** |
| `design-reviewer` | Anti-generic-UI gate | **Yes** |
| `devops-engineer` | CI/CD, release readiness | No |

## Skills (16)

| Skill | Used by |
|---|---|
| `production-standards` | every builder agent |
| `anti-vibe-code-audit` | `code-reviewer` |
| `anti-generic-ui-audit` | `design-reviewer` |
| `security-review` | `security-auditor` |
| `health-data-compliance` | `architect`, `security-auditor`, `mobile-ml-engineer` |
| `billing-agentic-guardrails` | `security-auditor`, `ai-systems-engineer` — dedicated to AI-18 |
| `api-contract-standards` | `architect`, `backend-builder` — HTTP/Edge Function conventions |
| `supabase-standards` | `architect`, `db-engineer`, `backend-builder`, `ai-systems-engineer` — RLS, Auth, PostgREST/RPC/Edge Function decision framework |
| `test-strategy` | `qa-engineer` |
| `db-schema-standards` | `db-engineer` |
| `mobile-architecture-standards` | `mobile-builder`, `mobile-ml-engineer` |
| `on-device-ml-standards` | `mobile-ml-engineer` — CV + sensor fusion specifics |
| `ai-orchestration-standards` | `ai-systems-engineer` — confidence escalation, function-calling scope, cost/latency budgeting |
| `nutrition-data-standards` | `backend-builder`, `db-engineer` — USDA FDC + Open Food Facts specifics |
| `ui-ux-design-standards` | `ui-ux-designer` |
| `deploy-checklist` | `devops-engineer` |

## The phase-gate rule

Every phase in `MASTER-BUILD-PROMPT.md` follows the same shape: architect
(if a new data model is involved) → builder agents → reviewer agents →
your explicit approval. No phase starts until the previous one's gate has
passed and you've said so — this is enforced in the prompt itself, not
just described here.

Three phases carry extra weight worth knowing about going in:

- **Phase 2 (Strength/offline logging)** — the offline→online sync test is
  treated as non-negotiable, matching the spec's own language on CORE-17.
- **Phase 8 (GPS sensor fusion)** — required to validate in a real
  GPS-denied environment (tunnel, parking garage), not just simulated
  dropout data, since that's the actual failure mode the feature exists
  to fix.
- **Phase 12 (AI-18, agentic billing)** — the only phase where
  `security-auditor` reviews *before* implementation starts, not after.
  The spec itself names this as the one place convenience and safety are
  in direct tension; the process reflects that.

## A note on scope

This build covers all 57 features in the spec (20 CORE, 17 UNQ, 20 AI) —
there's no reduced-scope MVP release baked into this plan; every phase is a
step toward the complete platform, not a shippable stopping point. The
phases exist for engineering sequencing and quality control, not for
staged product releases.
