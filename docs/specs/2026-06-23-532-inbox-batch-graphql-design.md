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
2. Produce **byte-identical `PrInboxItem` rows** before/after, with two explicitly documented,
   bounded deltas (see § Parity).
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
    DateTimeOffset PushedAt,   // headRepository.pushedAt  (see § Parity — verify live)
    DateTimeOffset? MergedAt,  // mergedAt
    DateTimeOffset? ClosedAt,  // closedAt
    string? ViewerLastReviewSha); // computed from reviews(last:100) — see § Awaiting-author parity
```

`InboxRefreshOrchestrator` calls `ReadAsync` **once** per refresh (over all distinct PR refs across
visible sections + closed-history), then:

- maps `BatchPrData` hydration fields onto each `RawPrInboxItem` (replacing `_enricher.EnrichAsync`);
- applies the awaiting-author keep-rule using `ViewerLastReviewSha` (replacing
  `_awaitingFilter.FilterAsync`).

`GitHubPrEnricher` and `GitHubAwaitingAuthorFilter` (the REST impls) are **removed**. No REST
fallback (see § Failure semantics). The awaiting-author *keep-rule* — `sha != null && sha != head` —
moves to a small pure, unit-testable helper.

### GraphQL query shape (per alias, mirroring `GitHubPrTimelineReader.BuildQuery`)

```graphql
aN: repository(owner:"o", name:"r") { pullRequest(number:N) {
  headRefOid additions deletions changedFiles
  commits { totalCount }
  mergedAt closedAt
  headRepository { pushedAt }
  reviews(last:100) { nodes { author { login } state submittedAt commit { oid } } }
} }
```

Plus `rateLimit { cost remaining }` at the query root for cost measurement. `viewerLogin` is passed
into `ReadAsync` by the orchestrator (it already has it via `_viewerLoginProvider()`), so the query
does **not** select `viewer { login }` — no need to round-trip it.

- **100-alias cap + split:** mirror the precedent's `MaxBatch = 100`. The reader splits >100 refs
  into multiple queries itself (the timeline reader leaves splitting to the caller; this reader owns
  it, since the orchestrator passes an arbitrary-length ref list). Typical inboxes (REST search is
  `per_page=50` per section, 4 sections) fit in 1–2 batches.

### Caching (critical — prevents steady-state regression)

Today both REST fan-outs cache per PR and skip unchanged PRs, so a quiescent inbox makes ~0 hydration
REST calls per tick. A batch that re-fetches everything every tick would make a quiescent inbox
*more* expensive (1–2 GraphQL calls/tick + point cost) — the exact regression the epic warns against.

The reader therefore caches `BatchPrData` keyed by **`(PrReference, UpdatedAt)`** and only batches the
**cache-stale** refs each tick; cached entries are merged in. Rationale for the key:

- `UpdatedAt` (from the Search API, already on `RawPrInboxItem`) bumps on *any* PR activity — push,
  comment, **or new review** — so an unchanged `UpdatedAt` guarantees neither hydration nor the
  viewer's review set changed. It is a strict superset of the old enricher key (`(ref, UpdatedAt)`)
  and the old awaiting key (`(ref, HeadSha)`).
- Net effect: quiescent inbox → 0 batches; cold/churny inbox → `ceil(stale/100)` batches.

Cache eviction mirrors the existing `InboxCacheEviction.PruneAbsent` (drop refs absent from the
current ref set).

### Orchestrator rewiring (`InboxRefreshOrchestrator.RefreshAsync`)

Replace the two steps at `:143` (enrich) and `:155-161` (awaiting filter) with:

1. `batch = await _batchReader.ReadAsync(allDistinctRefs, viewerLogin, ct)`.
2. Map hydration onto raw items (same `Where(!IsNullOrEmpty(HeadSha))` drop for refs the batch didn't
   resolve — preserves the enricher's null-drop).
3. For the `awaiting-author` section, keep PRs where `batch[ref].ViewerLastReviewSha is { } sha &&
   sha != headSha` — identical predicate to today.

CI detection, materialization, dedupe, AI enrichment, diff/publish are **untouched**.

## Parity

### `pushedAt` (the one real risk)

REST derives it from `head.repo.pushed_at`. The GraphQL equivalent is `headRepository { pushedAt }`
(the head repo's `Repository.pushedAt`). These should be the identical underlying field, but this
**must be verified live** against a real PR before relying on it (the awaiting-author and hydration
parity tests below pin it). Fallback if they ever diverge: the field is informational on the row
(used for sort/“pushed” display), and the REST enricher already falls back to `UpdatedAt` when
`pushed_at` is absent — the reader mirrors that fallback (`PushedAt ??= UpdatedAt` at the call site).

### Awaiting-author last-review SHA — replicate REST semantics, do NOT reuse `ParseViewerReview`

`GitHubPrParser.ParseViewerReview` **excludes DISMISSED/PENDING** reviews. The current REST walk
(`FetchLastReviewShaAsync`) does **not** exclude DISMISSED — it takes the viewer's review with the
maximum `submitted_at` among reviews with a **non-empty `commit_id`** and a **string-kind
`submitted_at`** (PENDING drafts, whose `submitted_at` is null, are skipped). Reusing
`ParseViewerReview` would therefore be a *behavior change* for PRs whose latest viewer review is
DISMISSED.

To preserve byte-identical parity, add a dedicated helper
`ParseViewerLastReviewSha(JsonElement pull, string viewerLogin)` that mirrors the REST logic exactly
against the GraphQL `reviews.nodes` shape (`author.login`, `submittedAt`, `commit.oid`): max
`submittedAt` among the viewer's reviews that carry a non-null `submittedAt` **and** a non-empty
`commit.oid`; **no `state` filter**. (`state` is selected in the query only for future use / debug; it
is intentionally not used in the parity path.)

> **Latent-behavior note (deferred, not fixed here):** including DISMISSED reviews in the
> awaiting-author SHA may itself be questionable, but #532's contract is parity. If it should change,
> that is a separate issue — flagged, not silently "fixed."

### `reviews(last:100)` bound (documented delta)

The REST walk pages up to `MaxReviewPages = 10` × 100 = ~1000 reviews and logs `ReviewPagesCapped`
when truncated. A single GraphQL alias caps at `reviews(last:100)`. For a PR with **>100 reviews where
the viewer's latest is older than the 100 most recent**, the computed SHA can differ. This is rare,
and `last:100` matches the cap the PR-detail query and timeline reader already accept. **Decision:**
adopt `last:100`; do not paginate inside the batch (that would defeat batching). Emit the same
`ReviewPagesCapped`-style log when an alias returns exactly 100 review nodes (best-effort
truncation signal, since `reviews(last:N)` carries no `pageInfo` in the precedent query).

### Caching delta (strictly-more-correct)

The old awaiting cache keyed on `(ref, HeadSha)` could return a stale review SHA when the viewer
submitted a new review at the *same* head (no push). The unified `(ref, UpdatedAt)` key invalidates on
that case (a new review bumps `UpdatedAt`). This is a correctness *improvement*, documented as an
accepted, strictly-more-correct delta to the "byte-identical" claim.

## Failure semantics

- **Transport failure** (non-2xx, network) → propagate, aborting the refresh tick. This mirrors the
  current enricher/awaiting-filter ("5xx/timeout propagates; orchestrator decides to skip the tick";
  `InboxPoller` retries next tick). No REST fallback — maintaining a parallel REST path defeats the
  consolidation and doubles the parity surface.
- **Per-alias null / partial data** (GitHub returns HTTP 200 with partial `data` when some aliases
  error — e.g. a repo the PAT can't see) → that ref is absent from the result dict; the orchestrator
  drops it via the existing empty-`HeadSha` filter. Mirrors `GitHubPrTimelineReader`'s per-alias
  null-tolerance and the enricher's 404→null drop.
- **`RateLimitExceededException`** → propagate as today (poller honors Retry-After). GraphQL 429s are
  surfaced via the existing `GitHubHttp.ThrowIfRateLimited`.

## Testing

Mirror `GitHubPrTimelineReaderTests` patterns. New `GitHubPrBatchReaderTests`:

1. **Query construction** — N refs → correct aliased query string (owner/name JSON-escaped, numbers,
   `reviews(last:100)`, `rateLimit`, `viewer`).
2. **Alias parsing** — full hydration + `ViewerLastReviewSha` parsed from a representative response.
3. **>100-ref split** — 150 refs → 2 queries; results merged.
4. **Per-alias error tolerance** — one alias `null` in `data` → that ref absent, others present.
5. **Awaiting-author parity** — DISMISSED-included max-`submittedAt` selection; PENDING (null
   `submittedAt`) skipped; empty `commit.oid` skipped; `>100` reviews truncation behavior.
6. **`pushedAt` parity + fallback** — `headRepository.pushedAt` mapped; absent → `UpdatedAt` fallback.
7. **Caching** — unchanged `UpdatedAt` → no re-fetch (assert batch call count); changed `UpdatedAt` →
   re-fetch; `PruneAbsent` eviction.

Orchestrator-level:

8. **Parity harness** — a fixture set of raw items run through (a) the old REST path and (b) the new
   batch path produces identical `PrInboxItem` lists (modulo the two documented deltas). Reuse the
   existing inbox test doubles (`FakeSectionQueryRunner`, etc.).
9. **Awaiting-author keep-rule** — `sha != null && sha != head` predicate unit test (pure helper).

Measurement (recorded in PR `## Proof`, not a CI gate): a representative inbox's round-trip count and
GraphQL `rateLimit.cost` before/after.

## Acceptance criteria

- [ ] One aliased-batch GraphQL reader replaces the per-PR REST hydration + awaiting-author review
      walk; both REST impls removed.
- [ ] `PrInboxItem` rows byte-identical before/after (two documented deltas: `reviews(last:100)`
      bound; `(ref, UpdatedAt)` cache key — both strictly bounded/strictly-more-correct).
- [ ] CI detection unchanged (still REST).
- [ ] Tests: query construction, alias parse, >100 split, per-alias error tolerance, awaiting-author
      parity, pushedAt parity, caching, orchestrator parity harness.
- [ ] Measured round-trip + GraphQL point-cost reduction in PR `## Proof`.
- [ ] Zero frontend / DTO / persisted-schema change.

## Risks

- **`pushedAt` divergence** — mitigated by live verification + `UpdatedAt` fallback (informational
  field).
- **GraphQL point cost** — mitigated by `(ref, UpdatedAt)` caching (quiescent inbox → 0 batches) and
  explicit before/after measurement. If a fat `reviews(last:100)`-per-alias batch proves point-heavy,
  a follow-up optimization is to select `reviews` **only** for awaiting-author candidates (two alias
  shapes) — deferred; measure first.
- **Awaiting-author parity** — mitigated by the dedicated REST-faithful helper + parity tests.
