# AI Roadmap Issue Tracking — Design

> **Status (2026-06-12).** Design approved by owner. Defines the GitHub issue/epic/milestone
> structure that mirrors the v2 AI backlog so "what's next" is answerable by opening one issue
> instead of re-deriving it from the backlog each time. Execution (creating the issues) follows
> this doc.

## Problem

The v2 AI feature track is decomposed in detail under [`docs/backlog/`](../backlog/) (P0
foundations → P1 core → P2 extended), but that decomposition is **not wired to GitHub**. Today,
figuring out "which AI item do I pick up next" means re-reading the backlog, cross-referencing it
against what already shipped on `V2`, and reconstructing the dependency order by hand — the exact
exercise this doc exists to retire.

We want GitHub to carry a **durable, dependency-aware tracker** for the whole AI roadmap, serving
three aims at once:

1. **Execution queue** — what to work on next, with blocked-vs-ready visible.
2. **Public roadmap** — anyone looking at the repo sees where AI is headed.
3. **Durable mirror** — the analysis is captured once, not repeated.

## Approach (chosen)

**Backlog item → coarse root issue → (brainstorm on pickup) → refined child issues.**

Each remaining backlog item gets one **deliberately coarse** root issue. A root issue is a pointer
to its backlog section plus an acceptance sketch — it is *not* a pre-written spec. When a root is
picked up, it triggers a brainstorm that produces the refined, implementable child issues, linked
back to the root. A single master **epic** collapses all roots into a dependency-ordered readiness
map.

### Why coarse roots (the staleness argument)

The backlog's own [`00-priority-methodology.md`](../backlog/00-priority-methodology.md) argues
*against* pre-filing speculative work ("pick by what's missing most in your daily use"; "PoC usage
data should override the speculative ordering"). Filing 25 fully-spec'd tickets would create a
second source of truth that drifts from the backlog docs.

Coarse roots resolve this: the root issue holds only stable metadata (tier, flag, seam,
dependencies, a link to the backlog section). All volatile detail lives either in the backlog
`.md` (the source of truth) or in just-in-time child issues created at brainstorm time. The root
does not drift because it carries almost nothing that *can* drift.

### Alternatives considered

- **Per-tier milestones (Foundations / Core / Extended) + epic.** Three progress bars, but three
  milestones to maintain and the epic duplicates them. Flat per-tier bars also can't express that
  chat is blocked on three prerequisites — only a hand-ordered checklist can. Rejected.
- **Epic-only, no milestone.** Lightest, keeps milestones execution-only per `roadmap.md`. Loses
  the progress-bar and filter affordance. Rejected in favor of one lightweight milestone.

## Current state (shipped on `V2`, as of 2026-06-12)

Shown in the epic for completeness; **not** re-filed as roots.

| Backlog item | What shipped |
|---|---|
| Seam architecture, tri-state `AiMode` (off/preview/live), `/api/capabilities`, per-feature gates (`ui.ai.features`) | `AiSeamSelector`, `AiCapabilityResolver` over a live `realSeams` map |
| **P0-1** LLM provider (one-shot) | `ClaudeCodeLlmProvider` (`claude -p`, env-allowlisted, `--tools ""`, JSON out) |
| **P0-5** Prompt-injection defense | `PromptSanitizer.WrapAsData` |
| **P0-6** Token / cost tracking | `JsonlTokenUsageTracker` + metadata-only `JsonlAiInteractionLog` |
| **P1-1** PR summarizer | `ClaudeCodeSummarizer` — live, diff-grounded, PR-nature category, consent-gated egress, Live-mode UI, 30s availability-probe cache |
| Consent / egress disclosure | `AiConsentState`, egress-disclosure + consent endpoints, `EgressConsentModal` |
| **P2-14** "pending CI" refine | Shipped to `main` as #286 |

## Artifacts to create

### Master epic

Issue **"[AI] v2 augmentation roadmap"** — labels `area:ai` + `roadmap`. Body is the readiness
map in [§ The master epic](#the-master-epic), a dependency-ordered checklist linking every root,
with a legend (✅ shipped / 🟢 ready / ⛔ blocked) and a one-line "next up" pointer. Opening this
one issue answers "what do I work on next."

### Milestone

**"v2 — AI"** — every root issue joins it, yielding one progress bar and one filter. This is a
feature-track milestone, distinct from the existing phase-based execution milestones; `roadmap.md`
reserves milestones for execution, and this is the AI execution track.

### Labels

| Label | Purpose |
|---|---|
| `ai:foundation` | Tier = P0 (infrastructure) |
| `ai:core` | Tier = P1 (read-only features) |
| `ai:extended` | Tier = P2 (higher-touch features) |
| `roadmap` | The master epic |

Tier labels use **words, not `p0/p1/p2`**, to avoid confusion with the existing severity labels
`priority:p1` / `priority:p2` (which mean correctness/UX severity, an orthogonal axis). The backlog
tier (P0/P1/P2) is still named in each issue's title and body for traceability.

### Root-issue template

```
Title:  [AI] P1-2 — File focus ranker
Labels: area:ai, ai:core, needs-design      Milestone: v2 — AI
Body:
  Coarse roadmap root. Detail lives in the backlog; refined slices become child issues.
  • Backlog:    docs/backlog/02-P1-core-ai.md § P1-2  (V2 branch)
  • Flag:       ai.fileFocus       • Seam: IFileFocusRanker (replaces Noop)
  • Depends on: P0-1 ✅ ; P0-2 (soft)        • Effort: M
  Acceptance sketch (from backlog): <3-4 bullets>
  On pickup → brainstorm → spec → child issues linked below.
  Children: (filed at brainstorm time)
```

Dependencies are recorded as text in the body (and as GitHub issue references once the roots have
numbers). "Soft" marks a dependency the feature works without but pays for in cost/latency (the
cache, P0-2); only hard blockers gate readiness.

## Root-issue inventory (20 new roots)

### Foundations — `ai:foundation` (5 roots)

P0-1 (one-shot), P0-5, P0-6 are shipped; shown in the epic, not re-filed.

| Root | Status | Depends on | Effort |
|---|---|---|---|
| **P0-2** — Real `IAiCache` (persistent / two-tier) | 🟢 ready (adopts #397, #374 as children) | — | M |
| **P0-1b** — Streaming LLM provider (`IStreamingLlmProvider`, stream-json) | 🟢 ready | P0-1 ✅ | M |
| **P0-4** — `GitRepoCloneService` (workspace / worktree mgmt) | 🟢 ready | — | M |
| **P0-7** — MCP server (PR-context tools for chat) | 🟢 ready | P0-1 ✅, P0-1b | M |
| **P0-9 / P0-8** — Iteration-clustering calibration corpus (+ multipliers, conditional) | 🟢 ready (independent track) | S3 ✅ | L |

> **P0-1b is not a numbered backlog item.** The backlog folds the streaming path into P0-1, but
> `V2` shipped only the one-shot path. The streaming session is a hard prerequisite for chat
> (P2-2), so it is broken out as its own foundation root. Its backlog reference is
> `01-P0-foundations.md § P0-1` (streaming-path bullets).

> **P0-9/P0-8 is one root.** P0-8 (additional clustering multipliers) is conditional on what the
> P0-9 calibration corpus reveals; the backlog says P0-8 may be deferred indefinitely if the two
> live multipliers reach ≥70% agreement. One root tracks the calibration; P0-8 becomes a child
> only if calibration motivates it. This is a tuning track semi-independent of the LLM features.

### Core / read-only P1 — `ai:core` (3 roots)

P1-1 (summarizer) is shipped.

| Root | Status | Depends on | Effort |
|---|---|---|---|
| **P1-2** — File focus ranker | 🟢 ready (relates #136 hotspots) | P0-1 ✅ ; P0-2 (soft) | M |
| **P1-3** — Inbox ranker (absorbs duplicate P2-13) | 🟢 ready | P0-1 ✅ ; P0-2 (soft) | S |
| **P1-4** — Inbox item enricher | 🟢 ready | P0-1 ✅ ; P0-2 (soft) | M |

> **P2-13 is a duplicate of P1-3** (both are "register a real `IInboxRanker`"). Folded into the
> P1-3 root; not filed separately.

### Extended P2 — `ai:extended` (12 roots)

P2-13 folded into P1-3; P2-14 shipped (#286).

| Root | Status | Depends on | Effort |
|---|---|---|---|
| **P2-1** — Composer assistant ("Refine with AI") | 🟢 ready | P0-1 ✅ ; P0-2 (soft) | M |
| **P2-2** — PR chat service *(headline)* | ⛔ blocked | P0-1b, P0-4, P0-7 | L |
| **P2-3** — Pre-submit validators | 🟢 ready | P0-1 ✅ ; P0-2 (soft) | M |
| **P2-4** — Hunk annotator | ⛔ soft-blocked | P1-2 (recommended for cost control) | M |
| **P2-5** — Draft reconciliation assistant | 🟢 ready | P0-1 ✅ ; P0-2 (soft) | S |
| **P2-6** — Draft comment suggester | 🟢 ready (ship last — lowest trust) | P0-1 ✅ ; P0-2 (soft) | M |
| **P2-7** — Per-iteration summarizer | 🟢 ready (small extension of P1-1) | P1-1 ✅ | S |
| **P2-8** — Whitespace-noise categorization | 🟢 ready (may be non-LLM) | P0-1 ✅ | S |
| **P2-9** — File-purpose categorization | 🟢 ready | P0-1 ✅ | S |
| **P2-10** — Risk scoring per hunk | ⛔ blocked | P2-4 | S |
| **P2-11** — Test-coverage delta analysis | ⛔ blocked | P2-9 | M |
| **P2-12** — Conversation summarization | 🟢 ready | P0-1 ✅ | S |

## Existing issues fold in (not duplicated)

| Issue | Action |
|---|---|
| **#397** (file-backed `IAiCache`) | Re-label `ai:foundation`; child of **P0-2** root |
| **#374** (base-sha cache key) | Re-label `ai:foundation`; child of **P0-2** root |
| **#379** (token under-reporting) | Link under shipped P0-6 as a refinement |
| **#136** (AI hotspots view) | Link as related to **P1-2**; decide child-vs-sibling at the P1-2 brainstorm |
| **#296** (win32 baselines) | `area:ai` housekeeping; leave as-is |
| **#401** (claude.yml security) | CI/security, not a roadmap root; leave as-is |

## The master epic

The epic body is the inventory collapsed into one dependency-ordered checklist:

```
Legend: ✅ shipped   🟢 ready   ⛔ blocked

Foundations (ai:foundation)
  ✅ P0-1  one-shot LLM provider
  ✅ P0-5  prompt-injection defense
  ✅ P0-6  token / cost tracking            (refine: #379)
  🟢 P0-2  real IAiCache                    (#... — adopts #397, #374)
  🟢 P0-1b streaming LLM provider           (#...)
  🟢 P0-4  GitRepoCloneService              (#...)
  🟢 P0-7  MCP server                       (#... — needs P0-1b)
  🟢 P0-9/8 clustering calibration          (#... — independent track)

Core / read-only (ai:core)
  ✅ P1-1  PR summarizer                     (refine: #374)
  🟢 P1-2  file focus ranker                (#... — relates #136)
  🟢 P1-3  inbox ranker                     (#... — absorbs P2-13)
  🟢 P1-4  inbox item enricher              (#...)

Extended (ai:extended)
  🟢 P2-1  composer assistant               (#...)
  ⛔ P2-2  PR chat (headline)               (#... — blocked: P0-1b, P0-4, P0-7)
  🟢 P2-3  pre-submit validators            (#...)
  ⛔ P2-4  hunk annotator                   (#... — blocked: P1-2)
  🟢 P2-5  draft reconciliation             (#...)
  🟢 P2-6  draft suggester (ship last)      (#...)
  🟢 P2-7  per-iteration summarizer         (#...)
  🟢 P2-8  whitespace categorization        (#...)
  🟢 P2-9  file-purpose categorization      (#...)
  ⛔ P2-10 risk scoring per hunk            (#... — blocked: P2-4)
  ⛔ P2-11 test-coverage delta              (#... — blocked: P2-9)
  🟢 P2-12 conversation summarization       (#...)
  ✅ P2-14 pending-CI refine                (#286)

Next up: any 🟢 in Foundations or Core. Chat (P2-2) unblocks after P0-1b + P0-4 + P0-7.
```

`(#...)` placeholders are filled with real numbers once the roots are created.

## Non-goals

- **Not copying the backlog into issues.** Roots link the backlog section; they don't restate it.
- **Not pre-spec'ing.** Roots stay coarse until picked up; the brainstorm produces the detail.
- **Not retiring the backlog `.md` files.** They remain the detailed source of truth; GitHub is
  the index and execution surface.
- **Not creating per-tier milestones.** One `v2 — AI` milestone; the epic carries tier grouping.

## Maintenance

- When a root is picked up: brainstorm → spec → child issues linked on the root → flip the epic
  line as children land.
- When the backlog changes shape (per its own "When a slice changes shape" rule): update the
  affected root's backlog link and acceptance sketch; the epic line tracks status only, so most
  backlog edits need no epic change.
- Readiness (🟢/⛔) is maintained **only in the epic**, not as per-issue labels — labels go stale
  as dependencies close; the epic is the single readiness view.

## Net

1 epic + 20 root issues + 1 milestone + 4 labels; 5 existing issues adopted.
