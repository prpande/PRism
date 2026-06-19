# AI Usage & Spend Tracker — Design (#517)

- **Issue:** #517 — User-facing AI usage & spend tracker (aggregate by feature and by PR)
- **Branch:** V2 (part of the V2 AI roadmap, epic #423)
- **Status:** Design — awaiting human review before writing-plans
- **Depends on:** #379 (cache-creation token accounting) — **resolved**, shipped to V2 (`1a3a7fe7`). The displayed numbers are now trustworthy.

## 1. Problem

PRism records detailed per-call AI usage (tokens + an estimated cost) durably, but there is **no user-facing way to see it** and **no read side at all** — both usage logs are write-only today. Users can't tell what AI features are costing them against their Claude subscription, which feature is the heaviest, or whether the prompt cache is actually saving anything.

This feature adds (a) a durable, rotation-resilient usage rollup, (b) a read endpoint over it, and (c) a usage dashboard nested under AI Settings.

## 2. What already exists (substrate)

Per-call usage is recorded by every AI seam to **two** durable JSONL logs:

| Log | Contract | Path | Carries |
|-----|----------|------|---------|
| `token-usage.jsonl` | `TokenUsageRecord` | `{dataDir}/llm-usage/` | `Feature`, `ProviderId`, token counts, `EstimatedCostUsd`, **`IsRetry`**, `RecordedAt` |
| `ai-interactions.log` | `AiInteractionRecord` | `{LogsPathInfo.Path}` | `Component`, `ProviderId`, `Model`, **`PrRef`**, `HeadSha`, **`Outcome`** (`Ok`/`CacheHit`/`ProviderError`/`Fallback`), `Egressed`, `LatencyMs`, token counts, `EstimatedCostUsd`, char counts, `ErrorType`, leading `timestamp` |

Key facts that drive the design (verified in code, not assumed):

- **`ai-interactions.log` is a strict superset of `token-usage.jsonl` for display.** It has everything the token log has (tokens, cost, feature-via-`Component`) **plus** `PrRef`, `Outcome` (including `CacheHit`), latency, and model. The **only** thing it lacks is the explicit `IsRetry` boolean.
- **Every provider call — including each retry — is its own `Ok` `AiInteractionRecord`** with full tokens + cost (`ClaudeCodeFileFocusRanker.cs:213-220`, mirrored in the summarizer). So retry *cost* is fully captured in `ai-interactions.log`; it is simply not *labeled* as a retry there.
- **Cache hits and provider errors exist only in `ai-interactions.log`** — a `CacheHit` egresses nothing, so no `TokenUsageRecord` is written for it. Cache savings are therefore only derivable from `ai-interactions.log`.
- **`CacheHit` records are emitted by 3 of the 4 seams, NOT all four.** Summary, file-focus ranker, and hunk-annotator each record a `CacheHit` `AiInteractionRecord` on their cache-hit path; the **inbox enricher does not** (`ClaudeCodeInboxItemEnricher.cs` returns cached results without recording anything). So the cache hit-rate (decision §4.5) covers `summary` + `fileFocus` + `hunkAnnotations` and **silently omits inbox-enrichment cache hits** until that gap is closed (see §9 — candidate follow-up).
- **Cost is pre-computed by the Claude CLI** (`total_cost_usd` → `LlmResult.EstimatedCostUsd`). There is no rate card in code, so the "configurable rate card" question is moot — we surface the CLI's estimate verbatim.
- **No read side, no aggregation, no budget logic exists today.**

### Seam → component naming

| Seam | `Component` (audit) | `Feature` (token log) | Display name |
|------|---------------------|------------------------|--------------|
| PR Summary | `summary` | `pr-summary` | PR Summary |
| File Focus Ranker | `fileFocus` | `pr-file-focus` | File Focus |
| Hunk Annotator | `hunkAnnotations` | `pr-hunk-annotations` | Hunk Annotations |
| Inbox Enrichment | `inboxEnrichment` | `inbox-enrichment` | Inbox Enrichment |

The inbox enricher logs `PrRef = "batch"`, `HeadSha = null` (it enriches several PRs in one provider call).

## 3. Decisions (resolved during brainstorming)

1. **Single source of truth for display:** `ai-interactions.log` (`AiInteractionRecord`). No two-file join — the files share no key, and the token log can't do by-PR or cache savings.
2. **Primary lens:** headline total + trend, and a **by-feature** breakdown. **By-PR** and **cache savings** are secondary drill-downs. (By-PR is the noisiest pivot — unbounded `PrRef` cardinality.)
3. **Retries: surface-only.** Retry *cost* is counted in all totals (the extra `Ok` records are present); we do **not** break out a labeled "retries" line. Adding `IsRetry` to `AiInteractionRecord` for clean labeling is deferred to a follow-up.
4. **Windows:** rolling **24h** / **7d** / **30d** / **All**, default **7d**. 24h is a true rolling window (hour-aligned), not a UTC calendar day — a UTC "Today" is misleading across timezones.
5. **Granularity:** aggregates only. **No per-call list** (that's the audit log's job; the issue flags it as the noise risk).
6. **Cost framing:** *"estimated equivalent cost (rate-card)"* — never "spent." The headline provider is a **subscription**; the dollar figure is a provider estimate, not a literal charge and not the user's subscription-limit consumption.
7. **Durable rollup is the read source — not a per-request log scan.** `ai-interactions.log` is **append-only and grows without bound** (no rotation/size cap exists in the code today — only the separate *app* log rotates). The justification for a durable rollup is therefore the **unbounded-growth scan cost**, not rotation: re-scanning an ever-growing log on every pane open is wasteful. The rollup is maintained by a **periodic byte-offset log-tailer** (§4), fully decoupled from the AI record path. (Revises both the initial "scan per request" sketch and an interim "write-through decorator" sketch — the latter was unsound: see §4.2.)
8. **IA:** the usage dashboard is a **child** of the AI settings nav item, not a new top-level tab and not appended into the config pane.
9. **Endpoint is not gated on current AI mode.** Past usage is worth showing even when AI is currently Off — a deliberate divergence from the sibling AI endpoints' "204 when not subscribed" behavior.

## 4. Architecture

```
AI seams ──record──► IAiInteractionLog ──► JsonlAiInteractionLog (appends ai-interactions.log)   [UNCHANGED — not decorated]

(background, periodic — fully decoupled from the AI record path)
AiUsageRollupTailer (IHostedService timer)
   │  reads new lines from the persisted byte-offset
   └──► AiInteractionLogReader  ──folds (timestamp, record)──►  AiUsageRollupStore (in-memory buckets + checkpoint)
                                                                      │  atomically persists buckets + offset together
                                                                      ▼
                                                           {dataDir}/llm-usage/usage-rollup.json   [authoritative read source]

GET /api/ai/usage?window=  ──► AiUsageAggregator(rollup buckets, window) ──► AiUsageReport DTO ──► AiUsagePane
```

**Why a tailer, not a write-through decorator.** An interim sketch decorated `IAiInteractionLog` to fold each record into the rollup in-memory, with a periodic flush + a timestamp-based startup reconcile. That was unsound: `IAiInteractionLog.Record(record)` carries **no** timestamp (`JsonlAiInteractionLog` generates its own with `_clock.GetUtcNow()` at write time), so the rollup's "last seen" value and the log line's `timestamp` were **two independent clock reads** — a `timestamp > lastSeen` reconcile then drops or double-counts. Same-instant records (retries microseconds apart, concurrent seams, the inbox batch) share an `"O"`-format timestamp with **no tie-breaker**, so neither `>` nor `>=` is correct. And the flush could observe a torn read of the in-memory dictionary. The tailer below dissolves all of these: the cursor is a **byte offset** (exact, no clock dependency, no ties), there is a **single writer** (the timer — no concurrent fold from request threads), and the AI record path is **untouched** (no fold can ever affect an AI call). The cost is bounded staleness: the dashboard reflects usage up to the last tail tick (≤ the tail interval).

### 4.1 `AiUsageRollupStore` (durable rollup — the read source)

- **Persisted file:** `{dataDir}/llm-usage/usage-rollup.json`, holding `{ buckets[], tailOffset, sourceLength }`. Created with the **same owner-restricted permissions** `JsonlTokenUsageTracker` applies to `token-usage.jsonl` (explicit owner-only chmod on POSIX; owner-restricted dir ACL on Windows) — set explicitly on create, not assumed from directory inheritance.
- **Atomic persist:** write to a temp file, then rename over `usage-rollup.json`, so buckets and `tailOffset` are always mutually consistent on disk. The offset advances **only** as part of a successful persist, so a crash between fold and persist simply re-reads those lines next tick (no double-count, no loss).
- **Grain:** one bucket per **(UTC-hour, `Component`, `PrRef`)**. Hour-grain is what makes a true rolling-24h window possible; every coarser pivot (by-feature, by-PR, daily/weekly trend, 7d/30d/All windows) derives by summing buckets. (Bucket-count growth and a future compaction option: see §9.)
- **Bucket fields:** `InputTokens`, `OutputTokens`, `CacheReadInputTokens`, `CacheCreationInputTokens` (sums), `EstimatedCostUsd` (sum), `ProviderCalls` (count of `Outcome ∈ {Ok, ProviderError}`), `CacheHits` (count of `Outcome == CacheHit`).
- **Metrics definition (count by `Outcome`, NOT by `Egressed` — `Egressed` is unreliable here):**
  - `ProviderCalls` = `count(Outcome == Ok) + count(Outcome == ProviderError)` — the actual provider invocations (a thrown call records `ProviderError` and does *not* also record an `Ok`). **Includes retries**, since each parse-failed attempt records its own `Ok`.
  - `CacheHits` = `count(Outcome == CacheHit)` (no egress, no cost). Covers 3 of 4 seams (§2 — inbox enrichment omitted).
  - **`Fallback` is excluded from `ProviderCalls`.** Critical subtlety: a seam may emit a synthetic `Fallback` record **with `Egressed: true`** *in addition to* the failed attempts' `Ok` records — the file-focus ranker does exactly this (`ClaudeCodeFileFocusRanker.cs:158-160`), so a fallback scenario is 2 `Ok` + 1 `Fallback`. Counting by `Egressed == true` would treat that as 3 provider calls; counting by `Outcome` correctly yields 2. (Only the ranker emits `Fallback` today, but the by-`Outcome` rule stays correct for any future seam that does.) `Fallback` carries no cost (cost already came from the `Ok` attempts) and is bucketed for durability but contributes 0 to cost and is not a provider call.
  - Cost/token sums coalesce nulls to 0 (only `Ok` records carry them; `ProviderError`/`Fallback`/`CacheHit` carry nulls → 0).

### 4.2 `AiUsageRollupTailer` (`IHostedService`, timer; structure mirrors `AiSeamWarmup`)

- **`StartAsync`:** load `usage-rollup.json` (buckets + `tailOffset` + `sourceLength`); start the periodic timer. Startup does **not** block on backfill — the first tick does it in the background, so the host starts immediately even when the historical log is large. The endpoint serves whatever the rollup holds (empty until the first tick completes on first ship).
- **Each tick:** open `ai-interactions.log`, seek to `tailOffset`, read forward fold-ing each complete line via `AiInteractionLogReader`; advance the in-memory offset to the end of the last **complete** line (a partial trailing line mid-write is left for the next tick); then atomically persist (§4.1) **only when dirty**.
- **Truncation / shrink detection (this replaces "rotation handling"):** if the current file length `< tailOffset` (the log was truncated, replaced, or — if rotation is ever added — rolled over), reset `tailOffset = 0` and **rebuild from scratch**, logging a warning. There is no silent gap: either we tail forward from a valid offset, or we detect the shrink and rebuild the whole rollup. (`ai-interactions.log` does not rotate today; this guard is a cheap, correct safety net, not machinery for a current event.)
- **Tail interval:** **60 s** (constant; not user-configurable in V1). This bounds dashboard staleness to ≤ 60 s.
- **`StopAsync`:** one final tick (tail + persist) so a graceful shutdown leaves the rollup current.
- **Corruption handling:** if `usage-rollup.json` is missing or unparseable on load, start with an empty store at `tailOffset = 0` → the first tick is a full rebuild.

### 4.3 `AiInteractionLogReader`

- Reads `ai-interactions.log` lines starting at a given **byte offset**, yielding `(DateTimeOffset Timestamp, AiInteractionRecord Record)` plus the **new byte offset** (end of the last complete line consumed), using the **same `JsonSerializerOptions`** `JsonlAiInteractionLog` writes with (camelCase + enum converter).
- Each line is parsed as a `JsonNode`: pull the leading `timestamp` property (injected at write-time, not a field on the record), then deserialize the remainder into `AiInteractionRecord` (STJ skips the unmapped `timestamp` by default). The `timestamp` is used for **bucketing only** — never as a reconcile cursor (the offset is the cursor).
- **Malformed/partial lines are skipped without advancing past them** — a half-written trailing line from an in-flight append, or a future added field, must not break the read or corrupt the offset.
- Used by the tailer every tick; no other consumer.

### 4.4 `AiUsageAggregator`

- Pure function: `(IEnumerable<bucket>, window, now) → AiUsageReport`. No I/O; trivially unit-testable.
- Filters buckets to the window (24h = `bucketHour >= now - 24h`; 7d/30d = trailing N days; All = no filter), then:
  - **Totals:** summed tokens (all four kinds), summed est. cost, total `ProviderCalls`, total `CacheHits`.
  - **ByFeature:** group by `Component` → display name; sorted by est. cost desc. Unknown components pass through with their raw name (forward-compatible).
  - **ByPr:** group by `PrRef`; sorted by est. cost desc; capped at the **top 20 by cost** for the window (with the total PR count returned so the UI can show "+N more"); the `"batch"` row (rendered "Inbox (batched)") is always included when present, even past the cap.
  - **Cache:** `CacheHits`, `ProviderCalls`, and a hit-rate = `CacheHits / (CacheHits + ProviderCalls)` (0 when denominator is 0). Denominator note: `ProviderCalls` includes `ProviderError` (failed-but-attempted calls), so the rate reads as "cache-served ÷ total provider attempts."
  - **Trend:** time buckets across the window — **hourly** for 24h, **daily** for 7d / 30d / All, switching to **weekly** for All when the span exceeds 90 days (caps the bar count).

### 4.5 Endpoint — `GET /api/ai/usage?window=7d`

- Registered in `AiEndpoints.MapAi`. Auth is the **global `SessionTokenMiddleware`** (verified: sibling AI endpoints carry no per-route auth attribute — they rely on the same middleware pipeline), so a non-PR-scoped route under `/api/` inherits session enforcement automatically.
- `window` validated against `{24h, 7d, 30d, all}`; missing/invalid → default `7d`.
- Always returns **`200 AiUsageReport`** (an empty report — zeros and empty arrays — when no usage has been recorded, including when the first tail tick hasn't completed yet). **Not** gated on AI mode (decision 9).
- Reads the in-memory `AiUsageRollupStore` via the aggregator. No log I/O on the request path.

### 4.6 DTO

```csharp
public sealed record AiUsageReport(
    string Window,                       // echoes "24h" | "7d" | "30d" | "all"
    DateTimeOffset GeneratedAt,
    AiUsageTotals Totals,
    IReadOnlyList<AiUsageFeatureRow> ByFeature,
    IReadOnlyList<AiUsagePrRow> ByPr,    // top 20 by cost (+ "batch" always); see TotalPrCount
    int TotalPrCount,                    // total distinct PrRefs in window (for "+N more")
    AiCacheStats Cache,
    IReadOnlyList<AiUsageTrendBucket> Trend);

public sealed record AiUsageTotals(
    long InputTokens, long OutputTokens, long CacheReadInputTokens,
    long CacheCreationInputTokens,
    // TotalTokens = sum of all four (incl. cache-creation) = total provider activity for the window;
    // cache-read/creation are also broken out so the cache stat can be read against the headline.
    long TotalTokens,
    decimal EstimatedCostUsd, int ProviderCalls, int CacheHits);

public sealed record AiUsageFeatureRow(
    string Component, string DisplayName, long TotalTokens, decimal EstimatedCostUsd, int ProviderCalls);

public sealed record AiUsagePrRow(
    string PrRef, string DisplayLabel, long TotalTokens, decimal EstimatedCostUsd, int ProviderCalls);

public sealed record AiCacheStats(int CacheHits, int ProviderCalls, double HitRate);

public sealed record AiUsageTrendBucket(
    DateTimeOffset BucketStart, string Granularity, decimal EstimatedCostUsd, long TotalTokens);
```

## 5. Frontend

### 5.1 Nav (nested)

- `SettingsNav`'s **"AI"** item becomes a parent with two children: **Configuration** (`/settings/ai`, the existing `AiPane`) and **Usage** (`/settings/ai/usage`, new). The `AiMarker` sparkle stays on the AI parent.
- **Expand/active behavior (no manual toggle):** the children are rendered beneath the AI parent **whenever any `/settings/ai/*` route is active** (auto-expand; no chevron, no collapse control). The AI parent shows the design-system active/selected style while a child is the current route, and the active child is highlighted. Navigating to a non-AI section collapses the children.
- `SettingsModalRoutes` gains the `/settings/ai/usage` route → `AiUsagePane`. Unauthed deep-links redirect like other settings routes.

### 5.2 `AiUsagePane.tsx`

Layout, top to bottom:
1. **Window control** — segmented 24h / 7d / 30d / All; switching refetches.
2. **Headline card** — estimated equivalent cost for the window + total tokens. Label states what the number *is* before disclaiming it: *"Estimated API-equivalent cost — for reference only; PRism uses a Claude subscription, not pay-per-token billing."*
3. **Trend** — small per-bucket bars (plain CSS, scaled to the window max; no chart library). Hourly bars for 24h, daily for 7d/30d/All (weekly for All beyond 90 days). Each bar exposes its bucket label + value on hover (title/tooltip). The bar **container** is `aria-hidden` (decorative); a visually-hidden summary sentence ("Highest spend: {bucket}, {cost}") gives screen-reader users the signal — the precise data lives in the tables below.
4. **By-feature table** — feature · provider calls · tokens · est. cost, sorted by cost desc (the primary actionable lens). Headers are **static**, not interactive sort controls (feature count is ≤ 4).
5. **Cache stat** — hit-rate + "N calls served from cache." (Phrase as "served from cache," not "no spend" — a cache *read* still has a small token cost; only the full re-egress is avoided.)
6. **By-PR drill-down** — secondary, **collapsed by default**; when expanded shows the top 20 rows by cost with a "Show all {TotalPrCount} PRs" disclosure when more exist; the "Inbox (batched)" row is always shown when present.

**Number formatting (shared helpers):** token counts use locale thousands separators, no abbreviation (counts here stay well under 10M). Costs render to **4 decimal places when below $0.01** (e.g. `$0.0012`) and 2 decimals otherwise — a naive 2-dp format would show real sub-cent costs as `$0.00` and read as "AI is free." The headline cost uses the same adaptive precision.

### 5.3 Data + states

- `AiUsageReport` interface in `api/types.ts`; `getAiUsage(window)` in `api/ai.ts`.
- **Loading:** cold load shows skeleton bars + table rows sized to the populated layout; a **window switch** keeps the previously-rendered data visible with a subtle loading indicator on the window control (no full-pane replacement), then swaps in the new report — avoids a flash and a "7d numbers while 30d loads" mismatch.
- **Empty:** "No AI usage recorded yet."
- **Error:** fixed copy "Could not load usage data." + a "Try again" button that re-issues the fetch (do not surface raw server error text).
- States are handled inline and self-contained — deliberately **not** depending on the still-in-design `AiLoadState` (#508) to avoid coupling to unmerged work (align in a follow-up if #508 lands first — §9).

## 6. Error handling & edge cases

- **No usage yet / no log / first tick pending:** empty `200` report; pane shows empty state.
- **Rollup not on the request path:** the GET only reads the in-memory store — no log I/O, no fold, so nothing the tailer does can fail an AI call or a usage request.
- **Crash between fold and persist:** no loss, no double-count — `tailOffset` advances only inside a successful atomic persist (§4.1), so the next tick re-reads exactly the lines that weren't persisted.
- **Malformed rollup file on load:** start empty at `tailOffset = 0`; first tick rebuilds (§4.2).
- **Malformed / partial audit-log lines:** skipped without advancing the offset past them (§4.3); a mid-write trailing line is folded on a later tick once complete.
- **Log truncation / shrink (or future rotation):** detected via file length `< tailOffset` → reset offset to 0 and rebuild, with a warning (§4.2). No silent gap.
- **`Fallback` / `ProviderError` outcomes:** counted by `Outcome` per §4.1 — `ProviderError` is a provider call (no cost); `Fallback` is excluded from provider calls (it's a synthetic `Egressed: true` marker that would otherwise double-count the failed attempt's egresses).
- **`PrRef = "batch"`:** surfaced as an explicit "Inbox (batched)" row, not dropped, and never cut by the top-20 cap.
- **Cost null on non-`Ok` records:** coalesced to 0.
- **Clock:** all bucketing uses UTC; the tailer and store take `TimeProvider` for testability.

## 7. Testing

**Backend (TDD):**
- `AiInteractionLogReader`: reads from a byte offset and returns the new end-of-last-complete-line offset; extracts the leading `timestamp`; skips malformed lines and a partial trailing line **without advancing past it**; missing file → empty + offset unchanged.
- `AiUsageRollupStore`: fold updates the right (hour, component, pr) bucket; `ProviderCalls` counts `Ok`+`ProviderError` by outcome (not `Egressed`); a fallback scenario (2 `Ok` + 1 `Fallback`, all `Egressed: true`) yields `ProviderCalls == 2` and `Fallback` is not a provider call; `ProviderError` counts as a provider call with 0 cost; null cost coalesced; retry attempts each counted; atomic persist→load round-trip preserves buckets **and** `tailOffset`; corrupt/missing file → empty store at offset 0.
- `AiUsageRollupTailer`: a tick folds only new lines past `tailOffset` and advances it; re-running a tick after a simulated crash-before-persist does **not** double-count (offset only moves on persist); truncation (file length < offset) → rebuild from 0 + warning; persists only when dirty; `StopAsync` does a final tick; `StartAsync` does not block on backfill.
- `AiUsageAggregator`: window filtering (24h boundary, 7d/30d, all); by-feature grouping + sort; by-PR top-20 cap + `TotalPrCount` + "batch" always included; cache hit-rate incl. zero-denominator; trend granularity per window incl. weekly-past-90-days for All; unknown component pass-through.
- Endpoint: window validation + default; empty report when no data / before first tick; always 200 (not gated on AI mode); session auth enforced.

**Frontend:**
- Pane renders a populated report (headline, trend bars, by-feature, cache, by-PR); window switch shows stale-while-loading then swaps; cold skeleton; empty + error (Try again) states; sub-cent cost formats as `$0.00xx` not `$0.00`; by-PR collapsed default + "Show all" disclosure + "Inbox (batched)" label.
- e2e: mock `/api/ai/usage`; AI nav auto-expands its children and routes to `/settings/ai/usage`.
- New settings nav child rebaselines settings screenshots (×2 platforms) — expected, mechanical.

## 8. Slicing

One spec; the implementation plan phases it as: **(A)** rollup substrate (`AiInteractionLogReader` + `AiUsageRollupStore` + `AiUsageRollupTailer` hosted service + DI) → **(B)** aggregator + DTO + endpoint → **(C)** frontend (nested nav + pane + states). Backend (A+B) and frontend (C) may split into two PRs if review size warrants; decided at planning.

## 9. Out of scope / deferred

- `IsRetry` on `AiInteractionRecord` for labeled retry breakout (follow-up if wanted — decision 3; see the AC caveat in §10).
- **Inbox-enrichment `CacheHit` emission** — the enricher doesn't record a `CacheHit` today (§2), so its cache hits are absent from the hit-rate. Closing this is a small one-line instrumentation follow-up (mirror the other seams) — owner decides whether to pull it into scope (§10 caveat).
- Rollup compaction/retention (collapse old hour-buckets into daily, bound bucket growth) — add only if the persisted file grows large enough to matter. Hour-grain across All-time is the accepted V1 trade-off for true rolling-24h.
- `AiLoadState` (#508) alignment — if #508 lands before this, a follow-up replaces the pane's self-contained load states with the shared abstraction.
- Configurable rate card — moot (CLI provides the estimate).
- Budget limits / alerts — not requested.
- Per-call list view — explicitly excluded (decision 5).

## 10. Acceptance criteria (from #517)

- [ ] A user-facing AI usage & spend view exists, backed by the recorded `AiInteractionRecord` data (via the durable rollup; no new per-call instrumentation).
- [ ] Usage and estimated spend can be viewed aggregated **by feature** and **by PR**.
- [ ] **Cache hits** (no egress) and the cache hit-rate are surfaced — across 3 of 4 seams (inbox enrichment omitted, §2 / §9).
- [ ] Cost is framed as an **estimate against a subscription**, not a literal per-call charge.
- [ ] Numbers are accurate — gated on #379 (resolved), modulo the bounded rebuild-on-truncation safety net (§4.2).

**Caveat — partially-relaxed issue ACs (owner sign-off needed, §10 disposition).** The source issue asks that *"retries be distinguished so the cost picture is honest / called out (`IsRetry`)"* and that *"cache savings"* be surfaced *"since the cache is the main cost lever."* Per decisions 2–3 this spec **counts** retry cost in totals but does **not** label retries, and treats cache as a secondary stat rather than the headline. Both consciously relax the issue's wording; they are tracked as owner decisions (pull `IsRetry` / promote cache to the headline), not silently dropped.
