# Inbox item enricher (#410, P1-4) — design

**Status:** design / awaiting human review
**Issue:** [#410 — [AI] P1-4 — Inbox item enricher](https://github.com/prpande/PRism/issues/410)
**Branch base:** `V2` (AI feature track)
**Backlog source:** `docs/backlog/02-P1-core-ai.md` § P1-4. The backlog wins on conflict; this
design deviates from it in three deliberate, recorded ways (see §10 — Deviations).

---

## 1. Summary

Replace `NoopInboxItemEnricher` with a real LLM-backed `ClaudeCodeInboxItemEnricher` that
assigns each **open, non-draft** inbox PR a **category chip** from a fixed kind-of-change enum,
derived from the PR's **title + GitHub description only** (never the diff). The chip already
renders in `InboxRow`; the seam, DTO, capability gate, and Preview-mode placeholder are all
built. This slice fills in the brain, adds the open/non-draft filter, makes delivery
asynchronous (chips "pop in" without blocking the inbox), suppresses low-confidence output, and
adds a non-AI "Draft" status chip for draft PRs.

**Explicitly out of scope** (each is its own roadmap item):
- Hover-preview summary panel — `InboxItemEnrichment.HoverSummary` stays `null`/unused. No hover UX.
- Inbox ranking / reordering — P1-3 (#409).
- Risk scoring — P2-10 (#420).
- AI "work in progress" loading indicator for the pop-in gap — #508.

## 2. What already exists (V2) vs. what this slice adds

The pipeline is almost entirely wired. This slice is "write the implementation + async
delivery + filters + flip the flag," not "build the feature end to end."

**Already present on V2 — unchanged:**
- Seam `IInboxItemEnricher.EnrichAsync(IReadOnlyList<PrInboxItem>, CancellationToken)`.
- DTO `InboxItemEnrichment(string PrId, string? CategoryChip, string? HoverSummary)`.
- `NoopInboxItemEnricher` (empty array) and `PlaceholderInboxItemEnricher` (canned chip for Preview).
- Capability flag `InboxEnrichment` + feature key `"inboxEnrichment"` + resolver gate.
- Orchestrator already calls `EnrichAsync` and flows results through `InboxSnapshot.Enrichments`
  → `/api/inbox` → `InboxResponse.Enrichments`.
- Frontend chip render: `InboxRow` renders `enrichment.categoryChip` with the "AI" marker,
  gated on `useAiGate('inboxEnrichment')`; the render already shows **nothing** when
  `categoryChip` is null/absent (this is what makes Other-suppression and the open/draft filter
  free on the frontend).
- Delivery transport: `InboxUpdated` bus event → `SseChannel` inbox-updated frame →
  `useInbox.reload()` → `GET /api/inbox` (serves cached snapshot `orch.Current`, no GitHub re-query).

**Added by this slice:**
1. `ClaudeCodeInboxItemEnricher` (`PRism.Web/Ai/`) — real LLM-backed implementation, owning its
   own cache + per-PR single-flight + background batch.
2. `Description` plumbed onto `RawPrInboxItem` → `PrInboxItem` (via `MaterializePrInboxItem`),
   read from the PR `body` already present in the GitHub search response; marked `[JsonIgnore]`
   so it never reaches the wire (see §4).
3. `IsDraft` plumbed the same way, from the GitHub search item's `draft` field.
4. An **open + non-draft filter** at the enricher call site in the orchestrator (net-new — see §5).
5. Asynchronous, non-blocking delivery: cached-immediate return + background batch +
   orchestrator-owned locked snapshot merge + unconditional `InboxUpdated` publish (§6).
6. Frontend: flip `LIVE_CAPABILITIES.inboxEnrichment: true`; render a non-AI "Draft" chip; the
   existing null-guard handles Other-suppression with no code change.

## 3. Category enum

A pure **kind-of-change** axis:

```
Feature · Bug fix · Refactor · Docs · Test-only · Chore · Other
```

- **Deviation from backlog (recorded):** the backlog sketch lists `Risky` as a category. It is
  dropped here. Risk is an *orthogonal* axis — a "Bug fix" can be risky or trivial; folding a
  risk verdict into a kind-of-change enum is a category error. Risk scoring is its own roadmap
  item, P2-10 (#420). (See §10.)
- `Chore` covers build/deps/config/tooling churn that is neither a feature nor a fix.
- The enum is enforced **twice**: instructed in the prompt, and re-validated in code after the
  model responds, via a case-insensitive normalization map ("fix"/"bugfix" → `Bug fix`,
  "refactoring" → `Refactor`, "documentation" → `Docs`, …). A raw model string never reaches the UI.

**Low-confidence → no chip (decision).** Anything that does not normalize to a known label, and
any item the model marks low-confidence, resolves to **no chip** — the enricher returns a `null`
`CategoryChip` and the row renders nothing (the existing `enrichment?.categoryChip` guard makes
this free). We do **not** render a visible "Other · AI" pill. Rationale: with title+description
only, terse-title/empty-body PRs would otherwise produce a wall of identical "Other" chips,
which spends tokens, occupies the row metadata slot, and erodes trust in the shared "AI" marker
across all AI features — worse than no chip. `Other` exists internally as the validation fallback
but is not surfaced as a chip.

**Accuracy note (accepted tradeoff).** Without file paths, `Docs` / `Test-only` / `Chore` are
inferred from title/description wording rather than from file extensions. Many PRs will resolve
to no chip. This is the deliberate cost of not sending the diff (and not paying a per-PR file
fetch — see §4). Per-category fire-rate and the no-chip rate should be eyeballed live before the
feature is considered settled (see §9 quality AC).

## 4. Inputs and plumbing

**Inputs per PR:** title + description. Nothing else — no diff, no file list, no stats.

- **Deviation from backlog (recorded):** the backlog lists `file path list` and `line-count
  summary` as additional inputs. They are dropped. The file path list is **not** carried in the
  inbox search response — obtaining it requires a per-PR `GET /pulls/{n}/files` call, exactly the
  kind of inbox-load fetch this feature avoids. Line counts (`Additions`/`Deletions`) *are*
  already on the row but are excluded to keep the input to the author's stated intent (title +
  description). This narrows categorization accuracy (see §3) — an accepted, recorded tradeoff. (See §10.)

**Description plumbing** (`body` is present on each GitHub search item but **not read today**):
- Add `string? Description` to `RawPrInboxItem` and `PrInboxItem` (trailing, defaulted
  `= null`, so the ~6 existing construction sites are unaffected).
- Read it in `GitHubSectionQueryRunner.SearchAsync` from the item's `body`, null-tolerant
  (`body` is JSON-null for PRs with no description → `null`, which is the §3 no-chip path).
- **Thread it through `MaterializePrInboxItem`** in the orchestrator — adding the field to the
  records is necessary but not sufficient; the `RawPrInboxItem` → `PrInboxItem` materialization
  must copy `Description`, or the enricher always sees `null`.
- **`Description` stays off the wire.** `PrInboxItem` is serialized into the `/api/inbox`
  response; an un-annotated property would egress every PR's body (raw author content) to the
  frontend and risk inflating persisted `state.json` (the known STJ getter-serialization
  gotcha). Mark `Description` `[JsonIgnore]`; it is in-process only, consumed by the enricher and
  never serialized. A regression test asserts the `/api/inbox` JSON contains no PR body text.

**Draft plumbing:** add `bool IsDraft` to `RawPrInboxItem` → `PrInboxItem` the same way, read
from the search item's `draft` field. Unlike `Description`, `IsDraft` **is** allowed on the wire
(the frontend needs it to render the "Draft" chip).

**Prompt-injection hardening (both fields are attacker-controllable):**
- Both the **description and the title** are wrapped through `PromptSanitizer.WrapAsData(content,
  tag, maxChars)` into labeled, capped data regions (e.g. tags `pr_description`, `pr_title`).
  The title is *not* "passed whole" — any GitHub user can craft a title with fake sentinel tags.
- The enricher's **system prompt must explicitly instruct** the model to treat the wrapped
  regions as untrusted data and never follow instructions found inside them — mirroring the
  file-focus ranker's `SystemPromptV1` framing. (`WrapAsData` is structural defense-in-depth, not
  a guarantee; the prompt instruction is the second layer.)
- Description is truncated via the `maxChars` cap (~1–2k chars) so an oversized body cannot blow
  the prompt budget.
- **Containment:** output is constrained to the fixed enum and re-validated in code, so the worst
  reachable outcome of a steered model is a *wrong category* (or no chip), never arbitrary text
  on the row. This is the primary reason the injection blast radius is acceptable.

## 5. Cache and cost model

The enricher runs against the inbox on a background poll, so cost discipline matters — but the
model below makes steady-state cost near-zero and bounds total cost to "distinct open non-draft
PRs seen this process lifetime."

- **Open + non-draft only (net-new filter).** Today the orchestrator builds the enricher input
  as `sectionsFinal.SelectMany().DistinctBy(Reference)`, which **includes the recently-closed
  section** — so a real enricher would spend tokens on closed PRs (violating the AC). This slice
  adds a filter before `EnrichAsync`: keep only `MergedAt == null && ClosedAt == null && !IsDraft`.
  (Recently-closed items carry populated `ClosedAt`/`MergedAt`; the predicate is reliable.)
- **Enrich once per content; never re-enrich on a new commit (decision).** The enricher's input
  is title + description, which a `git push` does **not** change — so head-SHA was never a valid
  cache key for this feature (it would re-spend tokens on byte-identical input). The cache is
  keyed on a **hash of (title + description)**. A PR is enriched exactly once per distinct
  title/description content; pushing new commits never triggers recalculation. Editing a PR's
  title/description (rare) naturally re-enriches because the hash changes.
- **In-memory; lost on cold start.** A `ConcurrentDictionary` on the singleton enricher, no
  persistence (consistent with the other AI seams today — the real persistent `IAiCache`/P0-2 is
  unshipped). A process restart re-enriches lazily. No head-SHA eviction, no R7 write-after-evict
  guard, no debounce, no per-poll cost cap — all moot under content-hash, once-per-content caching.
- **One batched LLM call** over only the cache-misses, JSON-array output
  (`[{ "prId": "...", "category": "..." }, ...]`). **Per-PR single-flight:** a PR already being
  enriched in an in-flight batch is not re-queued; a later poll batches only the not-in-flight
  misses (a newly-arrived PR is never starved by an unrelated in-flight batch).
- **Hard gate.** Runs only when AiMode = Live **and** consented; otherwise the seam selector
  returns `NoopInboxItemEnricher` (empty array, no LLM, no tokens). Preview mode keeps showing
  the placeholder chip.
- **Consent re-check before egress.** Because the batch is detached and can outlive a mid-flight
  consent withdrawal, the background task re-checks `IsConsented(...)` immediately before the
  provider call and aborts if consent was revoked (a tighter guard than the synchronous seams,
  which the async design warrants).
- **Soft failure, not cached.** On `LlmProviderException` or malformed JSON (retry once with a
  terse reminder, then give up), no chips are produced for that batch, nothing is cached, the
  failure is logged, and the next poll retries. The inbox is never affected — enrichment is off
  its critical path (§6).
- Token usage + interaction recorded via `ITokenUsageTracker` / `IAiInteractionLog` (component
  `"inbox-enrichment"`); recording is non-fatal. The audit log records no prompt/response content.

## 6. Asynchronous "pop-in" delivery

Enrichment must never block the inbox render, and chips must appear within roughly the LLM call
duration — not on the next poll cycle. (The default inbox poll interval is **120s**; inline-await
would extend `RefreshAsync` by the LLM latency under `_writerLock`, and "wait for next poll" would
mean up to a 2-minute stall. Async delivery is the correct call here, not gold-plating.)

1. `RefreshAsync` calls `EnrichAsync`, which returns **only already-cached enrichments,
   immediately**. Cold cache → empty map → inbox renders instantly, no chips.
2. The enricher kicks off a per-PR single-flight **background batch** for the misses (detached
   token, so it completes and warms the cache even if the user navigates away).
3. On completion the enricher publishes a new **`InboxEnrichmentsReady`** event on
   `IReviewEventBus` (it does *not* call the orchestrator — this breaks the dependency cycle, the
   same way the AI seams already subscribe to `ActivePrUpdated`).
4. The **orchestrator** subscribes to `InboxEnrichmentsReady` and owns the snapshot mutation:
   - acquires `_writerLock` (contends with the poller, never nests — no deadlock),
   - **re-reads `_current` inside the lock** (never mutates a stale captured snapshot),
   - **re-projects enrichments per-PR** from the enricher cache against `_current`'s *live* PR
     set (PRs removed since the batch started are simply not looked up; the chip lookup is
     `prId`-keyed and miss-tolerant) — this avoids the lost-update race where a background swap
     would clobber a fresher snapshot the poller just committed,
   - `Volatile.Write`s the new snapshot,
   - **publishes `InboxUpdated` unconditionally** for this path. The existing publish is gated on
     `ComputeDiff(...).Changed`, and `ComputeDiff` compares only HeadSha/CommentCount/Ci — it is
     blind to enrichment changes, so a diff-gated publish would never fire and chips would never
     appear. The enrichment-merge publish must bypass that gate.
5. Existing transport delivers it: `SseChannel` → inbox-updated SSE frame → `useInbox.reload()` →
   `GET /api/inbox` serves the updated cached snapshot → **chips appear within ~the LLM call
   duration.** (On an SSE reconnect the frame may be missed, but `reload()` then serves the merged
   snapshot, so the chip still appears — "~LLM duration" degrades to "next reload," not a loss.)

**Ownership (resolved, not deferred):** the **enricher** owns its cache, per-PR single-flight, and
the background batch, and publishes `InboxEnrichmentsReady`; the **orchestrator** owns only the
locked snapshot swap + `InboxUpdated`. This matches the ranker's cache-in-the-seam precedent and
keeps `_current` writes serialized in their single owner.

## 7. Gating and frontend

- Backend gate unchanged (`AiCapabilityResolver` already maps `inboxEnrichment`); the only new
  effect is that `realSeams` now holds a real implementation, so Live + consented resolves to it.
- Flip `LIVE_CAPABILITIES.inboxEnrichment: true` in `useCapabilities.ts`. The AI category chip
  render + `useAiGate('inboxEnrichment')` gate already exist; null `categoryChip` renders nothing.
- **"Draft" chip (non-AI).** Draft PRs render a static "Draft" chip in the same slot — derived
  from `IsDraft`, **no "AI" marker**, and **independent of AiMode** (shown even with AI fully
  off). Slot precedence: **Draft → AI category → nothing.** Drafts are never AI-enriched, so a
  draft never shows both.
- With the capability flag (or AiMode) off, AI category chips are hidden exactly as today; the
  Draft chip is unaffected (it is not an AI surface).

## 8. Testing

Backend (mirrors the file-focus ranker suite, `PRism.Web.Tests/Ai/`):
- Enum normalization: near-miss labels normalize; unknown / low-confidence → null chip (no "Other" pill).
- Cache keyed on title+description hash: same content → no second LLM call; a head-SHA move with
  unchanged title/description → **no re-enrich**; an edited description → re-enrich.
- Open + non-draft filter: merged/closed/draft items are excluded from the batch.
- Per-PR single-flight; a newly-arrived miss during an in-flight batch is enriched on the next batch.
- Malformed-JSON retry-once then soft-fail; provider exception → soft-fail, not cached, inbox unaffected.
- Consent revoked mid-flight → background task aborts before egress.
- Async path: `EnrichAsync` returns cached-only synchronously (non-blocking); background
  completion merges under `_writerLock` against a re-read `_current`, and publishes `InboxUpdated`
  **unconditionally** (test that an enrichment-only change still fires the event despite
  `ComputeDiff` being blind to it).
- Plumbing: `GitHubSectionQueryRunner` populates `Description`/`IsDraft` from `body`/`draft`,
  null-tolerant; `MaterializePrInboxItem` copies them.
- **Privacy regression:** the `/api/inbox` response JSON contains no PR `Description` text.

Frontend / e2e:
- Live mode mocked at the seam like other AI e2e specs; Preview placeholder chip already covered.
- Draft chip renders for draft PRs with AI off and on; no "AI" marker.
- Null category → no chip (no layout hole).
- **Zero new visual baselines for the AI chip** (render unchanged); the Draft chip is a new
  visual — confirm whether it needs a baseline or is covered by mocked-data row tests during impl.

## 9. Acceptance criteria (reconciled with decisions; backlog § P1-4)

- Every visible **open, non-draft** PR that the model can **confidently** categorize receives an
  AI category chip when AiMode = Live + consented; cold-cache PRs receive theirs asynchronously
  within ~the LLM call duration, not the poll interval.
- Low-confidence / un-normalizable results render **no chip** (not an "Other" pill).
- Categories adhere to the documented enum (internally; `Other` is the validation fallback that
  maps to no chip).
- Draft PRs render a non-AI "Draft" chip, spend **zero tokens**, and show no AI category.
- Closed/merged PRs are never enriched and never spend tokens.
- A new commit (head-SHA move) with unchanged title/description triggers **no** re-enrichment;
  steady-state polls make zero LLM calls. The cache is in-memory and re-enriches after a restart.
- Toggling the capability flag (or AiMode) off hides AI category chips and makes no LLM calls (the
  Draft chip is unaffected).
- Hover-preview summary is **not** delivered this slice (`HoverSummary` unused).
- **Quality check (manual):** the owner reviews a live inbox against the real token store and
  confirms the no-chip rate and any confidently-wrong categorizations are acceptable before the
  feature is treated as settled (coverage without a quality eyeball is the weak link of
  title+description-only categorization).

## 10. Deviations from backlog (recorded)

The backlog (`docs/backlog/02-P1-core-ai.md` § P1-4) is authoritative; these three deliberate
deviations are recorded here per the "backlog wins on conflict" rule:

1. **`Risky` dropped from the enum** (§3) — risk is an orthogonal axis and its own roadmap item
   (P2-10 / #420); mixing it into a kind-of-change enum is a category error.
2. **`file path list` + `line-count summary` inputs dropped** (§4) — file paths require a per-PR
   HTTP fetch this feature avoids; inputs are title + description only. Accepted accuracy cost.
3. **Hover summary deferred; "Other" not surfaced; chip suppressed on low confidence** (§3, §1) —
   the backlog's "hover summary within 200ms" AC referred to the (now-deferred) hover panel, not
   the chip; and a visible "Other" chip is replaced by no-chip to protect the AI marker's
   credibility.
