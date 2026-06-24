# Inbox hydration + reviews: batched GraphQL (#532)

**Epic:** #598 (Slice A — anchor). **Tier:** T3. **Risk:** hands-off (backend-only; reuses the
guarded GraphQL transport; no B1/B2 surface).

## Problem

Every inbox refresh fans out a large number of per-PR REST round-trips:

- **Discovery** — 4 REST `search/issues` calls (one per visible section), `GitHubSectionQueryRunner.cs:103-106`.
- **Hydration** — **N** REST `GET /repos/{o}/{r}/pulls/{n}` (one per discovered PR) for head SHA,
  additions/deletions, commit count, changed files, `head.repo.pushed_at`, merged/closed timestamps,
  `GitHubPrEnricher.cs:47-56`.
- **Awaiting-author** — up to **N more** REST `GET /pulls/{n}/reviews` (10-page walk) to find the
  viewer's last-reviewed head SHA, `GitHubAwaitingAuthorFilter.cs:69-134`.

So a cold refresh costs roughly `4 + N + N` REST round-trips — meaningful latency and REST
rate-limit pressure on a busy inbox.

CI detection (`GitHubCiFailingDetector` — check-runs + combined status) is **out of scope**: it has
no GraphQL equivalent and stays REST.

## Goals

1. Replace the per-PR REST hydration **and** the awaiting-author review walk with **one aliased-batch
   GraphQL reader** (mirroring the existing `GitHubPrTimelineReader` precedent), routed through the
   shared `GitHubGraphQL.PostAsync` transport (PAT-egress guard intact).
2. Produce `PrInboxItem` rows that match the REST path, except for two explicitly documented deltas
   (see § Parity): one rare edge-case divergence (`reviews(last:100)` cap) and one strictly-more-correct
   improvement (the unified cache key).
3. Preserve the existing per-PR caching benefit so a **steady-state** inbox does not regress into
   re-fetching every tick (critical — see § Caching).
4. **Measure** the round-trip reduction *and* GraphQL point cost (`rateLimit { cost remaining }`),
   per the epic's measure-don't-assume principle.

## Non-goals

- CI detection (stays REST — no GraphQL equivalent).
- Section discovery (`search/issues`) stays REST — GraphQL `search` has a different shape, no
  `archived:false`, and a 100-node cap; converting it is not worth the parity risk (epic-excluded).
- The PR-detail active-poll batch (Slice B) — folded into #593, not here.
- Any `state.json` / persisted-schema change; any DTO wire-shape change (`RawPrInboxItem` /
  `PrInboxItem` are preserved). **Zero frontend impact.**
- Reviving the inbox prior-review marker (#527) — out of scope, even though the batched reviews make
  it cheaply available.

## Design

### New component: `IGitHubPrBatchReader`

```csharp
public interface IGitHubPrBatchReader
{
    Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<PrReference> refs, string viewerLogin, CancellationToken ct);
}

public sealed record BatchPrData(
    string HeadSha,            // headRefOid
    int Additions,             // additions
    int Deletions,             // deletions
    int CommitCount,           // commits.totalCount
    int ChangedFiles,          // changedFiles
    DateTimeOffset PushedAt,   // headRepository.pushedAt — headRepository may be null (deleted fork); fall back to UpdatedAt
    DateTimeOffset? MergedAt,  // mergedAt
    DateTimeOffset? ClosedAt,  // closedAt
    string? ViewerLastReviewSha); // computed at parse time from reviews(last:100) — see § Awaiting-author parity
```

> **As-built (see the impl plan's "Deviations from the spec"):** the interface is named
> `IPrBatchReader` (provider-agnostic, matching Core's `IPrEnricher`/`ISectionQueryRunner`
> convention) and `ReadAsync` takes `IReadOnlyList<RawPrInboxItem>` rather than
> `IReadOnlyList<PrReference>` — the `(PrReference, UpdatedAt)` cache key (see § Caching) cannot be
> computed from a bare ref list, and `RawPrInboxItem` carries both. Behavior is unchanged.

`InboxRefreshOrchestrator` calls `ReadAsync` **once** per refresh (over all distinct PR refs across
visible sections + closed-history), then:

- maps `BatchPrData` hydration fields onto each `RawPrInboxItem` (replacing `_enricher.EnrichAsync`);
- applies the awaiting-author **inclusion predicate** using `ViewerLastReviewSha` (replacing
  `_awaitingFilter.FilterAsync`).

**Component removal (sole consumer confirmed).** `InboxRefreshOrchestrator` is the only runtime
consumer of `IPrEnricher` and `IAwaitingAuthorFilter` (verified by grep — other matches are the DI
registrations and test doubles). Both interfaces *and* their REST implementations
(`GitHubPrEnricher`, `GitHubAwaitingAuthorFilter`) are **deleted entirely**, and the constructor
swaps the two parameters for `IGitHubPrBatchReader`. No REST fallback (see § Failure semantics). The
awaiting-author *inclusion predicate* moves to a small pure, unit-testable helper:

```csharp
static bool IsAwaitingAuthor(string? viewerLastReviewSha, string headSha)
    => viewerLastReviewSha is { } sha && sha != headSha;
```

The orchestrator (not the helper) applies it to filter the `awaiting-author` section.

### GraphQL query shape (per alias, mirroring `GitHubPrTimelineReader.BuildQuery`)

```graphql
aN: repository(owner:"o", name:"r") { pullRequest(number:N) {
  headRefOid additions deletions changedFiles
  commits { totalCount }
  mergedAt closedAt
  headRepository { pushedAt }     # headRepository can be null (deleted head fork) — guard the object
  reviews(last:100) { nodes { author { login } submittedAt commit { oid } } }
  # author.login is matched against viewerLogin at PARSE time (ParseViewerLastReviewSha),
  # NOT filtered in the query. As-built, `state` is omitted (impl plan deviation #3 — YAGNI;
  # the parity path never reads it, and reviving the #527 prior-review marker is a non-goal).
} }
```

Plus `rateLimit { cost remaining }` at the query root for cost measurement. `viewerLogin` is passed
into `ReadAsync` by the orchestrator (it already has it via `_viewerLoginProvider()`); the query does
**not** select `viewer { login }`.

- **100-alias cap + split:** mirror the precedent's `MaxBatch = 100`. The reader splits >100 refs
  into multiple queries itself (the timeline reader leaves splitting to the caller; this reader owns
  it, since the orchestrator passes an arbitrary-length ref list). Search is `per_page=50` × up to 4
  sections plus closed-history, so a busy cold inbox can reach 200+ distinct refs ⇒ **3–4 batches**;
  a typical inbox is 1–2. (Adjust the measurement plan's expectation accordingly.)

### Caching (critical — prevents steady-state regression)

Today both REST fan-outs cache per PR and skip unchanged PRs, so a quiescent inbox makes ~0 hydration
REST calls per tick. A batch that re-fetches everything every tick would make a quiescent inbox
*more* expensive (1–2 GraphQL calls/tick + point cost) — the exact regression the epic warns against.

The reader therefore caches `BatchPrData` keyed by **`(PrReference, UpdatedAt)`** and only batches the
**cache-stale** refs each tick; cached entries are merged in. Rationale for the key:

- `UpdatedAt` (from the Search API, already on `RawPrInboxItem`) bumps on *any* PR activity — push,
  comment, **or new review** — so an unchanged `UpdatedAt` guarantees neither hydration nor the
  viewer's review set changed.
- The key is **identical** to the old enricher key (`(ref, UpdatedAt)`, `GitHubPrEnricher.cs:34`), and
  **strictly more correct** than the old awaiting key (`(ref, HeadSha)`, `GitHubAwaitingAuthorFilter.cs:46`),
  which could return a stale review SHA when a new review landed at the same head (see § Parity).
- Net effect: quiescent inbox → 0 batches; cold/churny inbox → `ceil(stale/100)` batches.

Cache eviction reuses the existing `InboxCacheEviction.PruneAbsent` (drop refs absent from the current
ref set).

### Orchestrator rewiring (`InboxRefreshOrchestrator.RefreshAsync`)

Replace the two steps at `:143` (enrich) and `:155-161` (awaiting filter) with:

1. `batch = await _batchReader.ReadAsync(allDistinctRefs, viewerLogin, ct)`.
2. Map hydration onto raw items (same `Where(!IsNullOrEmpty(HeadSha))` drop for refs the batch didn't
   resolve — preserves the enricher's null-drop).
3. For the `awaiting-author` section, keep PRs where `IsAwaitingAuthor(batch[ref].ViewerLastReviewSha,
   headSha)` — identical predicate to today.

CI detection, materialization, dedupe, AI enrichment, diff/publish are **untouched**.

## Parity

### `pushedAt` (the one real field risk)

REST derives it from `head.repo.pushed_at`, guarding that `head.repo` is a present object before reading
(`GitHubPrEnricher.cs:76-83`), else falling back to `UpdatedAt`. The GraphQL equivalent is
`headRepository { pushedAt }`. Two requirements:

1. **Verify live** that `headRepository.pushedAt` equals REST `head.repo.pushed_at` for a healthy
   same-repo PR (they should be the identical `Repository.pushedAt` field).
2. **Both guards required — object AND scalar.** REST guards *both* `head.repo` as an object
   (`GitHubPrEnricher.cs:78`) *and* `pushed_at` as a String-kind scalar (`GitHubPrEnricher.cs:80`)
   before parsing; the batch parser must do the same:
   - **Object guard:** on a cross-fork PR whose head fork was deleted, GraphQL returns
     `headRepository: null` (the whole object) — guard `headRepository` present + object-kind before
     descending, else fall back to `UpdatedAt`.
   - **Scalar guard:** `Repository.pushedAt` is itself nullable (a zero-push repo returns
     `pushedAt: null` *inside* a present `headRepository`). Guard the leaf as String-kind before
     `GetDateTimeOffset()`, else fall back to `UpdatedAt`. **`GitHubGraphQL.TryGetPath` does NOT cover
     this** — it short-circuits on a null *intermediate* but returns `true` with a null-kind *leaf*, so
     calling `GetDateTimeOffset()` on that leaf would throw. (The per-alias defensive walk would catch
     the throw and drop just that one ref, but parity requires the explicit String-kind check so the
     ref survives with an `UpdatedAt` fallback instead of vanishing.)

### Awaiting-author last-review SHA — replicate REST semantics, do NOT reuse `ParseViewerReview`

`GitHubPrParser.ParseViewerReview` **excludes DISMISSED/PENDING** reviews (via `MapReviewState`,
`GitHubPrParser.cs:264-266`). The current REST walk (`FetchLastReviewShaAsync`,
`GitHubAwaitingAuthorFilter.cs:97-114`) does **not** filter on `state` — it takes the viewer's review
with the maximum `submitted_at` among reviews with a **non-empty `commit_id`** and a **string-kind
`submitted_at`** (PENDING drafts, whose `submitted_at` is null, are skipped). Reusing
`ParseViewerReview` would therefore be a *behavior change* for PRs whose latest viewer review is
DISMISSED.

To preserve parity, add a dedicated helper `ParseViewerLastReviewSha(JsonElement pull, string
viewerLogin)` that mirrors the REST logic exactly against the GraphQL `reviews.nodes` shape
(`author.login`, `submittedAt`, `commit.oid`): max `submittedAt` among the viewer's reviews that carry
a non-null `submittedAt` **and** a non-empty `commit.oid`; **no `state` filter**.

> **Latent-behavior note (deferred, not fixed here):** including DISMISSED reviews in the
> awaiting-author SHA may itself be questionable, but #532's contract is parity. If it should change,
> that is a separate issue — flagged, not silently "fixed."

### Documented delta 1 — `reviews(last:100)` bound (rare edge-case divergence)

The REST walk pages up to `MaxReviewPages = 10` × 100 = ~1000 reviews and logs `ReviewPagesCapped`
when truncated. A single GraphQL alias caps at `reviews(last:100)`. For a PR with **>100 reviews where
the viewer's latest is older than the 100 most recent**, the computed SHA can differ — a rare possible
divergence in `PrInboxItem` output (awaiting-author membership). `last:100` matches the cap the
PR-detail query and timeline reader already accept. **Decision:** adopt `last:100`; do not paginate
inside the batch (that would defeat batching). Emit a `ReviewPagesCapped`-style log when an alias
returns exactly 100 review nodes (best-effort truncation signal — `reviews(last:N)` carries no
`pageInfo` in the precedent query).

### Documented delta 2 — cache key (strictly-more-correct)

The old awaiting cache keyed on `(ref, HeadSha)` could return a stale review SHA when the viewer
submitted a new review at the *same* head (no push) — which can flip awaiting-author membership. The
unified `(ref, UpdatedAt)` key invalidates on that case (a new review bumps `UpdatedAt`). This is a
correctness *improvement*; output may differ from the old path only in that strictly-more-correct
direction.

## Failure semantics

The shared `GitHubGraphQL.PostAsync` does **not** surface rate limits — it throws a plain
`HttpRequestException` (with `StatusCode` preserved) on any non-2xx, and returns 200 bodies verbatim
even when GitHub signals a *secondary* rate limit as **HTTP 200 with `errors[].type == "RATE_LIMITED"`**.
The `GitHubPrTimelineReader` precedent degrades silently (returns an empty map, never throws), which
both swallows the rate-limit signal **and** contradicts this slice's abort-on-transport-failure
requirement. **The batch reader therefore owns its own error model — it does NOT blindly mirror the
precedent:**

- **Rate limit** — HTTP 429 (`HttpRequestException.StatusCode == TooManyRequests`) **or** a 200 body
  whose `errors[]` contains a `RATE_LIMITED` type → throw `RateLimitExceededException`, propagated to
  `InboxPoller`, which backs off honoring Retry-After (`InboxPoller.cs:63-72`). This preserves today's
  REST behavior (a hydration/awaiting 429 backs the poller off). *Caveat:* `PostAsync`'s
  `HttpRequestException` does not carry the `Retry-After` header, so the thrown exception has a null
  `RetryAfter`. The poller has **no separate max-backoff** — with a null `RetryAfter` it simply runs
  the next tick after the normal polling cadence (`InboxPoller.cs:66` only *raises* the delay when
  `RetryAfter` is non-null and exceeds the cadence). That is acceptable (no tight-loop) and strictly
  better than today's regression. Optional follow-up: teach `PostAsync` to attach `Retry-After`, or
  have the reader issue the POST directly to capture it — deferred.
- **Other transport failure** (non-429 non-2xx, network) → propagate, aborting the refresh tick
  (poller retries next tick). Mirrors the current enricher/awaiting "5xx propagates → skip the tick".
- **Per-alias null / partial data** — for a 200 with usable data where individual aliases are null or
  carry non-rate-limit errors (e.g. a repo the PAT can't see) → that ref is absent from the result
  dict; the orchestrator drops it via the existing empty-`HeadSha` filter (mirrors the enricher's
  404→null drop). This is **silent partial loss for that tick, not a fallback**; the reader emits a
  Debug log with the dropped-ref count so access regressions are observable.

The reader **owns the per-alias walk and the `errors[]` inspection itself** — it must NOT be wired as
`PostAsync` + `ThrowIfGraphQLErrorsWithoutData` (that helper throws on errors-without-data and is the
wrong abort-vs-degrade model for a multi-alias batch, where one good alias counts as "usable data").
Walk each expected alias defensively (`TryGet`), exactly as `GitHubPrTimelineReader.cs:64-75` does.

No REST fallback — maintaining a parallel REST path defeats the consolidation and doubles the parity
surface.

## Testing

Mirror `GitHubPrTimelineReaderTests` patterns (mockable via `FakeHttpClientFactory` /
`FakeHttpMessageHandler` since `PostAsync` takes a resolved `HttpClient`). New `GitHubPrBatchReaderTests`:

1. **Query construction** — N refs → correct aliased query string (owner/name JSON-escaped, numbers,
   `reviews(last:100)`, `rateLimit`; no `viewer`).
2. **Alias parsing** — full hydration + `ViewerLastReviewSha` parsed from a representative response.
3. **>100-ref split** — 150 refs → 2 queries; results merged.
4. **Per-alias error tolerance** — one alias `null` in `data` → that ref absent, others present;
   dropped-ref count logged.
5. **Awaiting-author parity + truncation log** — DISMISSED-included max-`submittedAt` selection;
   PENDING (null `submittedAt`) skipped; empty `commit.oid` skipped; exactly-100 review nodes →
   `ReviewPagesCapped`-style log.
6. **`pushedAt` parity + both null fallbacks** — `headRepository.pushedAt` mapped; `headRepository:
   null` (deleted-fork fixture) → `UpdatedAt` fallback; `headRepository` present but `pushedAt: null`
   (zero-push fixture) → `UpdatedAt` fallback (ref survives, not dropped — covers the String-kind
   scalar guard, not just the object guard).
7. **Caching** — unchanged `UpdatedAt` → no re-fetch (assert batch call count); changed `UpdatedAt` →
   re-fetch; `PruneAbsent` eviction.
8. **Rate-limit error model** — HTTP 429 → `RateLimitExceededException`; 200 body with
   `errors[].type=RATE_LIMITED` → `RateLimitExceededException`; non-429 transport error → propagates
   (abort); these are the cases the precedent gets wrong.

Orchestrator-level:

9. **Golden-output harness** — because both REST impls are deleted (the "old REST path" no longer
   exists to run live), parity is asserted against **captured golden `PrInboxItem` fixtures** that
   encode the documented REST output semantics: a representative raw-item set + GraphQL batch response
   run through the new batch path must reproduce the golden `PrInboxItem` list field-for-field (the two
   documented deltas are out of the golden by construction). The golden values come from the REST
   path's documented behavior (this spec + `GitHubPrEnricher`/`GitHubAwaitingAuthorFilter` semantics),
   not from a live REST run. Reuse the existing inbox test doubles for the orchestrator wiring.
10. **Inclusion-predicate** — `IsAwaitingAuthor(sha, head)` pure-function unit test.
11. **Test-double migration** — the existing orchestrator tests inject `IPrEnricher` /
    `IAwaitingAuthorFilter` doubles (`IdentityPrEnricher`, `PassthroughAwaitingAuthorFilter`,
    `DropEnricher` in `InboxRefreshOrchestratorTests`; `FakePrEnricher` in `PRism.Web/TestHooks/`; the
    `Program.cs` test-mode registration). All migrate to an `IGitHubPrBatchReader` double when the
    constructor changes. (These break at compile time; enumerated here so it's not a surprise.)

Measurement (recorded in PR `## Proof`, not a CI gate): a representative inbox's round-trip count and
GraphQL `rateLimit.cost` before/after.

## Acceptance criteria

- [ ] One aliased-batch GraphQL reader replaces the per-PR REST hydration + awaiting-author review
      walk; both REST impls **and** their interfaces deleted; orchestrator + DI + test doubles migrated.
- [ ] `PrInboxItem` rows match the documented REST output except for **delta 1** (`reviews(last:100)`
      cap — rare >100-review PRs) — verified by the orchestrator golden-output harness (REST impls are
      deleted, so the baseline is captured golden fixtures, not a live REST run).
- [ ] Caching strictly improved: `(ref, UpdatedAt)` key invalidates on same-head new reviews (**delta
      2**); quiescent inbox issues 0 batches/tick.
- [ ] Rate-limit error model: 429 **and** 200+`RATE_LIMITED` both raise `RateLimitExceededException`
      and back the poller off; non-rate-limit transport failure aborts the tick; per-alias loss drops
      only that ref (logged).
- [ ] CI detection unchanged (still REST).
- [ ] Tests: query construction, alias parse, >100 split, per-alias error tolerance, awaiting-author
      parity, pushedAt null-object parity, caching, rate-limit model, orchestrator parity harness,
      inclusion-predicate, test-double migration.
- [ ] Measured round-trip + GraphQL point-cost reduction in PR `## Proof`.
- [ ] Zero frontend / DTO / persisted-schema change.

## Risks

- **Rate-limit model regression** (the doc-review blocker) — mitigated by the reader-owned error model
  above (429 + 200/`RATE_LIMITED` → `RateLimitExceededException`); explicitly tested.
- **`pushedAt` divergence / deleted-fork null** — mitigated by live verification + null-*object* guard
  + `UpdatedAt` fallback (informational field).
- **GraphQL point cost** — mitigated by `(ref, UpdatedAt)` caching (quiescent inbox → 0 batches) and
  explicit before/after measurement. If a fat `reviews(last:100)`-per-alias batch proves point-heavy,
  a follow-up optimization is to select `reviews` **only** for awaiting-author candidates (two alias
  shapes) — deferred; measure first.
- **Awaiting-author parity** — mitigated by the dedicated REST-faithful helper + parity tests.
