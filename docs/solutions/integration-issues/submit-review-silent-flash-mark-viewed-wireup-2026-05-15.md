---
title: "Submit review silently flashed: missing /mark-viewed wire-up, empty 4xx catches, GraphQL error detail dropped"
date: 2026-05-15
category: integration-issues
module: PRism.Web,PRism.GitHub,frontend
problem_type: integration_issue
component: submit_pipeline
symptoms:
  - "Click 'Submit review' → SubmitDialog flashes in-flight → reverts to idle with no toast; nothing posts to GitHub"
  - "DevTools Console: 8x repeated 'Failed to load resource: status 400 (Bad Request)' on POST /api/pr/{ref}/submit"
  - "Network → Response body: {\"code\":\"head-sha-drift\",\"message\":\"Reload the PR before submitting.\"} — but Reload banner is never rendered because no real drift exists"
  - "After the wire-up fix lands, a downstream submit failure surfaces as 'Submit failed: GitHub GraphQL request returned 1 error(s).' — the actual GitHub reason ('Resource not accessible by integration', etc.) is discarded"
  - "Backend logs contain nothing useful — default ASP.NET Core logging is console-only and the rejection path never called ILogger"
  - "Cross-tab: two tabs on the same PR can poison each other's last-viewed-head-sha (no tab dimension in the session key) — Tab A's stamp at head=B overwrites Tab B's at head=A"
root_cause: missing_integration
resolution_type: code_fix
severity: high
tags: [submit-pipeline, mark-viewed, github-graphql, error-surfacing, toast, fire-and-forget, cross-tab, react-hooks, e2e-coverage-gap]
related_solutions:
  - workflow-patterns/ci-fail-fast-masks-latent-regressions-2026-05-08.md
  - integration-issues/spa-static-assets-mime-type-fallback-2026-05-05.md
---

# Submit review silently flashed: missing /mark-viewed wire-up, empty 4xx catches, GraphQL error detail dropped

## Problem

After S5 (submit pipeline) shipped 2026-05-13, every first-time submit on a freshly-opened PR produced a brief "in-flight" UI flash with no toast, no GitHub call, and no log entry. The user clicked Submit; nothing happened.

The failure was three coupled bugs that each hid the others:

1. **Frontend never called `POST /api/pr/{ref}/mark-viewed`.** The endpoint existed in `PrDetailEndpoints.cs:89` and was the primary write site for `ReviewSessionState.LastViewedHeadSha`. The only other write site (`PrReloadEndpoints.cs:161`) required the user to click the Reload banner, which itself only appears *after* drift is detected. So `LastViewedHeadSha` stayed null on every fresh PR, deterministically tripping `PrSubmitEndpoints` rule (f) with a 400 `head-sha-drift`.
2. **`PrHeader.tsx` swallowed every 4xx silently.** Two catch sites (`.catch(() => {})` on `onSubmit` and `onResume`) with a comment claiming `useSubmitToasts` handled the toast. The comment was wrong — `useSubmitToasts` only listened for two SSE events, never for HTTP 4xx. Result: the 9 pre-pipeline rejection codes produced no user-visible feedback.
3. **Backend conflated never-stamped with real drift.** Both returned the same code (`head-sha-drift`) and same message ("Reload the PR") — but Reload requires a banner that only appears on real drift, so a never-stamped session left the user with no remedy. Neither path was logged.

A further latent gap surfaced once submit started actually running: `GitHubGraphQLException.Message` rendered only the error count ("returned 1 error(s)") even though the raw `errors[]` array (carrying `[FORBIDDEN] Resource not accessible by integration (path: addPullRequestReview)` etc.) was right there on `ErrorsJson`. The pipeline forwarded only `ex.Message` to the SSE event, so the actionable detail never reached the user.

The S5 e2e suite passed because `TestEndpoints.cs:170` directly seeded `LastViewedHeadSha` via `/test/submit/seed-pending-review`, bypassing the FE wire-up — the test surface and the production surface diverged.

## Investigation

DevTools Network confirmed every submit returned 400 with `{"code":"head-sha-drift", ...}`. With the frontend swallowing the error, the only path to that detail was the Network Response sub-tab — easy to miss when the symptom is a flash. The 9 pre-pipeline rejections in `PrSubmitEndpoints.SubmitAsync` were all candidates; `head-sha-drift` narrowed via the response body.

The "WHY drift?" question pointed at `LastViewedHeadSha`. Grep across `frontend/src/` for `mark-viewed` / `markViewed` / `MarkViewed` returned zero production call sites — only a test in `api-client.test.tsx` that exercised the POST shape but never wired it in. The backend `mark-viewed` endpoint was orphaned.

Once the wire-up landed, the submit pipeline started actually calling GitHub. The next error was the GraphQL detail being dropped. Grep for `Submit failed` traced through `SubmitPipeline.cs:160-162` (caught the GraphQL exception, forwarded only `ex.Message`) and `GitHubReviewService.Submit.cs:481-484` (constructed `GitHubGraphQLException` with a count message even though the raw errors array was available).

## Resolution

Fix shipped on `fix/submit-mark-viewed-wireup` (PR #55). Three coupled changes plus a broader external-API error pattern:

1. **Wire `POST /mark-viewed` from `usePrDetail`** after every successful PR-detail fetch with `{ headSha, maxCommentId }`. `maxCommentId` is `max(rootComments[].id)` stringified, mirroring the `markAllRead` patch's `HighestIssueCommentId` semantics. Fire-and-forget with an `AbortController` scoped to the effect cleanup (cancels stale stamps on rapid PR navigation) and a `console.warn` in the catch (so a sustained failure is visible in DevTools instead of producing a silent submit→"reload"→submit loop).

2. **`PrHeader.tsx`'s `surfaceSubmitError(err)`** replaces the empty catches. Per-code message map covers every `SubmitConflictError.code`; unknown codes fall through to the server's message rather than dropping silently. Non-`SubmitConflictError` throws get a generic "unexpected error, try again" toast. The error-toast UX was also tightened — auto-dismiss after 10s + de-dup identical (kind, message) pairs to avoid the wall-of-toasts you'd see on spam-click during a sticky failure.

3. **Backend rule (f) split.** Null `LastViewedHeadSha` now returns code `head-sha-not-stamped` and logs a `Warning` (server-detectable wire-up regression); real poll drift keeps `head-sha-drift` and logs `Information`. The 400 message stays terse ("Reload the PR and try again"); diagnostic detail (named missing call, FE wire-up hint) lives in the structured log so an unauthenticated viewer can't infer the route shape from the response.

4. **GraphQL error pattern.** `GitHubGraphQLException.FormatErrorsMessage(errorsJson)` renders the first error as `GitHub GraphQL: [CODE] message (path: x/y/z) (+ N more)`. Both throw sites (submit pipeline's `PostSubmitGraphQLAsync` and the read-side `ThrowIfGraphQLErrorsWithoutData`) use it; the rich message flows through `SubmitFailedException` → SSE `errorMessage` → toast unchanged downstream. Structured `ILogger` calls at every throw site log the full `ErrorsJson` so the operator sees every error, not just the first one rendered in the toast. `PostGraphQLAsync` now reads the response body on non-2xx and includes a 512-char snippet in the thrown `HttpRequestException` — so a 401 "Bad credentials" body reaches the user instead of being discarded by `EnsureSuccessStatusCode()`.

## Known limitations (carried forward)

- **Cross-tab stamp poisoning** is *not* fixed in PR #55 — it's documented here as a follow-up. The session is keyed only on `owner/repo/number`; two tabs on the same PR can overwrite each other's stamp. Fix requires adding a tab dimension to either the session shape or the rule-(f) check, both of which are bigger than a one-line addition. Tracked in the S5 deferrals doc under "PR #55 follow-ups".

## Recipe to verify the fix locally

```bash
# Pull PR #55 branch
git fetch origin fix/submit-mark-viewed-wireup
git checkout fix/submit-mark-viewed-wireup

# Rebuild frontend
cd frontend && npm run build && cd ..

# Run PRism
.\run.ps1
```

Open a fresh PR in the launched browser, add a comment, pick a verdict, click Submit. The pipeline now runs end-to-end:

- **Success path:** SSE progress steps render → review lands on GitHub → success toast.
- **GitHub-side rejection:** toast shows the actual GraphQL error (e.g., `GitHub GraphQL: [FORBIDDEN] Resource not accessible by integration (path: addPullRequestReview)`) instead of the bare count.
- **Auth issue:** 401 from GitHub renders the response body in the toast (`HTTP 401 Unauthorized: {"message":"Bad credentials","documentation_url":"..."}`).
- **Mark-viewed fails for any reason:** `console.warn` fires in DevTools naming the missing call — submit will return `head-sha-not-stamped` until a successful reload.

## Prevention

- **Treat e2e seed endpoints as smell.** When a test seeds session state via a `/test/*` route to bypass the production wire-up, the test surface and the production surface have diverged. Either delete the seed (force the test through the real flow) or add a parallel test that drives the real flow — never just the seed.
- **Empty `.catch(() => {})` blocks** should be reviewed as adversarial findings. The comment claiming "useSubmitToasts handles it" was wrong for six months and no one caught it — the empty body should have been the smell, not the comment.
- **External-API exceptions should always carry the underlying detail.** `GitHubGraphQLException` had `ErrorsJson` from day one; it just wasn't formatted into `Message`. Any new exception type wrapping an external API should put the actionable detail into `Message` at construction time, not rely on callers reaching through to a side-property.
- **Default ASP.NET Core logging is console-only.** PRism has no file-logger configuration; nothing makes it to disk. If diagnostic logs matter for support, that gap needs closing — at minimum a per-day rolling text logger writing to `<dataDir>/logs/`. Tracked as a separate follow-up.

## See also

- `frontend/src/api/markViewed.ts` — the new POST wrapper.
- `frontend/src/hooks/usePrDetail.ts:48-78` — fire-and-forget integration with AbortController + console.warn.
- `frontend/src/components/PrDetail/PrHeader.tsx` — `surfaceSubmitError` + `submitErrorMessage`.
- `PRism.Web/Endpoints/PrSubmitEndpoints.cs:109-130` — rule (f) split + structured logging.
- `PRism.GitHub/GitHubGraphQLException.cs` — `FormatErrorsMessage` helper.
- `PRism.GitHub/GitHubReviewService.Submit.cs:476-510` — submit-side throw + log.
- `PRism.GitHub/GitHubReviewService.cs:868-900` — read-side throw + transport-failure body surfacing.
- `tests/PRism.GitHub.Tests/GitHubGraphQLExceptionTests.cs` — formatter unit tests.
- `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md` — "Implementation-time deferrals — S5 PR55" subsection records the cross-tab deferral.
