# Backlog — Priority Methodology

This document explains how items in this backlog are ordered, the dependency graph between them, and how to translate a backlog entry into a spec item ready for implementation.

---

## Priority tiers

| Tier | Meaning | Files |
|---|---|---|
| **P0** | Foundation. Infrastructure that other features depend on. Must be done first. | `01-P0-foundations.md` |
| **P1** | High-value features users will see in the first major release after PoC. The "main wave" of v2. | `02-P1-core-ai.md` |
| **P2** | Features with significant value but with dependencies on P1 or harder execution. The "second wave" of v2. | `03-P2-extended-ai.md` |
| ~~**P3**~~ | ~~Multi-platform expansion~~ — **dropped.** PoC and v2 commit to GitHub (cloud + GHES). The earlier P3 tier covered ADO / GitLab / Bitbucket / Gerrit adapters; that work is no longer planned and the corresponding backlog file has been removed. See `spec/01-vision-and-acceptance.md` Principle 6 and `spec/05-non-goals.md` § "Multi-platform" for the rationale. | ~~`04-P3-multi-platform.md`~~ (deleted) |
| **P4** | Polish and quality-of-life. High volume, low individual impact. Ongoing rolling backlog. | `05-P4-polish.md` |

Items within a tier are roughly value-ordered, but **dependency-aware**: a higher-numbered item may move earlier if it unblocks more downstream work, and a higher-value item may be queued behind a lower-value prerequisite.

## Dependency-aware sequencing

The user's instruction was explicit: **infrastructure pieces that many features rely on should be done before reliant features**. This means we don't just sort by value — we sort by `dependency-depth + value`. Each backlog item declares its **direct dependencies**, and a topological-style traversal yields the working order.

### Top-level dependency graph (simplified)

```
                ┌─────────────────────────────────┐
                │    PoC (this is shipped)         │
                │  All AI seams exist + no-op stubs│
                └─────────────┬───────────────────┘
                              │
            ┌─────────────────┴───────────────────┐
            │                                     │
            ▼                                     ▼
┌────────────────────────┐         ┌────────────────────────┐
│ P0-1: Real LLM         │         │ P0-2: Real             │
│ provider               │         │ IAiCache               │
│ (ClaudeCodeLlmProvider)│         │ (file-based or memory) │
└──────────┬─────────────┘         └──────────┬─────────────┘
           │                                  │
           │  ┌───────────────────────────────┘
           │  │
           ▼  ▼
┌────────────────────────────────────────┐
│ P1: Read-only AI features              │
│  ├─ PR summarizer                      │
│  ├─ File focus ranker                  │
│  ├─ Inbox ranker                       │
│  └─ Inbox item enricher                │
└─────────────────┬──────────────────────┘
                  │
   ┌──────────────┴─────────────────┐
   │                                │
   ▼                                ▼
┌──────────────────────┐ ┌──────────────────────┐
│ P0-4: Repo clone     │ │ P2: Write-side AI    │
│ P0-7: MCP server     │ │ (composer assist,    │
│ (host-exposed tools) │ │ validators, drafts,  │
│                      │ │ reconciliation)      │
└──────────┬───────────┘ └──────────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ P2: Chat with repo access    │
│  (the headline AI feature;   │
│   needs both P0-4 and P0-7)  │
└──────────────────────────────┘

Side branches (independent of the AI workstream):
  - P0-3 was moved to P4-G3 (OAuth device flow — gated on distribution decision).
  - P3 (multi-platform adapters) was dropped entirely; the spec commits to a GitHub-shaped tool (cloud + GHES via configurable host).
```

### What this means in practice

- **P0-1, P0-2 are the very first items** to work on after PoC ships, because every P1/P2 AI feature depends on at least one of them.
- **P0-4 (repo clone)** and **P0-7 (MCP server)** are both required before chat-with-repo-access (P2-2) can ship; either can be worked on independently after PoC.
- **P1 features can be implemented in any order** once P0-1 and P0-2 are done; pick by user demand.
- **P2 chat is queued behind P0-4 and P0-7** because the value of chat without repo access (and without host-exposed tools) is much lower.
- **P3 (multi-platform) was dropped.** The spec commits to a GitHub-shaped tool (cloud + GHES); ADO / GitLab / Bitbucket / Gerrit adapters are not planned. See `spec/01-vision-and-acceptance.md` Principle 6.
- **OAuth device flow (originally P0-3) is now P4-G3.** It is gated on the decision to distribute beyond the immediate circle — not a foundation in the dependency-graph sense.

---

## Anatomy of a backlog item

Every entry in the backlog tier files follows this template:

```markdown
### <Item title>

- **Priority sub-rank**: 1, 2, 3 within the tier
- **Direct dependencies**: list of other backlog items that must complete first
- **Estimated effort**: S (≤1 week) / M (1-3 weeks) / L (>3 weeks)
- **Capability flag** (if applicable): the `ai.<x>` flag this item flips on
- **Seam**: which backend interface / frontend slot this populates

**Description.** What the feature does, in user-facing terms.

**Why it's at this priority.** The justification for value + dependency placement.

**Implementation notes.** Concrete pointers — which existing files to touch, which APIs to call, which prompt-engineering challenges exist (for AI items), known pitfalls.

**Acceptance criteria sketch.** A bullet list specific enough to drop into a GitHub issue.

**Connections.** Other backlog items that become more valuable once this is done; backlog items that enable this one.
```

The intent is that converting a backlog item to a working spec item is mostly a matter of expanding the "Implementation notes" section with the specific code surface, and copying "Acceptance criteria sketch" verbatim into the issue / PR description.

---

## How to use this backlog

### When starting v2 work
1. Read `01-P0-foundations.md`. Pick the topmost item with no unmet dependencies.
2. Convert it to a spec item: copy the entry, expand "Implementation notes" with concrete file paths and code surface from PoC.
3. Implement, test, ship.
4. Repeat.

### When users ask for a specific feature
1. Find it in the backlog (search for relevant keywords).
2. Check its "Direct dependencies." If unmet, work on those first.
3. Estimate by adding effort estimates of all unmet dependencies + the item itself.
4. Tell the user: "This needs X and Y first; total ~N weeks." Or pull it forward if its value justifies the dependency cost.

### When deciding between P1 items
1. Read the descriptions of all P1 items.
2. Pick by signal — what does the author actually find missing in their daily PoC use?
3. Avoid picking only by stated priority order; PoC usage data should override the speculative ordering in this doc.

### When a "small" feature request comes in
1. Check `05-P4-polish.md` first. Most small-feature requests already have entries.
2. If not present, add one with full template, then triage.
3. Do not bypass the backlog for "just one quick thing" — that's how scope creeps and PoCs become unshippable.

---

## Re-prioritization

This backlog is a living document. Reorder items as evidence accumulates:

- After 30 days of PoC use, do a pass: which P4 items have *actually bitten* the author? Promote them.
- If a P1 item turns out to be impossible (e.g., Claude can't reliably summarize PRs that touch generated code) → demote, document the failure mode.
- If non-GitHub-backend support ever becomes urgent (e.g., a colleague at an ADO shop wants to use the tool), the work is a refactor of `IReviewService` and the GitHub assumptions baked into the data model — not a feature in this backlog. Reopen the multi-platform decision in `spec/01-vision-and-acceptance.md` Principle 6 first; the spec currently commits to a GitHub-shaped tool and that commitment must be revisited before scheduling work.

Reprioritization should be a deliberate edit to these files with a brief note in the commit message explaining the new evidence.
