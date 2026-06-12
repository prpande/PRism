# v2 AI P1b — base-rebase freshness (cache `(prRef, baseSha, headSha)` + live eviction + stale-badge/Regenerate) — design

- **Roadmap:** [`docs/specs/2026-06-05-v2-ai-roadmap-design.md`](2026-06-05-v2-ai-roadmap-design.md) §3.1 (`(prRef, baseSha, headSha)` keying + write-after-evict; "add a base-SHA-change eviction trigger **or** document accepted staleness"), §6 (two-tier cache — *"freshness via invalidation, never by encoding mutable state in the key"*), §P1 (P1a/P1b split, exit, R2/R7). Builds directly on P1a [`docs/specs/2026-06-09-v2-ai-p1-first-light-design.md`](2026-06-09-v2-ai-p1-first-light-design.md) §4 (the in-memory summary cache this slice re-keys), §9 (the **R2** acceptance this slice closes), §12 (deferral list).
- **Issue-tracking home (authoritative backlog):** [`docs/backlog/01-P0-foundations.md`](../backlog/01-P0-foundations.md) §P0-2 (the real `IAiCache`) + [`docs/backlog/02-P1-core-ai.md`](../backlog/02-P1-core-ai.md) §P1-1 (summarizer cache). The backlog keys the cache on `head_sha` only and invalidates on the PR-changed event; **this slice is the `baseSha` refinement of that key** — the R2 gap a head-only key misses. The general key's `provider` + `sha256(prompt+model)` components and the file tier land with the real `IAiCache` in #397; the in-memory tier here needs no prompt-hash (a prompt-version change ships with a rebuild → restart → empty in-memory cache).
- **Date:** 2026-06-12
- **Tier / Risk:** T2 · **gated** — *UI-visual* (new in-card stale badge + Regenerate control) **and** *concurrency-surface* (base-change eviction on the synchronous event bus + R7 write-after-evict SHA compare-and-set). **No new egress** — the provider receives the same diff it already did (§11), so **no `DisclosureVersion` bump**. Retains the human spec/plan review gates.
- **Branch / Base:** `feat/v2-ai-p1b` → **`V2`** (never `main`).
- **Tracker:** #374 — adopted as a child of **P0-2 (#403, Real `IAiCache`)** in the AI roadmap epic #423 (`ai:foundation`). Sibling child: **#397** (file-backed `IAiCache` + per-PR context artifact + measured prompt-cache hit + identity-scoped cache invalidation — *optimization*, the measured-hit blocked on #379). The "P1b" name predates the epic; under the new structure this is the **base-sha cache-key child of P0-2** (the correctness half; #397 is the persistence/cost half).
- **Status:** Design (awaiting human spec review) · revised after `ce-doc-review` (1 pass, 7 personas).

> Section cross-references in this doc are to **this doc's** sections unless prefixed "roadmap §" or "P1a §".

> **Supersession note:** P1a §2 listed all deferred P1b items under one "P1b" bucket. This slice (P1b-1, #374) is the **correctness/functionality** subset; the **optimization** subset (file cache + context artifact + measured prompt-cache hit + identity-scoped invalidation) is split to **#397**. Where P1a §2 says "P1b," read "P1b-1 (#374) + #397."

---

## 1. Problem & context

P1a (First-Light) shipped the live PR summarizer with a per-process **in-memory** cache inside `ClaudeCodeSummarizer` — a `ConcurrentDictionary<string, PrSummary>` keyed `$"{pr.PrId}#{headSha}"`, i.e. `(prRef, headSha)`. This deliberately ignores **base-branch movement**: if a PR's base advances (the target branch gets new commits) while `headSha` is unchanged, the **diff changes** (a diff is a `(base, head)` pair — `DiffRangeRequest(baseSha, headSha)`) but the key does not, so a cached summary describes a **stale diff**. P1a accepted this as **R2 (base-rebase staleness, roadmap-rated High)** and filed this tracker (#374) as a blocking exit item (P1a §9, §12).

**This slice closes R2.** It re-keys the summary cache on `(prRef, baseSha, headSha)`, adds a **live base-change producer** so a base move is actually observed, evicts the stale entry via **event-bus invalidation**, guards the **write-after-evict race (R7)**, and surfaces a user-facing **stale badge + user-triggered Regenerate** on the summary card.

**The load-bearing finding (why this is more than "change the key").** `baseSha` is already in hand at the production `DiffResolver` (`ServiceCollectionExtensions.cs:93` reads `snapshot.Detail.Pr.BaseSha` to build the `DiffRangeRequest`) and is simply **discarded** before the cache key is built — so widening the key is ~4 lines. But that change is **inert on its own**. The `baseSha` it would key on comes from the `PrDetailLoader` snapshot, fed by `ActivePrPoller` via the cheap `PollActivePrAsync` — and **that poll never fetches `base.sha`** (`ActivePrPollSnapshot`, `ActivePrPollerState`, and `ActivePrUpdated` all carry head-SHA only). On a same-head rebase the snapshot keeps returning the **old** `baseSha`, so the re-keyed cache never sees a new key and never evicts. **The real R2 fix is a base-change *producer*** — teaching the poll/poller/event to detect and carry base movement — not the key change. That producer is a `PRism.Core` + `PRism.GitHub` change, and it is the bulk of this slice.

**What is NOT here (split to #397 as optimization).** The file-backed `<dataDir>/llm-cache` + restart survival, the formal `IAiCache` contract, the per-PR **context artifact**, the **measured prompt-cache hit** (blocked on #379), and **identity-scoped cache invalidation** are *optimizations / persistence concerns* — not the R2 correctness fix — and are moved to #397. R2 is an **in-session** staleness bug; an in-memory cache holds nothing across a process restart (the window is zero after restart), so keeping P1b-1 in-memory fully addresses R2 with no disk surface.

## 2. Scope & non-goals

**In scope (P1b-1):**

- **Backend — re-key.** `(prRef, headSha)` → `(prRef, baseSha, headSha)` in the existing **in-memory** cache (no `IAiCache`, no disk). Widen the `DiffResolver` tuple to surface the `baseSha` it already resolves; fold it into a structured cache key.
- **Backend — base-change producer (live detection).** Teach the GitHub cheap-poll adapter, `ActivePrPollSnapshot`, `ActivePrPollerState`, `ActivePrPoller` (including its **publish-gate condition**), and the active-PR `ActivePrSnapshot` to detect and carry base-SHA movement, and add `BaseShaChanged` + `NewBaseSha` to `ActivePrUpdated` (additive).
- **Backend — event-bus eviction.** `ClaudeCodeSummarizer` subscribes to `ActivePrUpdated` and evicts the PR's summary entries on `HeadShaChanged || BaseShaChanged` (with the quiet-first-poll hydration guard); `PrDetailLoader` extends its existing eviction to fire on `BaseShaChanged` too (so the refreshed `baseSha` propagates).
- **Backend — R7 write-after-evict.** Stamp each cache write with the `(baseSha, headSha)` it was generated for; **compare against the current active-PR snapshot's `(BaseSha, HeadSha)`** before storing; store only if both still match.
- **Backend — Regenerate endpoint.** `POST /api/pr/{owner}/{repo}/{number}/ai/summary/regenerate` — the identical gate chain (factored into a helper shared with the GET), evict-then-summarize, one deliberate re-spend.
- **Frontend — stale badge + Regenerate (Live only).** The new base-change signal rides the SSE `pr-updated` frame; `useActivePrUpdates` exposes it; `useAiSummary` derives `isStale` + `regenerate()`; `AiSummaryCard` renders a stale chip over the present body + a Regenerate control, with the staleness change and the regenerate result announced to assistive tech.

**Out of scope — deferred:**

- **#397 (optimization / persistence)** — formal `IAiCache` + file-backed `<dataDir>/llm-cache` + restart survival; the per-PR **context artifact**; the **measured prompt-cache hit** (blocked on #379); and **identity-scoped cache invalidation** (a persistent cache that survives restart genuinely needs an `IdentityChanged` wipe; the in-memory cache clears on restart, so P1b-1 inherits P1a's accepted in-memory behavior unchanged). `IAiCache` is **not** introduced here — per P1a §4 its shape is driven by the disk impl's needs, which arrive with #397; the in-memory cache gains eviction **in place**.
- **The disclosure-version 409 re-fetch / re-consent path** (P1a §7) — a consent-UX completeness item, unrelated to caching; tracked separately.
- **Differentiated stale-reason copy** ("base updated" vs "new commits") — the chip is a single generic "Out of date" label this slice (§8); head changes already have their own reload affordance (`BannerRefresh`), so the stale chip is effectively the base-change surface.

**Non-goals:**

- **Auto-regenerate.** Eviction never auto-calls the provider (§14). Roadmap §P1's "evicts **and regenerates**" is resolved as **user-triggered** Regenerate — consistent with the project's no-auto-retry / spend-only-while-viewing discipline.
- **Inbox classifier + cross-surface reconciliation** (roadmap §3.2) — P2.
- **Multi-provider; bounded LRU/TTL on the in-memory tier** (deferred to #397's cache); a permanent "revoke consent" action (P1a §5).

## 3. Architecture overview

The freshness loop (all keyed by `(prRef, baseSha, headSha)`; **freshness by invalidation, never mutable state in the key** — roadmap §6):

```
GitHub cheap poll (base.sha now read) ──► ActivePrPollSnapshot{ HeadSha, BaseSha, ... }
        │
ActivePrPoller: diff LastHeadSha / LastBaseSha (firstPoll hydrates, stays quiet);
                publish gate now includes baseChanged; writes BaseSha into the active-PR ActivePrSnapshot
        │ on a real change
        ▼
IReviewEventBus.Publish( ActivePrUpdated{ HeadShaChanged, NewHeadSha, BaseShaChanged, NewBaseSha, ... } )   // synchronous dispatch
        ├─► PrDetailLoader.OnActivePrUpdated  ─► evict snapshot (so fresh baseSha is re-fetched next load)
        ├─► ClaudeCodeSummarizer.OnActivePrUpdated ─► evict the PR's summary entries
        └─► SseChannel ─► SseEventProjection.ActivePrUpdatedWire ─► "pr-updated" frame (now carries baseShaChanged / newBaseSha)
                              │  (fire-and-forget, after Publish returns)
                              ▼
              useActivePrUpdates.baseShaChanged ──► useAiSummary.isStale
                              ▼
              AiSummaryCard: "Out of date" chip over the present body + "Regenerate" (Live only; NO auto-spend; aria-live announced)
                              │ user clicks
                              ▼
        POST .../ai/summary/regenerate ─► [Origin/session ─► D111 IsSubscribed ─► AiSeamSelector.Resolve<IPrSummarizer>] ─► evict + SummarizeAsync ─► 200 fresh PrSummary
```

The synchronous-`Publish` + fire-and-forget-SSE ordering guarantee (from #353) is inherited: the snapshot/summary evictions complete **before** `Publish` returns, ahead of the SSE frame the FE reacts to.

## 4. Backend — re-key + R7 write-after-evict

**Surface `baseSha` through the resolver.** Widen the `ClaudeCodeSummarizer.DiffResolver` delegate (`ClaudeCodeSummarizer.cs:23`) from `(string diff, string title, string description, string headSha)` to `(string diff, string title, string description, string baseSha, string headSha)`. The production closure (`ServiceCollectionExtensions.cs:97`) returns the `baseSha` it already reads on line 93. Two test stubs construct this delegate (`ClaudeCodeSummarizerTests.Build`, `AiSummaryGateTests` context) — both updated.

**Structured cache key.** Replace the string key `$"{pr.PrId}#{headSha}"` with a `readonly record struct SummaryCacheKey(PrReference PrRef, string BaseSha, string HeadSha)` — mirroring the existing `PrDetailLoader.DiffMemoKey(PrRef, BaseSha, HeadSha)`. This avoids the ambiguous-delimiter risk of appending a second `#` to a key that already contains `#` (from `PrId = "owner/repo#number"`). The cache becomes `ConcurrentDictionary<SummaryCacheKey, PrSummary>`. The category still rides inside the cached `PrSummary`, so a base **or** head change re-summarizes and re-categorizes together (P1a §4).

**R7 — write-after-evict, by SHA compare-and-set (not a generation counter).** P1a stores unconditionally (`_cache[key] = summary`). A head/base shift that lands **mid-call** (during the ~10s `CompleteAsync`) fires eviction (§6) for already-cached entries — but the **in-flight** call, which began before the shift, would then store its now-superseded result *after* that eviction, re-stranding a stale entry. Fix: the summarizer injects `IActivePrCache`; it stamps the intended write with the `(baseSha, headSha)` the call resolved at start, and immediately before the store re-reads the PR's **current** `ActivePrSnapshot.(BaseSha, HeadSha)` (§5 adds `BaseSha` to that snapshot) and stores **only if both still match**. A mid-call shift makes the snapshot's SHAs differ → the store is **skipped** (the result is for a superseded diff). This predicate rejects only *stale* writes — a fresh write whose SHAs are still current is always stored, so an unrelated concurrent eviction cannot drop a valid result (the rejected alternative, a per-PR generation counter, would drop valid concurrent writes and is therefore **not** used). The store remains **success-only** (provider exceptions propagate before the store — preserves P1a's "reopen to recover") and still precedes the best-effort token-tracking call (P1a ordering). Covered by a concurrency test (roadmap R7) asserting both: a stale write is rejected, and a valid write concurrent with an *unrelated* eviction is **not** dropped.

## 5. Backend — base-change producer (live detection)

This is the genuinely new machinery R2 requires (§1).

- **GitHub adapter.** `FetchPullJsonAsync` / `PollPullMeta` (`GitHubReviewService.cs`) parse `base.sha` from the REST `pulls/{n}` payload the cheap poll already makes (no extra request). Map it onto the poll snapshot.
  - **Required pre-implementation spike (blocking — was a soft open question).** Confirm REST `pulls/{n}.base.sha` reflects the **current base-branch tip** for an *open, unmerged* PR (not the base recorded at PR-open) on **both github.com and GHES**. There is suggestive-but-not-conclusive evidence it tracks the live tip on github.com (`GetDiffAsync` already couples GraphQL `baseRefOid` to REST `pull.BaseSha` for canonical-diff routing — `GitHubReviewService.cs:336`), but the producer's entire correctness rests on it, so it must be verified against a live rebased PR before the plan locks. **Committed fallback:** if REST `base.sha` is found to lag, the producer reads base-truth from GraphQL `baseRefOid` (the live tip the full-detail path already uses, `GitHubReviewService.cs:986`). A producer test asserts a base-tip move with unchanged head emits `BaseShaChanged` against a realistic fetch shape, not a fixture with a pre-set `BaseSha`.
- **`ActivePrPollSnapshot`** (`PRism.Core.Contracts`): add `BaseSha`.
- **`ActivePrPollerState`**: add `LastBaseSha`.
- **`ActivePrPoller`**: compute `baseChanged = state.LastBaseSha is not null && state.LastBaseSha != snapshot.BaseSha`, and **add `baseChanged` to the publish-gate condition** (currently `if (firstPoll || headChanged || commentChanged || stateChanged)` — `ActivePrPoller.cs:137`). Without this gate edit, a same-head base-only move trips none of the existing flags and the event is never published — the whole live path silently no-ops. The **firstPoll hydration** sets `LastBaseSha` **without** emitting `baseChanged` (mirrors the existing head/comment firstPoll discipline, `ActivePrPoller.cs:123-137`). Also write `snapshot.BaseSha` into the active-PR `ActivePrSnapshot` the poller maintains (so R7's compare-and-set has a current base, §4). Per-PR backoff unchanged.
- **`ActivePrSnapshot`** (the `IActivePrCache` per-PR snapshot, `HeadSha`-only today): add `BaseSha` (written by the poller; read by R7).
- **`ActivePrUpdated`** (`PRism.Core/Events`): add `BaseShaChanged` (bool) + `NewBaseSha` (string). Additive — existing consumers (`PrDetailLoader.OnActivePrUpdated`, `SseEventProjection`, tests) keep compiling.

## 6. Backend — event-bus eviction

Eviction is **invalidation**, not mutable-state-in-key (roadmap §6). Two subscribers:

- **`ClaudeCodeSummarizer` becomes a bus subscriber.** It injects `IReviewEventBus`, implements `IDisposable`, and in its constructor subscribes `Subscribe<ActivePrUpdated>(OnActivePrUpdated)` — `if (e.HeadShaChanged || e.BaseShaChanged) EvictForPr(e.PrRef)`, removing every `SummaryCacheKey` whose `PrRef == e.PrRef` (both base and head may move; evicting the PR wholesale is simplest and correct). The quiet first-poll event (neither flag set) does **not** evict — the same guard `PrDetailLoader.OnActivePrUpdated` (`PrDetailLoader.cs:103-110`) applies, or a just-cached summary is dropped on every page open. `Dispose()` releases the subscription. The summarizer is a singleton; the handler does **in-memory dictionary removal only** — cheap, safe on the synchronous bus (which runs handlers on the publisher's thread). *(Forward note: #397's file-backed eviction does disk I/O and must offload it off the publisher thread.)*
  - **No `IAiCache` extraction.** The cache stays a private field that gains eviction in place; the abstraction arrives with the disk impl in #397 (P1a §4 timing rationale).
- **`PrDetailLoader.OnActivePrUpdated`** extends its eviction predicate to also fire on `BaseShaChanged`. **Load-bearing:** without it the loader's snapshot keeps the old `baseSha`, so after the summarizer evicts, its `DiffResolver` re-resolves the **stale** `baseSha` from the still-cached snapshot and the "fresh" summary is regenerated against the old base. Evicting the snapshot forces the next load to re-fetch and surface the new `baseSha`.

## 7. Backend — Regenerate endpoint

`POST /api/pr/{owner}/{repo}/{number}/ai/summary/regenerate`, under the existing `/api/*` pipeline (`SessionTokenMiddleware` + `OriginCheckMiddleware` — POST is CSRF-covered).

- **Identical gate chain to GET `/ai/summary`** (P1a §6): D111 `if (!cache.IsSubscribed(prRef)) return NoContent();` → `ai.Resolve<IPrSummarizer>()` (Off/Preview ⇒ Noop/Placeholder ⇒ no real spend; Live ⇒ requires consent + `userEnabled("summary")`). **No bypass.** The gate + summarize core is factored into a shared helper with the GET handler; §12 includes a test that exercises the **helper directly** with the gate-closed fixtures so parity is structurally verified, not just asserted per-route.
- **Behavior:** evict the `(prRef, baseSha, headSha)` entry, then `SummarizeAsync` → **200** fresh `PrSummary`; **503** on provider failure (propagates `LlmProviderException`, **not cached**); **204** when the gate is closed.
- **Why POST, not a `?force` GET:** spending tokens is a state-changing side effect; POST gets `OriginCheckMiddleware` CSRF coverage and is never triggered by prefetch/proxies. (The GET already spends-on-miss for the **initial** load; Regenerate is a distinct **deliberate** re-spend.)
- **Token record:** records `TokenUsageRecord` with `IsRetry: true` — re-spend amplification visibility (semantic: a deliberate re-spend, not a failure-retry).

## 8. Frontend — stale badge + Regenerate (Live only)

- **SSE wire.** Add `BaseShaChanged` / `NewBaseSha` to `SseEventProjection.ActivePrUpdatedWire` (`PRism.Web/Sse/SseEventProjection.cs`) **and its `Project` construction** — *not* `SseChannel` directly. The projection is the documented single source of truth for the `pr-updated` frame shape (a prior bug shipped from serializing the raw event record); editing only `SseChannel`/the event would leave the new fields off the wire and the live signal silently absent.
- **`useActivePrUpdates`.** Expose `baseShaChanged` (latched like the existing `headShaChanged`).
- **`useAiSummary` signature + wiring.** The hook gains `isStale` + `regenerate()`. Its current signature is `useAiSummary(prRef, enabled, subscribed)` and its only caller `OverviewTab` does not call `useActivePrUpdates` (that hook lives in the parent `PrDetailView`). Wire it by having `OverviewTab` pass `baseShaChanged` down — either by `OverviewTab` calling `useActivePrUpdates(prRef)` itself, or `PrDetailView` threading `baseShaChanged` as a prop (the plan picks one; the hook signature becomes `useAiSummary(prRef, enabled, subscribed, baseShaChanged)`).
  - **`isStale = baseShaChanged`** — driven solely by the live SSE base-change signal. SHAs stay **out** of the fetch effect deps — a base move must NOT auto-refetch (token discipline); `regenerate()` is the only re-fetch trigger. `isStale` **resets** on a fresh successful fetch/regenerate (the new summary is current by construction). *(The earlier wire-echo SHA-compare backstop was dropped after review: the poller's per-PR state persists across an SSE disconnect, so on reconnect the next poll re-detects a missed base move and re-fires `baseShaChanged` — the echo added cross-tier surface for a case the SSE path already self-heals. The residual window is the poll-latency bound documented in §10.)*
  - `regenerate()` POSTs the regenerate route, **disables immediately** (optimistic, to prevent a double-spend on a fast double-click), sets a regenerating flag, replaces `summary` on 200, and on 503 keeps the present body (see the failure state in §9); gated on `enabled && subscribed`.
- **`AiSummaryCard`.** Staleness is a **fourth** state layered on a **present** summary (the chip coexists with the rendered body, unlike loading/error which replace content). When `isStale` **and Live**: render the existing body + a `chip chip-status-stale` chip labelled **"Out of date"** (mirror `StaleDraftRow`) in the dormant `.aiSummaryHead` header slot + a **Regenerate** control (mirror `RefreshButton`: spinner + disabled while in flight; accessible name **"Regenerate summary"** — deliberately not matching `/retry/i`, so it does not regress the P1a error-branch test).
  - **Accessibility.** The `.aiSummaryHead` slot is a `role="status"` / `aria-live="polite"` region: the chip's dynamic insertion (from an SSE event arriving while the user views the card) is announced, and on a successful Regenerate the region announces the update (e.g. "Summary updated") then clears the stale state. (This is the host-status-region pattern `RefreshButton` already relies on — the card owns the region.)
  - **Preview** shows the sample summary + `SampleBadge` as today — **no** stale chip or Regenerate (sample data has no real staleness). **Off** hides the card. Entering Live triggers a fresh fetch whose result is current, so the card opens **not** stale regardless of any prior `baseShaChanged`.
  - The **error** state (initial-load 503) keeps P1a's no-retry / "reopen this PR" UX unchanged. The **regenerate-failure** state is distinct (§9).
- **`aiSummary` api.** Add `regenerateAiSummary(prRef)` → POST the regenerate route, mapping 200→ok / 503→error / 204→absent.

## 9. Data flow (reachable states)

| State | Card render |
|---|---|
| Live, fresh | body + category chip, no stale chip |
| Live, stale (base moved, not yet regenerated) | body + **"Out of date"** chip (announced) + **Regenerate** (no auto-spend) |
| Live, regenerating | Regenerate disabled + spinner; **stale body + chip retained** during the ~10s call |
| Live, **stale + regenerate failed (503)** | **stale body + chip retained**; transient inline "Couldn't regenerate" status (announced); **Regenerate re-enabled** for a deliberate retry (single click, non-spammable) |
| Live, **initial-load failure (503)** | inline no-retry error ("reopen this PR") — unchanged from P1a (no body to retain) |
| Preview | sample body + `SampleBadge` (no stale/Regenerate) |
| Off / not-subscribed / unconsented / feature-off | hidden (204) |

The regenerate-failure row is deliberately distinct from initial-load failure: a regenerate failure must **not** destroy the only content the user has (the stale body), so it retains the body + chip and re-enables the control, rather than collapsing into the bodiless P1a error card.

## 10. Error handling & accepted limitations

- **Regenerate provider failure** (gate open) ⇒ `LlmProviderException` ⇒ **503** ⇒ retain the stale body + chip + transient error (§9); **not cached** (a subsequent deliberate Regenerate re-calls).
- **Staleness-detection latency (accepted, bounded).** A base move is invisible — stale summary served, no chip — until the next successful poll tick observes it: up to the ~30s poll cadence, and up to the 300s per-PR backoff ceiling for a PR currently in error backoff. This is inherent to poll-based detection; the §13 "no stale serve" criterion is therefore *"after the producer observes the base move,"* not instantaneous.
- **SSE disconnect during a base move (accepted, self-healing).** The poller's per-PR `_state` (incl. `LastBaseSha`) is not cleared on unsubscribe, so on reconnect/resubscribe the next poll compares against the retained `LastBaseSha` and re-fires `baseShaChanged`. The window is the same poll-latency bound above.
- **Quiet first-poll hydration must not evict** — guarded in both subscribers (§6), or a freshly-subscribed PR drops its just-cached summary and re-spends.
- **Eviction handler runs on the synchronous bus / publisher thread** — in-memory dict removal only; cheap. (Disk-eviction offload is #397's concern.)
- **Per-poll cost of reading `base.sha`** — negligible (field already in the existing REST poll response; no extra request).
- **In-memory cache remains unbounded** (P1a limitation) and **clears on restart** — acceptable: R2 is in-session; a bounded LRU/TTL ships with #397's cache.
- **Identity change (accepted, unchanged from P1a).** The in-memory summary cache is not wiped on account swap; a summary computed under a prior login can be served within the same process session. This is pre-existing P1a behavior (the in-memory cache clears on restart). Identity-scoped invalidation lands with #397's **persistent** cache, where it is genuinely required.
- **Accepted (unchanged from P1a §9):** consent-revocation TOCTOU one-call window; file-crafted consent record under the local-desktop threat model; 204-vs-503 side-channel; ~10s latency / no streaming.

## 11. Security & egress

- **No new egress; no `DisclosureVersion` bump.** The provider receives the **same** diff (`base..head`) it received in P1a; the diff *content* changes on a rebase but stays the same data **category** (a diff). `baseSha` is used only as a cache key / eviction signal — it is never added to the prompt sent to Anthropic (the assembled `userContent` is diff/title/description, `ClaudeCodeSummarizer.cs:67-70`). The P1a §5 change-control rule ("a PR that changes *what leaves the device* MUST bump `DisclosureVersion`") is satisfied with **no bump** because `dataCategories = [diff, title, description]` is unchanged.
- **Egress guard test (structural, not just snapshot).** §12 asserts the assembled provider prompt and `dataCategories` are identical to P1a, **and** asserts the prompt is built from an explicit field allowlist (`{diff, title, description}`) so a future PR that adds a field to the prompt must edit a visible, diff-searchable constant — converting the prose change-control rule into a code-level trip-wire against silently widening egress.
- **Regenerate respects the full gate chain** (Origin/session → D111 `IsSubscribed` → seam) — no bypass; the shared helper is exercised directly in tests (§7, §12). CSRF: POST under `OriginCheckMiddleware`.
- **Audit.** Eviction/regenerate outcomes remain auditable via the existing `AiInteractionRecord` (Ok / CacheHit / ProviderError, headSha, metadata-only); no prompt/response content logged (P1a §9). *(Extending the record with `baseSha` for `(base,head)` correlation is deferred to #397, where its consumer — the measured prompt-cache hit — lives.)*

## 12. Testing strategy

**Backend (xUnit + FluentAssertions, `PRismWebApplicationFactory`; `-p:NuGetAudit=false`; `.runsettings` `Category!=Integration`):**

- **Re-key** (`ClaudeCodeSummarizerTests`, extend the `DiffResolver` tuple + `AiSummaryGateTests` stub): same `headSha` + **different `baseSha` ⇒ MISS** (2 provider calls); same `(baseSha, headSha)` ⇒ **HIT** (1 call, 0 provider calls).
- **Eviction** — requires a **dispatching** `FakeReviewEventBus` (the existing fakes return a `NullDisposable` and never invoke handlers — insufficient; the upgrade is scoped to the new eviction tests, audit existing `FakeReviewEventBus` users for behavioral impact): `ActivePrUpdated(BaseShaChanged)` ⇒ the PR's summary entry evicted; `ActivePrUpdated(HeadShaChanged)` ⇒ evicted; the quiet first-poll event ⇒ **not** evicted.
- **R7** — a store whose stamped `(baseSha, headSha)` no longer matches the current `ActivePrSnapshot` ⇒ **not stored**; a valid store concurrent with an **unrelated** eviction ⇒ **stored** (the generation-counter regression the SHA-compare avoids) — concurrency test, roadmap R7.
- **Producer** — `ActivePrPoller` emits `BaseShaChanged` on a base move (`LastBaseSha` set) **and the publish gate fires** (a same-head base-only move is published, not swallowed); **suppresses** it on firstPoll hydration; `ActivePrPollSnapshot` + `ActivePrSnapshot` carry `BaseSha`; the GitHub adapter parses `base.sha` (and the spike's realistic-fetch producer test, §5).
- **`PrDetailLoader`** evicts its snapshot on `BaseShaChanged` (so the fresh `baseSha` propagates on next load).
- **Regenerate endpoint** — **204** not-subscribed; **204** Off / unconsented / `userEnabled("summary")=false`; **200** evict + fresh on Live+consent+subscribed (provider call count **1**, vs a cached GET's **0**); **503** on provider failure (not cached); **401** no session; **403** missing Origin (POST); `IsRetry:true` recorded. Plus a **shared-helper parity test** calling the gate helper directly with the gate-closed fixtures (§7).
- **No-egress guard** — the assembled provider prompt + `dataCategories` are identical to P1a, **and** the prompt-field allowlist constant is `{diff, title, description}` (§11).

**Frontend (Vitest + RTL — update BOTH the co-located `src/**/*.test.tsx` AND the legacy `frontend/__tests__/` mirror for `useAiSummary` and `AiSummaryCard`; `aiSummary` api is co-located-only):**

- **`useActivePrUpdates`** — exposes `baseShaChanged` from the `pr-updated` frame.
- **`useAiSummary`** — `isStale` flips on `baseShaChanged` and **resets** on a fresh fetch/regenerate; SHAs are **not** in the fetch deps (assert **no** extra GET fires on a SHA/base-change event — token discipline); `regenerate()` POSTs, disables immediately, replaces on 200, retains body on 503, gated on `subscribed`.
- **`AiSummaryCard`** — Live + stale ⇒ "Out of date" chip + Regenerate **over a present body**, chip in a `role=status` region (announced); regenerating ⇒ stale body + chip retained, control disabled + spinner; **regenerate 503 ⇒ stale body + chip retained, control re-enabled, transient error announced**; Live + fresh ⇒ no chip; **Preview ⇒ SampleBadge, no stale/Regenerate**; initial-load error unchanged (still **no `/retry/i`**).
- **`aiSummary` api** — `regenerateAiSummary` POSTs the regenerate route; 200→ok / 503→error / 204→absent.

**e2e (Playwright):** base-change stale path — load a Live summary → emit `pr-updated{baseShaChanged}` → "Out of date" chip appears → click Regenerate → fresh summary, chip clears. **Linux visual baselines** regenerated for the new stale-chip + Regenerate card states.

## 13. Exit criteria

**P1b-1 (this slice — closes R2):**

- Same head + moved base ⇒ cache **MISS** (no stale serve) **once the producer observes the move** (bounded by the §10 poll-latency window); provider call count **1** on the fresh/regenerate path, **0** on a genuine `(base, head)` hit.
- Live base move while viewing ⇒ `pr-updated{baseShaChanged}` ⇒ **"Out of date" chip** appears over the present summary, announced to AT, with **zero provider calls** until the user clicks Regenerate (no auto-spend).
- A same-head base-only move is **published** by the poller (publish-gate includes `baseChanged`) and reaches the FE via the `SseEventProjection` wire.
- Regenerate ⇒ exactly **one** gated re-spend; on 503 the stale body is retained and the control re-enables; not cached.
- **R7:** a head/base shift mid-call leaves **no** stale entry (SHA compare-and-set rejects the superseded write) **and** does not drop a valid write racing an unrelated eviction.
- Quiet first-poll hydration does **not** evict a just-cached summary.
- **No new egress / no `DisclosureVersion` bump** — egress set asserted identical to P1a, behind a prompt-field allowlist trip-wire.
- The REST `base.sha` freshness spike (§5) is resolved (verified or fallback committed) before implementation locks.
- Both FE test trees updated; Linux visual baselines regenerated for the new card states.

**Governance boundary:** #374 is closed by this slice, but **this slice does NOT clear the P1→P2 gate.** That gate's prompt-cache measurement lives in **#397** (blocked on #379), alongside the dogfood / external-N / eval-golden-set criteria (roadmap §8, §P1).

## 14. Resolved decisions (2026-06-12)

- **Live base-change producer chosen** over the minimal on-interaction floor. The two options weighed: **(A)** re-key + flag-on-detail-load only (no poller/SSE producer), and **(B)** the live producer (poll/poller/event detect the base move and push it via SSE). Roadmap §3.1 *permits* either ("add a base-SHA-change eviction trigger **or** document accepted staleness") and §P1 says "evicts/flags" — so (B) is the chosen design, not a strict mandate. (B) is chosen for the **live** stale signal (the chip appears while the card is open, within the poll-latency bound) rather than only on the user's next interaction; the cost is the `PRism.Core` + `PRism.GitHub` producer surface. The product owner accepts that cost for the live behavior.
- **No auto-spend on eviction.** Roadmap §P1's "evicts and regenerates" is resolved in favor of the project's no-auto-retry / spend-only-while-viewing discipline: eviction marks the summary **stale**; the **user** triggers Regenerate.
- **Wire-echo backstop dropped (post-review).** An earlier draft echoed the generating `(baseSha, headSha)` to the FE for a SHA-compare backstop. Review showed it (a) was redundant — the poller's persisted per-PR state self-heals a missed base move on SSE reconnect — and (b) had an idle-viewer hole. Dropped; `isStale` is driven by the SSE signal alone, with the poll-latency window documented (§10) as the accepted bound.
- **Identity-scoped invalidation deferred to #397 (post-review).** An earlier draft added an `IdentityChanged` cache wipe; review flagged it as orthogonal to R2 and as introducing a store-after-wipe race. The in-memory cache clears on restart (pre-existing P1a behavior), so the wipe is deferred to #397's persistent cache where it is genuinely required.
- **Audit-log `baseSha` deferred to #397 (post-review)** — its only consumer (cache-hit correlation) lives there.
- **R7 by SHA compare-and-set, not a generation counter (post-review)** — a generation counter would drop valid writes racing an unrelated eviction; the SHA compare-and-set rejects only genuinely-stale writes.
- **Stale badge + Regenerate are Live-only** (staleness is moot for Preview sample data); chip copy is a generic **"Out of date"** (differentiated base-vs-head copy deferred — head changes have their own `BannerRefresh` reload path).
- **Regenerate is `POST .../ai/summary/regenerate`** (state-changing re-spend, CSRF-covered, shared gate helper), recorded `IsRetry:true`.
- **REST `base.sha` freshness is a required pre-implementation spike** with a committed GraphQL `baseRefOid` fallback (§5) — it is the producer's load-bearing assumption.
- **No `DisclosureVersion` bump** — the data sent to the provider is unchanged; `baseSha` is keying/eviction metadata, never provider input. Guarded by a prompt-field allowlist trip-wire.
- **The 409 disclosure re-consent path stays out** of P1b-1 (consent-UX, unrelated to caching; tracked separately).
