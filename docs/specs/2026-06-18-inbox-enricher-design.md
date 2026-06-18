# Inbox item enricher (#410, P1-4) — design

**Status:** design / awaiting human review
**Issue:** [#410 — [AI] P1-4 — Inbox item enricher](https://github.com/prpande/PRism/issues/410)
**Branch base:** `V2` (AI feature track)
**Backlog source:** `docs/backlog/02-P1-core-ai.md` § P1-4 (backlog wins on any conflict)

---

## 1. Summary

Replace `NoopInboxItemEnricher` with a real LLM-backed `ClaudeCodeInboxItemEnricher` that
assigns each **open** inbox PR a **category chip** drawn from a fixed enum, derived from the
PR's **title + GitHub description only** (never the diff). The chip already renders in
`InboxRow`; the seam, DTO, capability gate, and Preview-mode placeholder are all built. This
slice fills in the brain and the asynchronous delivery, and flips the live capability on.

**Explicitly out of scope** (each is its own roadmap item):
- Hover-preview summary panel — the `InboxItemEnrichment.HoverSummary` field stays unused this
  slice. No hover UX.
- Inbox ranking / reordering — P1-3 (#409).
- Risk scoring — P2-10 (#420).
- AI "work in progress" loading indicator for the pop-in gap — #508.

## 2. What already exists (V2) vs. what this slice adds

The pipeline is almost entirely wired. This slice is "write the implementation + async
delivery + flip the flag," not "build the feature end to end."

**Already present on V2 — unchanged by this slice:**
- Seam `IInboxItemEnricher.EnrichAsync(IReadOnlyList<PrInboxItem>, CancellationToken)`
  (`PRism.AI.Contracts/Seams/IInboxItemEnricher.cs`).
- DTO `InboxItemEnrichment(string PrId, string? CategoryChip, string? HoverSummary)`
  (`PRism.AI.Contracts/Dtos/`).
- `NoopInboxItemEnricher` (empty array) and `PlaceholderInboxItemEnricher` (canned "Refactor"
  chip for Preview mode).
- Capability flag `InboxEnrichment` (`AiCapabilities`) + feature key `"inboxEnrichment"`
  (`AiSeamFeatureKeys`) + resolver gate (`AiCapabilityResolver`).
- Orchestrator integration: `InboxRefreshOrchestrator` already calls `EnrichAsync` and flows
  the result through `InboxSnapshot.Enrichments` → `/api/inbox` → `InboxResponse.Enrichments`.
- Frontend chip render: `InboxRow` renders `enrichment.categoryChip` with the "AI" marker,
  gated on `useAiGate('inboxEnrichment')`; lookup keyed by `prId` = `"owner/repo#number"`.
- Delivery transport: `InboxUpdated` bus event → `SseChannel` inbox-updated SSE frame →
  `useInbox.reload()` → `GET /api/inbox` (serves cached snapshot `orch.Current`, no GitHub
  re-query).

**Added by this slice:**
1. `ClaudeCodeInboxItemEnricher` — real LLM-backed implementation (`PRism.Web/Ai/`).
2. `Description` field plumbed onto `RawPrInboxItem` → `PrInboxItem`, populated from the PR
   `body` already present in the existing GitHub search response (no new HTTP call).
3. Asynchronous, non-blocking delivery: cached-immediate return + background batch + snapshot
   enrichment-merge + `InboxUpdated` publish.
4. DI registration into `realSeams[typeof(IInboxItemEnricher)]`.
5. Frontend: `LIVE_CAPABILITIES.inboxEnrichment: true` in `useCapabilities.ts`.

## 3. Category enum

A pure **kind-of-change** axis (intentionally *not* a risk axis — "Risky" from the backlog
sketch is dropped; risk is orthogonal and is its own roadmap item, P2-10):

```
Feature · Bug fix · Refactor · Docs · Test-only · Chore · Other
```

- `Chore` covers build/deps/config/tooling churn that is neither a feature nor a fix.
- The enum is enforced **twice**: instructed in the prompt, and re-validated in code after the
  model responds. The model will occasionally return near-misses ("fix", "bugfix",
  "refactoring", "documentation"); these are normalized to the canonical label via a
  case-insensitive normalization map. Anything that does not normalize to a known label — and
  any item the model could not confidently categorize — becomes `Other`. A raw model string
  never reaches the chip.

**Accuracy note (accepted tradeoff).** With title + description only and no file list, `Docs`
and `Test-only` are inferred from wording ("update README", "add tests") rather than from
`.md` / test-file paths. A PR with a terse title and empty body will frequently land in
`Other`. This is the deliberate cost of not sending the diff; `Other` is an honest fallback,
not a bug.

## 4. Inputs and plumbing

**Inputs per PR:** title + description. Nothing else — no diff, no file list, no stats.

`PrInboxItem` / `RawPrInboxItem` do not carry a description today. Plumbing:

- Add `string? Description` to `RawPrInboxItem` and `PrInboxItem`.
- Populate it in `GitHubSectionQueryRunner.SearchAsync` from the `body` property already
  returned by the GitHub search response that the runner parses for `title`/author/repo.
  **Zero new HTTP calls** — the body rides the existing fetch.
- The description is untrusted PR-author text → wrap through the existing
  `PromptSanitizer.WrapAsData()` (P0-5) before it enters the prompt.
- Truncate the description to a cap (~1–2k chars) so an oversized PR body cannot blow the
  prompt budget. Title is short and passed whole.

The `Description` field is additive and nullable; existing consumers and serialization are
unaffected. (Note: per the project convention that getter-only/extra serialized properties can
leak into persisted `state.json`, confirm `Description` is not inadvertently persisted where it
shouldn't be; it is a transport/DTO field, not config.)

## 5. Cost and cache model

The enricher runs against the whole inbox on a background poll, so cost discipline is the
central concern.

- **Open PRs only.** The orchestrator filters to open PRs (`MergedAt == null &&
  ClosedAt == null`) before calling the enricher. Closed/merged sections never spend tokens.
- **One batched LLM call**, JSON-array output, over only the **cache-misses**. The model is
  asked to return `[{ "prId": "...", "category": "..." }, ...]`.
- **Cache key `(prRef, headSha)`** — same invalidation family as `ClaudeCodeSummarizer` /
  `ClaudeCodeFileFocusRanker`. A PR is re-enriched only when its head SHA moves. Steady-state
  polls (no new commits) make **zero LLM calls**.
- **Hard gate.** The enricher only runs when AiMode = Live **and** the user has consented. In
  any other mode the seam selector returns `NoopInboxItemEnricher` (empty array, no LLM, no
  tokens). Preview mode continues to show the placeholder chip via
  `PlaceholderInboxItemEnricher`.
- Token usage and the interaction are recorded via the existing `ITokenUsageTracker` and
  `IAiInteractionLog`, mirroring the file-focus ranker (component name e.g.
  `"inbox-enrichment"`). Recording is non-fatal.
- **Provider failure is not cached.** On `LlmProviderException` (timeout / provider error) the
  batch fails soft: no chips are produced for the misses this round, the failure is logged, and
  the next poll retries. The inbox itself is never affected (see §6 — enrichment is off the
  inbox's critical path).
- **Malformed JSON:** retry once with a terse reminder suffix (the ranker's pattern); on a
  second failure, treat as a soft failure for that batch.

## 6. Asynchronous "pop-in" delivery

Enrichment must never block the inbox render, and chips must appear within roughly the LLM
call duration — not on the next poll cycle (which can be minutes away).

1. `InboxRefreshOrchestrator.RefreshAsync` calls `EnrichAsync`, which returns **only the
   already-cached enrichments, immediately**. On a cold cache this is an empty map and the
   inbox renders instantly with no chips.
2. For the uncached open PRs, a **single-flight background batch** runs (at most one batch in
   flight; a second refresh that finds the same misses already in flight does not start a
   duplicate call).
3. On completion the background task:
   - merges results into the enricher's `(prRef, headSha)` cache,
   - asks the orchestrator to swap the merged enrichment map into the **current snapshot in
     place** — `_current = _current with { Enrichments = merged }` — with **no GitHub
     re-query**,
   - the orchestrator publishes `InboxUpdated`.
4. Existing transport delivers it: `SseChannel` emits an inbox-updated SSE frame →
   `useInbox.reload()` → `GET /api/inbox` returns the updated cached snapshot → **chips appear
   within ~the LLM call duration.**

**Component boundary / circular-dependency note.** The orchestrator resolves the enricher via
the seam selector, so the enricher must not hold a direct reference back to the orchestrator.
Completion is signalled over the existing `IReviewEventBus` (the enricher publishes a small
"enrichments ready" event; the orchestrator subscribes and performs the snapshot mutation +
`InboxUpdated` publish), keeping snapshot ownership solely in the orchestrator. The exact event
type and which component owns the background task (the enricher itself vs. an orchestrator-side
helper) are finalized in the implementation plan; this design fixes the *behavior* (cached-
immediate, background single-flight, in-place snapshot merge, reuse of `InboxUpdated`), not the
final class split.

## 7. Gating and frontend

- Backend gate is unchanged (`AiCapabilityResolver` already maps `inboxEnrichment`); the only
  new effect is that `realSeams` now contains a real implementation, so Live + consented
  resolves to it instead of falling back to Noop.
- Frontend: flip `LIVE_CAPABILITIES.inboxEnrichment: true` in `useCapabilities.ts`. The chip
  render and `useAiGate('inboxEnrichment')` gate already exist — **no new frontend
  components**. With the flag off, chips are hidden exactly as today.

## 8. Testing

Backend tests mirror the file-focus ranker suite (`PRism.Web.Tests/Ai/`):

- Enum normalization: near-miss labels normalize to canonical; unknown / low-confidence → `Other`.
- Batch covers only cache-misses; cache hit on unchanged head SHA makes no LLM call; head-SHA
  move evicts and re-enriches.
- Open-only filter: merged/closed items are excluded from the batch.
- Malformed-JSON retry-once, then soft failure; provider exception → soft failure, not cached,
  inbox unaffected.
- Async path: background completion merges into the snapshot and publishes `InboxUpdated`
  exactly once; `EnrichAsync` returns cached-only synchronously (non-blocking).
- Description plumbing: `GitHubSectionQueryRunner` populates `Description` from `body`;
  sanitization + truncation applied before prompt assembly.

Frontend / e2e:

- Live mode is mocked at the seam like the other AI e2e specs; Preview-mode placeholder chip
  already has coverage.
- **Zero new visual baselines** — the chip render is unchanged; only the data source changes.

## 9. Acceptance criteria (from backlog § P1-4, reconciled with decisions)

- Every visible **open** PR receives a category chip when AiMode = Live + consented (cold-cache
  PRs receive theirs asynchronously within ~the LLM call duration, not the poll interval).
- Categories adhere to the documented enum or fall back to `Other`; no raw model strings reach
  the UI.
- Toggling the capability flag (or AiMode) off hides chips and makes no LLM calls.
- Closed/merged PRs are never enriched and never spend tokens.
- Steady-state polls with no new commits make zero LLM calls.
- Hover-preview summary is **not** delivered this slice (deferred; `HoverSummary` unused).
```
