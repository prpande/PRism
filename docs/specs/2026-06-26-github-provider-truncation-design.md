# GitHub provider: silent truncation & malformed-2xx handling (#604)

**Issue:** [#604](https://github.com/prpande/PRism/issues/604) · **Tier:** T2 · **Risk:** hands-off
**Scope:** Parts A–D. **Part E deferred to [#628](https://github.com/prpande/PRism/issues/628)** (owner decision — see below).

## Problem

`PRism.GitHub`'s read paths carry four correctness defects where a 2xx response is
parsed into silently-wrong or incomplete data (or, in B, a 500). Each is cited
point-in-time in the issue. None touches a risk surface (the changes are on the
**read** GraphQL query and REST reads, not the reviewer-atomic submit pipeline,
auth/PAT, persisted schema, or the security/egress surface).

## Part E — deferred (decision recorded)

The activity readers (`GitHubReceivedEventsReader`, `GitHubNotificationsReader`,
`GitHubWatchedReposReader`) fetch a single `per_page=100` page and never follow
`Link rel="next"`, so an active user's `user/subscriptions` set silently truncates
past page 1 → false "not watching" negatives.

**Real pagination follows the absolute `Link rel="next"` URL, which touches the
PAT-egress guard** (scheme+host+port validation + the GHES `…/api/v3`
double-prefix gotcha). That surface — and the generalized `GitHubHttp.PaginateAsync`
mechanism — is **owned by #628**. Per the issue owner, Part E is **deferred to #628**
rather than fixed inline (which would flip #604 to gated B2 and preempt #628). A
signal-only stopgap was considered and rejected: it would not fix the false-negative
(only pagination does) and would be reworked when #628 lands. #604's Part-E
acceptance is therefore "truncation decision recorded → deferred to #628," cross-linked
on both issues.

## Part A — nested GraphQL connections truncate with no cap-hit signal

`GitHubReviewService.PrDetailGraphQLQuery` requests `pageInfo{hasNextPage}` only on
the **top-level** `comments`, `reviewThreads`, and `timelineItems` connections.
`HasAnyNextPage` (via `PagedConnections`) checks exactly those three. But:

- the **nested** `reviewThreads.nodes[].comments(first:100)` has **no `pageInfo`** —
  a thread with >100 replies silently drops replies, and
- `reviews(last:100)` has **no `pageInfo`** — a PR with >100 reviews computes the
  viewer-review from a truncated set,

both with **no `TimelineCapHit`** banner. The submit path (`FindOwnPendingReviewAsync`)
guards both nested levels with fail-loud `hasNextPage` checks; the read path must agree.

### Fix
1. Add `pageInfo{hasNextPage}` to the **nested** `reviewThreads…comments` connection
   (forward `first:100` pagination → `hasNextPage` is the correct signal).
2. Add `pageInfo{hasPreviousPage}` to `reviews(last:100)`. **`reviews` is backward
   pagination** anchored at the newest end: with >100 reviews you receive the newest 100
   and GitHub sets `hasPreviousPage` (the *older* reviews dropped off the front), leaving
   `hasNextPage` false. So the cap-hit signal for `reviews` is `hasPreviousPage`, not
   `hasNextPage`. `last:100` is kept deliberately — `ParseViewerReview` needs the newest
   reviews; `first:100` would return the oldest and break it. *(Review finding, two-reviewer
   consensus: detecting `hasNextPage` here would never fire against real GitHub while a
   `hasNextPage:true` fixture test stayed green — a vacuous fix. The codebase already
   resolved this connection's truncation in `GitHubPrBatchReader.cs:281-285` via
   full-page-count; we use the more precise `hasPreviousPage` here since this query carries
   per-connection `pageInfo` cleanly.)*
3. Extend cap-hit detection so `HasAnyNextPage(pull)` returns true when **any**:
   - top-level `comments` / `reviewThreads` / `timelineItems` `pageInfo.hasNextPage`
     (unchanged, via `PagedConnections`), **or**
   - `reviews.pageInfo.hasPreviousPage` (new, field-specific — *not* added to the
     `hasNextPage`-based `PagedConnections` walk), **or**
   - **any** `reviewThreads.nodes[].comments.pageInfo.hasNextPage` (new nested walk over
     each thread node).
4. Update the `GraphQlByteIdentityTests.ExpectedPrDetail` constant to match the new
   query string (the shape-drift guard — intentional, pinned change).

**Banner-semantics note (intentional conflation).** All four triggers feed the single
`TimelineCapHit` boolean and the existing `Log.TimelineCapHit` warning. A nested-thread
reply truncation thus raises the same coarse "some content was not fully loaded" banner as
a capped top-level timeline page. This is **intentional and consistent with the existing
single-boolean design**: the user's remedy is identical (reload / view on GitHub)
regardless of which connection truncated, at this PoC product stage. Refining the
banner/log copy to name *which* connection truncated is out of scope (possible follow-up).

### Tests (red on main)
- `GetPrDetailAsync` with a `reviewThreads` node whose `comments.pageInfo.hasNextPage:true`
  → `TimelineCapHit == true`. (Red: nested `pageInfo` absent → not detected.)
- `GetPrDetailAsync` with `reviews.pageInfo.hasPreviousPage:true` → `TimelineCapHit == true`.
  (Red: `reviews` carries no `pageInfo` → not detected. The fixture sets `hasPreviousPage`,
  matching real `last:100` semantics — a `hasNextPage:true` fixture would be a false test.)
- Existing `…parses_pr_meta…` (all flags false) still `TimelineCapHit == false` (no false-positive).
- `GraphQlByteIdentityTests` updated and green.

## Part B — `changed_files` `GetInt32()` not value-kind guarded → 500 on the diff path

`GitHubReviewService.cs:418` (`FetchPullMetaAsync`, the `GetDiffAsync` path):

```csharp
var changedFiles = root.TryGetProperty("changed_files", out var cf) ? cf.GetInt32() : 0;
```

`TryGetProperty` returns `true` for a JSON `null`; `GetInt32()` on a non-number throws
`InvalidOperationException`. Unlike the inbox path this isn't guarded, so it **500s**
instead of degrading. Asymmetric with the sibling `base.sha`/`head.sha` reads (`?? ""`).

### Fix
Guard the kind: `cf.ValueKind == JsonValueKind.Number ? cf.GetInt32() : 0`.

**Degradation note (advisory, FYI from review).** `changed_files` is the sole truncation
oracle (`truncated = pull.ChangedFiles > files.Count`). Degrading a null/non-number count
to `0` makes `truncated` evaluate `false`, so on a *malformed-2xx for a large PR* the user
could see an incomplete diff with no cap banner. This is accepted: a `null` `changed_files`
on a valid PR is effectively a never-case (GitHub always returns the int), and biasing the
other way (`int.MaxValue` → always-truncated) would flip the existing **absent**→0 behavior
(which the regression pin preserves) into a spurious banner on empty/edge PRs. The guard's
job here is to stop the **500**, not to second-guess a malformed count. Recorded explicitly
so the suppression is a known, documented limitation rather than a silent one.

### Tests (red on main)
- `GetDiffAsync` against a pull JSON with `"changed_files": null` → no throw;
  `changedFiles` treated as 0 (so `truncated` derives from `0 > files.Count` = false).
  (Red: `GetInt32()` throws → `GetDiffAsync` 500s.)
- Absent `changed_files` already returns 0 (regression pin).

## Part C — per-commit / CI SHA interpolated unescaped

Call sites interpolate a SHA into the request path raw, diverging from the audited
siblings (`GetCommitAsync`, `GetFileContentAsync`) that use `Uri.EscapeDataString`:

- `GitHubReviewService.FetchOneCommitChangedFilesAsync` — `commits/{commit.Sha}`
- `GitHubCiFailingDetector` check-runs URL — `commits/{sha}/check-runs`
- `GitHubCiFailingDetector` combined-status URL — `commits/{sha}/status`
- **`GitHubPrChecksReader.ReadCheckRunsAsync:57`** — `commits/{sha}/check-runs`
  *(added in #635, after #604 was filed)*
- **`GitHubPrChecksReader.ReadStatusesAsync:98`** — `commits/{sha}/status`

Values are clean hex oids today; a malformed/whitespace oid would alter the request
path (latent path-injection seam).

The last two sites are a **defensive-parity extension** surfaced by the review's
security-lens pass: they are the *identical* unescaped pattern in a sibling reader added
after #604 was filed, so leaving them raw would re-create the exact inconsistency Part C's
"parity with audited siblings" rationale exists to remove. The exploit is currently
unreachable on that path (the `/checks` endpoint runs `IsValidGitOid(sha)` upstream), so
this is defensive consistency, not a security fix — but escaping them is one line each and
keeps the parity rationale honest.

### Fix
`Uri.EscapeDataString(sha)` / `Uri.EscapeDataString(commit.Sha)` at each site, for
parity with the audited siblings.

### Tests (red on main)
- CI detector: drive a `headSha` containing a reserved char (e.g. `"abc def?x=1"`) and
  capture the outgoing request URI → the SHA segment is percent-encoded and stays in the
  path (no injected query). (Red: raw interpolation leaks the reserved char.)
- Per-commit fan-out: a GraphQL timeline whose commit `oid` carries a reserved char →
  the captured per-commit REST URL escapes it.
- `GitHubPrChecksReader`: drive a reserved-char `sha` and capture the check-runs +
  combined-status request URIs → both percent-encode the SHA segment.

## Part D — `FetchPagedCountAsync` treats `rel="last"` page number as the item count

`GitHubReviewService.cs:358-405`. Correct **only** because both callers pass
`per_page=1` (so `lastPage == total`). A future caller with `per_page>1` would get
`ceil(total/per_page)` reported as the raw count, silently corrupting the poller's
`CommentCount`/`ReviewCount` diff that drives `pr-updated` emission.

### Fix
Make the boundary explicit and self-documenting. Chosen approach: **throw at the method
boundary when the URL's `per_page` is not `1`.** A defensive parse extracts the
`per_page` query param from `url`; if it is present and `!= 1`, throw `ArgumentException`
(`per_page>1` is not supported by this counter). Rationale: (a) both current callers pass
`per_page=1` (`GitHubReviewService.cs:316-317`), so the throw cannot fire today; (b) the
general `(lastPage-1)*per_page + lastPageItemCount` formula needs the last page's body
length which this method doesn't fetch in the Link-present branch; (c) generalized
counting belongs with #628's shared pagination layer. The throw turns a latent
silent-miscount into a loud failure the moment a `per_page>1` caller is added.

**A real `throw`, not `Debug.Assert`** *(two-reviewer consensus).* `Debug.Assert` is
compiled out of Release builds, which is what PRism ships — so a Debug-only assert would
leave the silent miscount fully live in production, defeating the fix's stated purpose. The
guard must be an unconditional runtime `throw` so it fires in Release. (Absent `per_page` in
the URL is treated as the existing per_page=1 contract and does not throw — only a present
`per_page != 1` does.)

### Tests (red on main)
- `FetchPagedCountAsync` parses `rel="last"` `page=250` with `per_page=1` → returns 250
  (regression pin of today's correct behavior).
- A `per_page=5` URL throws `ArgumentException` rather than silently returning the page
  number. (Red: today it silently returns the page number — the test would need the throw,
  which doesn't exist yet. The test runs in the standard Release-or-Debug test config and
  must hold in both, which a `Debug.Assert` would not.)

## Acceptance criteria

- [ ] A: nested thread `comments` carry `pageInfo{hasNextPage}` and `reviews` carries
  `pageInfo{hasPreviousPage}`; a >100-comment thread and >100 reviews each set
  `TimelineCapHit`; byte-identity test updated; no false-positive.
- [ ] B: `changed_files` value-kind guarded; `null`/absent → 0, no 500 on the diff path.
- [ ] C: SHA `Uri.EscapeDataString`-escaped at all five call sites (3 cited + 2
  `GitHubPrChecksReader` defensive-parity sites).
- [ ] D: `FetchPagedCountAsync` throws on `per_page>1`; `per_page==1` unchanged.
- [ ] E: truncation decision recorded → deferred to #628 (this spec + cross-link).

## Out of scope

- Activity-reader pagination + egress-guard/GHES verification → **#628**.
- Generalized `(lastPage-1)*per_page + lastPageItemCount` counting → folds into #628's
  shared pagination layer.
- Owner/repo path-segment escaping (issue scopes Part C to the SHA, for sibling parity).

## `ce-doc-review` dispositions (1× pass, 5 personas)

Coherence: clean. Feasibility / Adversarial / Scope-guardian / Security-lens findings:

| # | Finding | Conf. | Disposition |
|---|---------|-------|-------------|
| 1 | Part A `reviews(last:100)` cap-hit must check `hasPreviousPage`, not `hasNextPage` (backward pagination) — else the fix never fires and a `hasNextPage` fixture stays falsely green | 75 (adversarial+feasibility, 2×) | **Applied** — Part A rewritten to `hasPreviousPage`; field-specific detection; fixture sets `hasPreviousPage`. |
| 2 | Part D `Debug.Assert` is a no-op in Release → guard never fires in shipping builds | 75 (adversarial+scope, 2×) | **Applied** — switched to an unconditional `throw ArgumentException`. |
| 3 | Part C leaves 2 identical unescaped SHA sites in `GitHubPrChecksReader` (#635), undermining the "parity" rationale (exploit unreachable upstream) | residual (security-lens) | **Applied (extended scope)** — folded both sites into Part C as defensive parity. |
| 4 | Part B null→0 suppresses the `truncated` oracle on a malformed-2xx large PR | 50 FYI (adversarial) | **Applied as documented** — kept →0 (per issue + regression pin); documented the limitation. |
| 5 | Part A single `TimelineCapHit` boolean mislabels nested-thread reply loss as "timeline cap" | 50 FYI (adversarial) | **Applied as documented** — added the intentional-conflation note; copy refinement out of scope. |
| — | Part E false-negatives live until #628; owner/repo escaping out-of-scope is correct; Part E deferral is not a security regression | residual (scope + security) | **Acknowledged** — owner-accepted; no action. |
