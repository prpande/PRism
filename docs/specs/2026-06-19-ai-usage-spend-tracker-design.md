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
7. **Durable, rotation-resilient rollup** is the read source — **not** a per-request log scan. The audit log may rotate, and scanning a growing log per request is wasteful. (Revises the initial "scan per request" sketch.)
8. **IA:** the usage dashboard is a **child** of the AI settings nav item, not a new top-level tab and not appended into the config pane.
9. **Endpoint is not gated on current AI mode.** Past usage is worth showing even when AI is currently Off — a deliberate divergence from the sibling AI endpoints' "204 when not subscribed" behavior.

## 4. Architecture

```
AI seams ──record──► IAiInteractionLog ──► JsonlAiInteractionLog (writes ai-interactions.log)   [unchanged]
                            │
                            └─(write-through, decorator)─► AiUsageRollupStore (in-memory buckets)
                                                                  │  periodic flush + shutdown flush
                                                                  ▼
                                                       {dataDir}/llm-usage/usage-rollup.json   [authoritative read source]
                                                                  ▲
                       startup reconcile / first-ship backfill ───┤
AiInteractionLogReader (reads ai-interactions.log) ───────────────┘  [recovery/backfill ONLY — never per request]

GET /api/ai/usage?window=  ──► AiUsageAggregator(rollup buckets, window) ──► AiUsageReport DTO ──► AiUsagePane
```

### 4.1 `AiUsageRollupStore` (durable rollup — the read source)

- **Persisted file:** `{dataDir}/llm-usage/usage-rollup.json` (same dir + owner-restricted ACL as `token-usage.jsonl`).
- **Grain:** one bucket per **(UTC-hour, `Component`, `PrRef`)**. Hour-grain is what makes a true rolling-24h window possible; every coarser pivot (by-feature, by-PR, daily trend, 7d/30d/All windows) derives by summing buckets.
- **Bucket fields:** `InputTokens`, `OutputTokens`, `CacheReadInputTokens`, `CacheCreationInputTokens` (sums), `EstimatedCostUsd` (sum), `ProviderCalls` (count of `Outcome ∈ {Ok, ProviderError}`), `CacheHits` (count of `Outcome == CacheHit`). Plus a store-level `LastSeenTimestamp` (the newest record timestamp folded in) used for startup reconcile.
- **Metrics definition (count by `Outcome`, NOT by `Egressed` — `Egressed` is unreliable here):**
  - `ProviderCalls` = `count(Outcome == Ok) + count(Outcome == ProviderError)` — the actual provider invocations (a thrown call records `ProviderError` and does *not* also record an `Ok`). **Includes retries**, since each parse-failed attempt records its own `Ok`.
  - `CacheHits` = `count(Outcome == CacheHit)` (no egress, no cost).
  - **`Fallback` is excluded from `ProviderCalls`.** Critical subtlety: the ranker emits a synthetic `Fallback` record **with `Egressed: true`** (`ClaudeCodeFileFocusRanker.cs:158-160`) *in addition to* the failed attempts' `Ok` records — so a fallback scenario is 2 `Ok` + 1 `Fallback`. Counting by `Egressed == true` would treat that as 3 provider calls; counting by `Outcome` correctly yields 2. `Fallback` carries no cost (cost already came from the `Ok` attempts) and is tracked separately/informationally only.
  - Cost/token sums coalesce nulls to 0 (only `Ok` records carry them; `ProviderError`/`Fallback`/`CacheHit` carry nulls → 0).
- **Concurrency:** updates are serialized (lock or `SemaphoreSlim`, mirroring `JsonlTokenUsageTracker`). Writes are in-memory and cheap; disk persistence is periodic, not per-record.
- **Corruption handling:** if `usage-rollup.json` is missing or unparseable on load, start empty and **rebuild** by backfilling from `ai-interactions.log` via the reader (best effort — bounded by whatever the log still retains).

### 4.2 Write-through maintenance

- A decorator/composite around `IAiInteractionLog` forwards each `AiInteractionRecord` to **both** the existing `JsonlAiInteractionLog` **and** `AiUsageRollupStore.Fold(timestamp, record)`. The existing JSONL write is untouched and remains the durable audit trail / recovery source.
- The fold is **non-fatal** (same principle as the audit sink): a rollup failure must never break an AI call. Folding happens in-memory; nothing touches disk on the request path.

### 4.3 `AiUsageRollupMaintainer` (`IHostedService`, mirrors `AiSeamWarmup`)

- **`StartAsync`:** load `usage-rollup.json`; then **catch-up reconcile** — read only the `ai-interactions.log` lines with `timestamp > store.LastSeenTimestamp` and fold them in (recovers any delta unflushed at the last crash/exit). On **first ship** the rollup file won't exist, so this is a full backfill of the historical log.
  - **Rotation handling:** if `LastSeenTimestamp` is not found anywhere in the current log (the log rotated/truncated away those lines), the rollup already holds everything up to the last flush; fold whatever the current log contains that is newer than `LastSeenTimestamp`, and log a warning. Worst case we lose at most one flush-interval of data in the rare flush-gap + rotation coincidence.
- **Periodic flush:** a timer persists the in-memory rollup to disk every *N* (e.g. 60s) **only when dirty**.
- **`StopAsync`:** final flush.

### 4.4 `AiInteractionLogReader`

- Reads `ai-interactions.log` back into `(DateTimeOffset Timestamp, AiInteractionRecord Record)` pairs, using the **same `JsonSerializerOptions`** `JsonlAiInteractionLog` writes with (camelCase + enum converter).
- Each line is parsed as a `JsonNode`: pull the leading `timestamp` property (injected at write-time, not a field on the record), then deserialize the remainder into `AiInteractionRecord` (STJ skips the unmapped `timestamp` by default).
- **Malformed/partial lines are skipped, not fatal** — a half-written trailing line from a crash, or a future added field, must not break the read.
- Supports reading "lines newer than timestamp T" efficiently for catch-up reconcile.
- **Used only** by the maintainer (backfill/reconcile/rebuild) — never on the request path.

### 4.5 `AiUsageAggregator`

- Pure function: `(IEnumerable<bucket>, window, now) → AiUsageReport`. No I/O; trivially unit-testable.
- Filters buckets to the window (24h = `bucketHour >= now - 24h`; 7d/30d = trailing N days; All = no filter), then:
  - **Totals:** summed tokens (all four kinds), summed est. cost, total `ProviderCalls`, total `CacheHits`.
  - **ByFeature:** group by `Component` → display name; sorted by est. cost desc. Unknown components pass through with their raw name (forward-compatible).
  - **ByPr:** group by `PrRef`; sorted by est. cost desc; `"batch"` rendered as "Inbox (batched)".
  - **Cache:** `CacheHits`, `ProviderCalls`, and a hit-rate = `CacheHits / (CacheHits + ProviderCalls)` (0 when denominator is 0).
  - **Trend:** time buckets across the window — **hourly** for the 24h window, **daily** for 7d/30d, daily (or coarser) for All.

### 4.6 Endpoint — `GET /api/ai/usage?window=7d`

- Registered in `AiEndpoints.MapAi`, using the same authenticated-session pattern as sibling endpoints.
- `window` validated against `{24h, 7d, 30d, all}`; missing/invalid → default `7d`.
- Always returns **`200 AiUsageReport`** (an empty report — zeros and empty arrays — when no usage has been recorded). **Not** gated on AI mode (decision 9).
- Reads from `AiUsageRollupStore` via the aggregator. No log I/O on the request path.

### 4.7 DTO

```csharp
public sealed record AiUsageReport(
    string Window,                       // echoes "24h" | "7d" | "30d" | "all"
    DateTimeOffset GeneratedAt,
    AiUsageTotals Totals,
    IReadOnlyList<AiUsageFeatureRow> ByFeature,
    IReadOnlyList<AiUsagePrRow> ByPr,
    AiCacheStats Cache,
    IReadOnlyList<AiUsageTrendBucket> Trend);

public sealed record AiUsageTotals(
    long InputTokens, long OutputTokens, long CacheReadInputTokens,
    long CacheCreationInputTokens, long TotalTokens,   // TotalTokens = sum of the four
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

- `SettingsNav`'s **"AI"** item becomes a parent with two children rendered beneath it when AI is the active section: **Configuration** (`/settings/ai`, the existing `AiPane`) and **Usage** (`/settings/ai/usage`, new). The `AiMarker` sparkle stays on the AI parent.
- `SettingsModalRoutes` gains the `/settings/ai/usage` route → `AiUsagePane`. Unauthed deep-links redirect like other settings routes.

### 5.2 `AiUsagePane.tsx`

Layout, top to bottom:
1. **Window control** — segmented 24h / 7d / 30d / All; switching refetches.
2. **Headline card** — estimated equivalent cost for the window + total tokens, labeled *"estimated equivalent cost (rate-card) — not a literal charge against your subscription."*
3. **Trend** — small per-bucket bars (plain CSS, scaled to the window max; no chart library). Hourly bars for 24h, daily bars for 7d/30d/All.
4. **By-feature table** — feature · provider calls · tokens · est. cost, sorted by cost desc (the primary actionable lens).
5. **Cache stat** — hit-rate + "N calls served from cache (no spend)."
6. **By-PR drill-down** — collapsible/secondary, sorted by cost desc, including the "Inbox (batched)" row.

### 5.3 Data + states

- `AiUsageReport` interface in `api/types.ts`; `getAiUsage(window)` in `api/ai.ts`.
- **Loading / empty / error** handled inline and self-contained — deliberately **not** depending on the still-in-design `AiLoadState` (#508) to avoid coupling to unmerged work. Empty state: "No AI usage recorded yet." Error: message + retry.

## 6. Error handling & edge cases

- **No usage yet / no log:** empty `200` report; pane shows empty state.
- **Malformed rollup file:** rebuild from log on load (§4.1).
- **Malformed audit-log lines:** skipped during backfill/reconcile (§4.4).
- **Rollup fold failure on the request path:** impossible — folding is in-memory and write-through at record time, never during the GET. A fold exception at record time is swallowed (non-fatal).
- **Log rotation during the flush gap:** bounded data loss + warning (§4.3).
- **`Fallback` / `ProviderError` outcomes:** counted by `Outcome` per §4.1 — `ProviderError` is a provider call (no cost); `Fallback` is excluded from provider calls (it's a synthetic `Egressed: true` marker that would otherwise double-count the failed attempt's egresses).
- **`PrRef = "batch"`:** surfaced as an explicit "Inbox (batched)" row, not dropped.
- **Cost null on non-`Ok` records:** coalesced to 0.
- **Clock:** all bucketing uses UTC; the maintainer and store take `TimeProvider` for testability.

## 7. Testing

**Backend (TDD):**
- `AiInteractionLogReader`: parses a line incl. timestamp extraction; skips malformed/partial lines; "newer than T" filtering; missing file → empty.
- `AiUsageRollupStore`: fold updates the right (hour, component, pr) bucket; `ProviderCalls` counts `Ok`+`ProviderError` by outcome (not `Egressed`); a fallback scenario (2 `Ok` + 1 `Fallback`, all `Egressed: true`) yields `ProviderCalls == 2` and `Fallback` is not counted as a provider call; `ProviderError` counts as a provider call with 0 cost; null cost coalesced; retry attempts each counted; persist→load round-trip; corrupt file → empty + rebuild path invoked.
- `AiUsageRollupMaintainer`: startup loads + reconciles only lines newer than `LastSeenTimestamp`; first-ship full backfill; rotation (missing timestamp) → warning + best-effort fold; flush only when dirty; shutdown flush.
- `AiUsageAggregator`: window filtering (24h boundary, 7d/30d, all); by-feature/by-pr grouping + sort; cache hit-rate incl. zero-denominator; trend granularity per window; unknown component pass-through; "batch" label.
- Endpoint: window validation + default; empty report when no data; always 200 (not gated on AI mode); auth.

**Frontend:**
- Pane renders a populated report (headline, trend bars, by-feature, cache, by-PR); window switch refetches; empty + error states; "Inbox (batched)" row label.
- e2e: mock `/api/ai/usage`; nested nav expands and routes to `/settings/ai/usage`.
- New settings nav child rebaselines settings screenshots (×2 platforms) — expected, mechanical.

## 8. Slicing

One spec; the implementation plan phases it as: **(A)** rollup substrate (reader + store + maintainer, write-through wiring) → **(B)** aggregator + DTO + endpoint → **(C)** frontend (nested nav + pane + states). Backend (A+B) and frontend (C) may split into two PRs if review size warrants; decided at planning.

## 9. Out of scope / deferred

- `IsRetry` on `AiInteractionRecord` for labeled retry breakout (follow-up if wanted — decision 3).
- Rollup compaction/retention (collapse old hour-buckets into daily) — add only if bucket growth becomes a real problem.
- Configurable rate card — moot (CLI provides the estimate).
- Budget limits / alerts — not requested.
- Per-call list view — explicitly excluded (decision 5).

## 10. Acceptance criteria (from #517)

- [ ] A user-facing AI usage & spend view exists, backed by the recorded `AiInteractionRecord` data (via the durable rollup; no new per-call instrumentation).
- [ ] Usage and estimated spend can be viewed aggregated **by feature** and **by PR**.
- [ ] **Cache hits** (no egress) and the cache hit-rate are surfaced; retry cost is included in totals.
- [ ] Cost is framed as an **estimate against a subscription**, not a literal per-call charge.
- [ ] Numbers are accurate — gated on #379 (resolved).
