# Issue #605 — PRism.Web session/lock races & validation hardening

Date: 2026-06-28
Branch: `fix/605-web-races-validation`
Scope: `PRism.Web` (+ its test project) only. No changes to `frontend/`, `PRism.Core`,
`PRism.GitHub`, or `desktop/` (owned by parallel issues #603/#607).

Six defects in the PRism.Web review/draft surface, all concurrency- or validation-related. Each
fix is TDD-backed by a discriminating xUnit test in `tests/PRism.Web.Tests`.

## Fixes

### A (Major) — `/drafts/discard-all` did not take the per-PR submit lock
`PrDraftsDiscardAllEndpoint.DiscardAllAsync` wiped the session via `stateStore.UpdateAsync`
without holding the `SubmitLockRegistry` slot that `/submit`, `/comment/post`, and
`/root-comment/post` hold. A concurrent in-flight submit could re-materialise a half-populated
pending review on top of the local clear.

**Fix:** mirror `/submit/discard` — `cancellationRegistry.RequestCancel(prRef)` to cancel any
in-flight pipeline, then `lockRegistry.TryAcquireAsync(..., DiscardTimeouts.LockAcquireTimeout)`
to drain it; `504 pipeline-cancellation-timeout` if it does not release in the window. The clear
runs inside the lock (try/finally dispose). The best-effort courtesy `DeletePendingReview` stays
fire-and-forget after the lock is released.

File: `PRism.Web/Endpoints/PrDraftsDiscardAllEndpoint.cs`.
Test: `PrDraftsDiscardAllEndpointTests.PostDiscardAll_serializes_against_an_in_flight_submit`.

### B (Major) — post/submit read draft body from a pre-lock snapshot
`/comment/post` captured the draft `BodyMarkdown` from the discrimination `LoadAsync` taken before
the GitHub call. A concurrent `PUT /draft` editing the body between that load and the call (the
draft writer participates only in the store `_gate`, not the submit lock) was silently lost, then
`StampThenDelete` dropped the draft for good.

**Fix:** re-read the draft body from the store inside the submit lock, immediately before the
GitHub call (`ReloadCommentBodyAsync` / `ReloadReplyBodyAsync`). Other draft fields (anchor / file
/ line) are immutable, so only the body is re-read; a concurrent delete surfaces `no-draft`.

File: `PRism.Web/Endpoints/PrCommentEndpoints.cs`.
Test: `PrCommentEndpointTests.PostComment_inline_reReads_body_so_concurrent_edit_is_not_lost`
(uses a transparent `EditInjectingStore` decorator that injects a one-shot edit after the
discrimination load, simulating the concurrent PUT).

**Deviation / scope note:** issue #605 also lists the `/submit` path
(`SubmitPipeline.cs`, ~73/314). That file lives in **`PRism.Core`**, which is out of the allowed
tier for this issue (and is owned by parallel work). Per the issue's explicit instruction
("If item B's lock re-read genuinely requires a Core/GitHub seam change, STOP and report"), the
`/submit`-pipeline half of B is **not** implemented here. The `/comment/post` half (fully in
`PRism.Web`) is fixed and tested. Flagged for a follow-up against `PRism.Core`.

### C (Minor) — `newDraftComment` accepted `LineNumber=0` / null `Side`
`NewDraftCommentPayload.LineNumber` is a non-nullable `int` (omitted → 0) and `Side` binds to null
when omitted; the validator checked body/sha/path but neither. A bad draft persisted and only
failed at submit (line 0 → GitHub rejects).

**Fix:** in `ValidateAndParseOperand` (`newDraftComment`), reject `LineNumber < 1`
(`line-number-invalid`) and null/empty `Side` (`side-missing`) with a clean `422`.

File: `PRism.Web/Endpoints/PrDraftEndpoints.cs`.
Tests: `PrDraftEndpointTests.NewDraftComment_lineNumber_zero_returns_422`,
`NewDraftComment_empty_side_returns_422`, `NewDraftComment_null_side_returns_422`.

### D (Minor) — body-size cap allowlist omitted several body-reading mutating endpoints
The `UseWhen` 16 KiB cap covered some endpoints but not `POST .../comment/post`,
`POST /api/preferences`, `POST /api/auth/connect`, `/auth/connect/commit`,
`/auth/host-change-resolution`, or `.../ai/summary/regenerate`.

**Fix:** add the missing leaves to the predicate — `StartsWithSegments` for `/api/preferences`,
`/api/auth/connect` (covers `/connect` and `/connect/commit`), and
`/api/auth/host-change-resolution`; `EndsWith("/comment/post")` and
`EndsWith("/ai/summary/regenerate")` in the `/api/pr` POST branch.

File: `PRism.Web/Program.cs`.
Test: `RequestSizeLimitTests.Mutating_request_with_oversize_body_returns_413` (new InlineData rows).

### E (Minor) — `GitHubErrorMapper.ToResult` flattened every GitHub status to 502
A GitHub 401/403 (revoked / under-scoped token) reported as 502 reads as transient → futile
retries.

**Fix:** map `github-unauthorized → 401`, `github-forbidden → 403`, everything else → 502. The
sanitized `code` field is unchanged.

**Wire-safety (pre-resolved SAFE in the issue):** the frontend branches only on the sanitized
`code` (`github-unauthorized` / `github-forbidden`), never the literal HTTP status number, and the
message is already user-visible. Verified no existing PRism.Web test asserts an auth-class GitHub
failure → 502 (the existing `Unauthorized → 403` test is the `RequireSubscribed` authz path with
code `unauthorized`, unrelated; the `GitHub 5xx → 502` test uses 503, which still maps to 502).

File: `PRism.Web/Endpoints/Shared/GitHubErrorMapper.cs`.
Tests: `PrCommentEndpointTests.PostComment_github_401_maps_to_401_keeps_github_unauthorized_code`,
`PostComment_github_403_maps_to_403_keeps_github_forbidden_code`.

### F (Minor) — `ViewedFiles` map never pruned stale-head entries
The `path → head-SHA` map accumulated stale entries toward the 10000 cap and round-tripped in full
to the frontend.

**Fix:** on write in `POST .../files/viewed`, keep only entries whose stored SHA equals the
current head (`body.HeadSha`, already verified equal to the live snapshot head). Pruning before the
cap check also lets the pruned size gate the cap.

**Wire-safety (pre-resolved SAFE in the issue):** the FE already filters to head-matched entries
(`useFileViewState.ts`), so pruning is a pure size win with zero visible behavior change.

File: `PRism.Web/Endpoints/PrDetailEndpoints.cs`.
Test: `PrDetailEndpointsTests.Post_files_viewed_prunes_superseded_sha_entries_on_write`.

## Verification
- `dotnet build` (PRism.Web + tests) — clean.
- `dotnet test` (PRism.Web.Tests) — all green (ensure no detached Kestrel on :5180 first, else
  `LockfileException` in host-building tests).
