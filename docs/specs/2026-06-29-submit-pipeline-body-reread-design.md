# SubmitPipeline body re-read under lock (remainder of #605 B) — design

**Issue:** [#659](https://github.com/prpande/PRism/issues/659) · part of #605
**Tier:** T2 · **Risk:** gated B2 (reviewer-atomic submit pipeline) · **Date:** 2026-06-29

## Problem

`POST /submit` captures a `ReviewSessionState session` snapshot **before** acquiring the
per-PR submit lock (`PrSubmitEndpoints.cs:127`, lock at `:174`) and passes that snapshot
verbatim into the fire-and-forget `SubmitPipeline.SubmitAsync` (`:220`). The pipeline reads
draft/reply/summary `BodyMarkdown` off that snapshot at three sites:

- threads — `SubmitPipeline.cs:314` (`PipelineMarker.Inject(draft.BodyMarkdown, draft.Id)`)
- replies — `SubmitPipeline.cs:447` (`PipelineMarker.Inject(reply.BodyMarkdown, reply.Id)`)
- PR-root summary — `SubmitPipeline.cs:192` via `ExtractPrRootBody(session)` at `BeginPendingReview`

A concurrent `PUT /draft` editing a body participates only in the store's `_gate`, **not** the
submit lock, so an edit landing between the snapshot and a GitHub attach/begin call is silently
lost — the same defect class #605 fixed for `/comment/post`. This is the `/submit` remainder,
deliberately deferred from PR #661 because the pipeline is a resumable, per-step-overlay design
that warranted its own slice rather than being rushed into the Web-fenced PR.

## Fix

Mirror #605 B's `ReloadCommentBodyAsync`/`ReloadReplyBodyAsync`: re-read each body from the
store via `IAppStateStore.LoadAsync` **immediately before** its GitHub call, inside the pipeline.

The pipeline already holds `_stateStore` and computes `sessionKey = reference.ToString()`; every
existing overlay write (`StampDraftThreadIdOverlay`, etc.) already re-reads the session under that
key. Re-reading the body is the same operation. Add two **instance** helpers (they read the
`_stateStore` field, unlike the static overlay transforms which receive `AppState` from `UpdateAsync`):

```
ReloadDraftBodyAsync(sessionKey, draftId, ct)  -> store body or null
ReloadReplyBodyAsync(sessionKey, replyId, ct)  -> store body or null
```

The body-sending chokepoint is the `DraftThreadRequest` / `AttachReplyAsync` construction. For
threads it is reached by **both** fresh-create (`ThreadId` null, no marker match) **and** recreate
(`ThreadId` set but gone from the server snapshot — `SubmitPipeline.cs:274` "Falls through to
recreate"). Only the skip (still-present), adopt (marker-match), and multi-marker branches return
early without sending a body. Placing the re-read at the shared chokepoint covers create and
recreate identically.

Call sites:

1. Threads (`StepAttachThreadsAsync`): before building `DraftThreadRequest`, compute
   `freshBody = await ReloadDraftBodyAsync(...) ?? draft.BodyMarkdown`, send `freshBody`, **and**
   update the working session (`current = StampDraftBody(current, draft.Id, freshBody)`) so the
   in-pipeline snapshot stays in lockstep with what was posted — see the lockstep decision below.
2. Replies (`StepAttachRepliesAsync`): before `AttachReplyAsync`, compute
   `freshBody = await ReloadReplyBodyAsync(...) ?? reply.BodyMarkdown`, send `freshBody`, and
   update `current = StampReplyBody(current, reply.Id, freshBody)`.
3. Summary (`StepBeginAsync`, **fresh-start only**): re-read the session under `sessionKey` and
   extract the PR-root body (`ExtractPrRootBody`) from it, falling back to the passed snapshot when
   the session is absent. `Begin` runs only on the no-existing-pending-review branch, so this
   closes the window on the first submit attempt; see Out of scope for the resume case.

### Decisions

- **Null/absent re-read → fall back to the in-memory snapshot body.** The fix can only improve
  freshness, never regress: a draft that vanished from the store mid-submit keeps the body the
  pipeline would have used pre-fix. (A genuine single-draft deletion mid-submit is not a real
  path — `/comment/post` and other `/submit` attempts hold the same submit lock; discard-all
  cancels the whole pipeline via CTS; `PUT /draft` edits, it does not delete.)
- **Store-read failure → retryable step `Failed`.** Route each re-read through the existing
  `InvokeAsync` wrapper so an `IAppStateStore.LoadAsync` throw becomes a `SubmitFailedException`
  at the owning step, consistent with every other store/adapter call in the pipeline. (A raw throw
  would escape `SubmitAsync` and break its "always returns an outcome" contract.)
- **Per-call, not once-per-step.** Re-read immediately before each call (matching #605 B and the
  issue text) to keep the loss window minimal. The production `AppStateStore.LoadAsync` reads
  `state.json` from disk under `_gate` (no in-memory cache), so each re-read is one small-JSON disk
  read — negligible next to the GitHub round-trip that immediately follows, and the same order as
  the per-stamp `UpdateAsync` (load+save) the pipeline already performs once per draft/reply. Draft
  and reply counts are small and bounded by an explicit user submit. This narrows but does not
  *eliminate* the window — a `PUT /draft` landing between the reload's `LoadAsync` and the GitHub
  call is still lost (the two are not atomic). Same fundamental property as #605 B.
- **Update the working session body in lockstep (thread/reply).** Re-reading only the local request
  body would leave the in-pipeline `current` session carrying the stale snapshot body. On a later
  step failure, the endpoint persists the at-failure session *wholesale*
  (`PrSubmitEndpoints.cs:236` `state.WithSession(sessionKey, failed.NewSession)`), so GitHub would
  hold the fresh body while the local store reverts to the stale one — a GitHub-vs-local divergence
  that did not exist pre-fix. Updating `current` (via new `StampDraftBody`/`StampReplyBody` pure
  transforms, mirroring the existing `StampDraftThreadId`) keeps the working snapshot in lockstep
  with what was posted, so the at-failure session the endpoint persists matches GitHub. No new
  overlay write is needed — the store already holds the fresh body (the concurrent `PUT /draft`
  wrote it); only the in-memory working snapshot needs the update.
- **No body-length re-check.** #605 B re-validates `freshBody.Length` after reload because its body
  source is broader; here every `PUT /draft` write path caps `BodyMarkdown` at
  `BodyMarkdownMaxChars = 8192` (`PrDraftEndpoints.cs:444/469/480/495/507`), so a stored body is
  already within cap. Re-reading it cannot exceed the limit; no pipeline-side length check is added.
- **Body-only re-read is sufficient.** `PUT /draft` mutates only `BodyMarkdown`; there is no
  operation that edits a draft's `FilePath`/`LineNumber`/`Side`, so the request's anchor fields
  (read from the immutable loop draft) cannot go stale. If a future patch kind allows editing a
  draft's anchor, this body-only reload becomes a gap.

### Why not the alternatives

- **Inject reloader callbacks from the endpoint** (mirror `getCurrentHeadShaAsync`): redundant
  indirection. The head-sha callback exists only because head sha comes from a different source
  (the live PR poller); the body lives in the store the pipeline already holds.
- **Endpoint re-captures the session under the lock and passes a fresh snapshot:** insufficient.
  It moves the snapshot to lock-acquisition time but edits during the multi-second pipeline run
  are still lost. Per-call re-read is the only option that closes the window the way #605 B did.

## Acceptance

- A concurrent `PUT /draft` body edit during an in-flight `/submit` is reflected in the posted
  thread / reply (the GitHub call), not lost. The PR-root **review summary** is covered on the
  fresh-start (`Begin`) path; on resume it is an accepted limitation (see Out of scope).
- Red-first proof at the pipeline tier: model the race as snapshot body `v1` ≠ store body `v2`
  (the real-world condition — the endpoint captured `v1` pre-lock; the store now holds `v2` from a
  concurrent `PUT /draft`). Without the fix the submitter receives `v1`; with it, `v2`. Test matrix
  (each with an injected `Finalize` failure so the pending review survives for body inspection,
  except where noted):
  1. **Thread fresh-create** — unstamped draft, store `v2` ≠ snapshot `v1` ⇒ attached thread body is `v2`.
  2. **Thread recreate** — stamped draft whose thread is absent from the server snapshot (falls
     through to the shared create block), store `v2` ≠ snapshot `v1` ⇒ recreated thread body is `v2`.
     Guards the shared chokepoint so it stays covered if create/recreate ever diverge.
  3. **Reply create** — unstamped reply on a present parent thread, store `v2` ≠ snapshot `v1` ⇒
     attached reply body is `v2`.
  4. **Summary at Begin (fresh start)** — PR-root summary, store `v2` ≠ snapshot `v1` ⇒ the review
     body sent to `BeginPendingReview` is `v2`.
  5. **Failure-path lockstep** — after a thread posts `v2`, a later `Finalize` failure returns
     `SubmitOutcome.Failed` whose `NewSession` draft body is `v2`, not the stale `v1` (proves the
     working-session lockstep update; pre-fix `current` keeps `v1`).

## Out of scope

- The overlay-persistence reconciliation between a concurrent `PUT /draft` and the pipeline's
  post-call stamp writes (last-write-wins on the persisted session) is unchanged. Only the body
  **sent to GitHub** is made fresh; `ClearSubmittedSession` drops all drafts on success regardless,
  and the stamp overlays already edit only `ThreadId`/`ReplyCommentId`, never the body.
- **Summary freshness on resume.** `StepBeginAsync` — the only site that sends the PR-root summary
  as the GitHub review body — runs only on the no-existing-pending-review branch. On a resumed
  submit (a pending review already created on a prior attempt), `Begin` is skipped and GitHub fixes
  the review body at creation; there is no update-review-body capability on `IReviewSubmitter`. So a
  summary edit made between a first attempt's `Begin` and a later-attempt resume cannot propagate.
  Propagating it would require a separate `UpdatePendingReviewBody` step — a new capability, not
  this defect-class fix.
- **Summary lockstep on the Begin-then-fail path.** The thread/reply lockstep update is not applied
  to the PR-root summary draft: on a `Begin`-succeeds-then-later-step-fails sequence, the persisted
  PR-root draft may revert to the snapshot body while GitHub keeps the posted summary. Same
  self-healing transient as the thread/reply case (a retry resumes — `Begin` is skipped — and
  `ClearSubmittedSession` drops unposted PR-root drafts on success). Left unaddressed to keep the
  summary handling minimal, consistent with the resume limitation above.
