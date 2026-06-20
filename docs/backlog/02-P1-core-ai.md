# P1 — Core AI Features

The first wave of AI features users see in v2. Read-only AI: summarization, ranking, enrichment. None of these write to the user's drafts or take actions. They surface understanding; the user decides what to do with it.

These can be implemented in any order once P0-1 (LLM provider) and P0-2 (cache) are done. Pick by what's missing most in your daily PoC use.

---

## P1-1: PR-level summarizer

- **Priority sub-rank**: 1 (top user value: "what does this PR do?" is the first question every reviewer asks)
- **Direct dependencies**: P0-1, P0-2, P0-5
- **Estimated effort**: M
- **Capability flag**: `ai.summary`
- **Seam**: `IPrSummarizer` (replaces `NoopPrSummarizer`)
- **UI slot**: `<AiSummarySlot>`, sitting between the sticky PR header and the sticky iteration tabs (non-sticky; see `spec/04-ai-seam-architecture.md` § `<AiSummarySlot>` for the sticky-stack rationale)

**Description.** Generate a concise summary of what the PR does. Two scopes: whole-PR ("this PR refactors the order pipeline to remove direct database access in favor of repository abstractions; introduces 3 new tests; touches authentication code") and per-iteration ("iteration 3 adds null-handling for the empty-cart case raised in review").

**Why it's at this priority.** Highest signal-to-effort AI feature. Reviewers open a PR and the very first question is "what is this?" Saving 30 seconds per PR adds up. Also the safest AI feature — read-only, low blast radius if the model hallucinates (user can read the diff to verify).

**Implementation notes.**
- New project `PRism.AI.Summarizer` with `ClaudeCodeSummarizer : IPrSummarizer`.
- Inputs: `IReviewContext.CurrentPr`, `Diff`, `Iterations`. For iteration scope, restrict to the iteration's diff range.
- System prompt: "You are a senior engineer summarizing this PR for a reviewer. Be concise and scannable — prefer a short bulleted markdown list of intent and risk areas; use fenced code for code and inline code for symbols; do not pad. Plain prose is fine when it reads better. Do not flatter; do not catastrophize. If the PR title says one thing but the diff shows another, note the mismatch."
- Wrap user-controlled content (PR title, description, file paths) in delimiter tags per P0-5 sanitizer.
- Cache key: `summary:claude-code:<pr_ref>:<head_sha>:<scope>`. Invalidate on `PrUpdated` event.
- Render in `<AiSummarySlot>` as a card: collapsed shows the first sentence, expandable to full summary; small "stale" badge if generated against a now-superseded `head_sha`.
- "Regenerate" action in the card to force-refresh.
- For iteration scope, the iteration tab itself shows the iteration summary (not the PR header slot).

**Prompt-engineering pitfalls.**
- PRs touching auto-generated code (lockfiles, generated proto files) tend to dominate the diff and skew summaries. Detect (via `IFileFocusRanker` once that exists, or heuristically by file name patterns) and mention only briefly: "also includes lockfile updates."
- Very large PRs (>1000 lines, >50 files) require chunked summarization. v2 first iteration: cap at single-pass with a "summary may be incomplete" indicator if input exceeds budget; v3 iteration: chunked summarize-and-merge.
- Reviewers test by reading the summary and checking against the diff; if the summary is consistently 80% accurate but 20% confidently wrong, they stop trusting it. Bias the prompt toward conservative, intent-focused language.

**Acceptance criteria sketch.**
- Summary generates within 10 seconds for a typical 200-line PR.
- Iteration scope restricts input to that iteration's diff range and produces a meaningfully different summary from the whole-PR scope.
- Cache hit on second open of an unchanged PR returns instantly.
- "Regenerate" forces a fresh call.
- Empty/trivial PRs (renames only) produce a sensible terse summary.

**Connections.**
- Enables: better inbox previews (combined with P1-4 inbox enricher).
- Pairs well with: P1-2 file focus ranker (use ranker output to bias what the summary mentions first).

---

## P1-2: File focus ranker

- **Priority sub-rank**: 2 (high value for large PRs)
- **Direct dependencies**: P0-1, P0-2, P0-5
- **Estimated effort**: M
- **Capability flag**: `ai.fileFocus`
- **Seam**: `IFileFocusRanker` (replaces `NoopFileFocusRanker`)
- **UI slot**: new **Hotspots** sub-tab + minimal Files-tree wayfinding dots

**Description.** `ClaudeCodeFileFocusRanker` ranks each changed file `high | medium | low` with a concise bulleted-markdown rationale using a structured-output harness (parse → validate → dedup → backfill → retry-once → all-medium fallback). The primary surface is a dedicated **Hotspots tab** (filtered high/medium, rationale inline, click-through to the file diff) for triage/navigate. A minimal monochrome dot in the Files tree acts as lightweight wayfinding. Rationale is shown **inline** in the tab, not as a Files-tab hover tooltip. Spec: [`docs/specs/2026-06-13-v2-ai-p1-2-file-focus-design.md`](../specs/2026-06-13-v2-ai-p1-2-file-focus-design.md).

**Shipped scope (P1-2, #408).** Ranker + Hotspots tab + wayfinding dots + inline rationale. Tracker: #408.

**Deferred out (tracked):**
- **#414** (P2-4 hunk annotator): per-hunk flagging, Hotspots row→hunk expansion, inline DiffPane markers, lazy/streamed load.
- **#468** (per-hunk review-tracking + completion): per-hunk mark-reviewed, persisted `aiState.reviewedHunks`, per-hunk progress + completion.

**Why it's at this priority.** Large PRs are the highest pain point reviewers report. A reliable ranker turns "where do I even start" into "start here."

**Connections.**
- Pairs well with: P1-1 summarizer (ranker output can inform summary emphasis).
- Pairs well with: P2-4 hunk annotator (high-priority files attract more annotation effort).

---

## P1-3: Inbox ranker

- **Priority sub-rank**: 3 (modest but cumulative value)
- **Direct dependencies**: P0-1, P0-2
- **Estimated effort**: S
- **Capability flag**: `ai.inboxRanking`
- **Seam**: `IInboxRanker` (replaces `NoopInboxRanker`)
- **UI surface**: re-orders rows within each inbox section

**Description.** Re-rank PRs within each inbox section by predicted urgency / blocking-ness, considering signals like: how long has the PR been waiting on you, how blocking is it for the author, file types touched, comment activity, CI state.

**Why it's at this priority.** Lower individual value than per-PR features, but compounds: a better-ranked inbox saves time on every login, every day.

**Implementation notes.**
- New project `PRism.AI.InboxRanker`.
- Input: `InboxSection[]` (each section carries its `PrInboxItem[]`) + minimal metadata per item (age, comment count, has-failing-CI, last-pushed-time).
- Output: `RankedInboxSection[]` — one `RankedInboxSection` per input section, each carrying `RankedPrInboxItem[] Items` ordered by score descending. Both DTOs (`RankedInboxSection`, `RankedPrInboxItem`) are **declared in `PRism.AI.Contracts`** per `spec/04-ai-seam-architecture.md` § DTO catalogue; this feature populates them. The earlier wording suggesting these DTOs are introduced by this feature was incorrect — the placeholder records exist in PoC.
- The ranker re-orders rows **within** each section. It does not re-order sections themselves; the section order is fixed by `spec/03-poc-features.md` § 2.
- Don't fetch full diffs for ranking (way too expensive). Use only metadata that's already in the inbox query.
- Cache per inbox refresh cycle (~2 minutes); invalidate on `InboxUpdated` event.
- Optional UI: small ranking-rationale tooltip on hover ("highlighted because: blocking author for 3 days, no comments yet").

**Prompt-engineering pitfalls.**
- The LLM doesn't know the user's preferences. Inject `userProfile` from config (e.g., "user prefers reviewing auth-related PRs first").
- Avoid jitter — small differences in input shouldn't reorder the inbox dramatically. Consider averaging with previous ranking for stability.

**Acceptance criteria sketch.**
- Ranker produces deterministic ordering for the same input within a 10-minute window (caching ensures this).
- Toggling the capability flag off restores chronological/default order.
- Rank rationale is human-readable concise bulleted markdown.

**Connections.**
- Pairs well with: P1-4 inbox enricher.

---

## P1-4: Inbox item enricher

- **Priority sub-rank**: 4 (rich enhancement to the inbox experience)
- **Direct dependencies**: P0-1, P0-2, P0-5
- **Estimated effort**: M
- **Capability flag**: `ai.inboxEnrichment`
- **Seam**: `IInboxItemEnricher` (replaces `NoopInboxItemEnricher`)
- **UI slot**: per-row badges + hover-preview panel in inbox

**Description.** For each PR in the inbox, generate a category badge ("Docs", "Refactor", "Bug fix", "Feature", "Test-only", "Risky") plus a short hover-preview summary so the user can decide which PR to open without clicking.

**Why it's at this priority.** Reduces "open-and-back" friction. Users often open a PR just to read the summary, then close. Rendering that summary in the inbox saves the navigation cost.

**Implementation notes.**
- New project `PRism.AI.InboxEnricher`.
- Inputs per PR: title, description (sanitized per P0-5), file path list, line-count summary, author, age.
- Output per PR: `{ category, hover_summary }`.
- Cache per `(pr_ref, head_sha)` — same key as P1-1 since they share invalidation triggers.
- Render category as a small colored chip on the row; render hover_summary in a tooltip panel that appears on row hover (or persistent expandable section if the user prefers).
- For PRs the user has already viewed, the unread badges (commits, comments) take precedence over enrichment chips.
- Integrate with inbox refresh cycle — enrich on inbox load, re-enrich on `PrUpdated`.

**Prompt-engineering pitfalls.**
- This runs on many PRs; cost and latency add up. Batch in a single LLM call if possible (one prompt, JSON array output).
- Categories must be a fixed enum (otherwise users see a mess of slightly-varying labels: "Refactor" vs "refactoring" vs "refactor: cleanup"). Enforce the enum in the prompt and validate.

**Acceptance criteria sketch.**
- All visible PRs receive a category chip.
- Hover summary surfaces within 200ms (cache or pre-fetched).
- Categories adhere to the documented enum (or fallback "Other").
- Toggling the capability flag off hides chips and disables the hover panel.

**Connections.**
- Compounds with: P1-3 (ranker uses categories as a feature).
- Compounds with: P1-1 (similar prompt; can share cache and prompt-engineering iterations).
