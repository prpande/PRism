# Decouple commenting from review submission — design

- **Issue:** [#302](https://github.com/prpande/PRism/issues/302)
- **Date:** 2026-06-09
- **Tier / Risk:** T3 (slice-sized, net-new behavior) · **Gated** — B1 (`needs-design`) **and** B2 (Reviewer-atomic submit pipeline; persisted-schema change)
- **Status:** Draft — awaiting human spec gate
- **Review note:** revised after a `ce-doc-review` pass (2026-06-09) that corrected three factual errors in the first draft and resolved the dedup-model decision. Disposition table at the bottom (§ 14).

## 1. Problem

Every comment PRism authors today is staged as a local draft and batched into an
**atomic pending review** — the only way to get a comment onto GitHub is to press
**Submit review** (Approve / Request changes / Comment). There is no "just leave
this one comment now" path. This collapses GitHub's own distinction between
**"Add single comment"** (posts one comment immediately, no review) and **"Start a
review"** (batches comments into a pending review submitted atomically). PRism
implements only the second.

### What is actually missing (narrowed)

PRism **already** has a single-comment write path — but only for **PR-root
(conversation-level) comments**: `POST /api/pr/{ref}/root-comment/post` →
`IReviewSubmitter.CreateIssueCommentAsync` posts a standalone issue comment
immediately, bypassing `submitPullRequestReview`
(`PrRootCommentEndpoints.cs:47`, `GitHubReviewService.IssueComments.cs:25`). So the
atomic-review monopoly only binds **inline diff comments** and **thread replies**.
This slice adds a "post now" path for those two, modelled directly on the proven
root-comment precedent.

## 2. Scope

**In scope:**
- A "post a single comment now" path for **inline diff comments** (new thread on a
  line) and **thread replies**.
- The composer entry-point model (D1), mutual-exclusion with the in-progress review
  (D3), and the merged/closed-PR composer fix (D4 — the behavior half split from
  #287).
- Idempotency for the new path matching the root-comment model; optimistic inline
  render of the posted comment.
- A small additive GraphQL change to surface the numeric `databaseId` of review
  thread comments (needed for the reply REST call — see § 4.1 / Feasibility-F1).

**Out of scope (deferred — see § 11):**
- Changing the PR-root comment path (already posts immediately; it is the
  precedent, not a target).
- **Strong "no-double-post-ever" dedup** (marker + server re-fetch reconciliation).
  This slice ships the same idempotency model the root-comment path uses, which
  accepts a rare crash-before-stamp double-post. Strengthening *both* paths to
  marker-reconciliation is a single follow-up (§ 11) so they stay consistent.
- **Edit/delete** of an already-posted single comment from PRism.
- **Multi-line (range)** single comments.

## 3. Decisions (from brainstorm 2026-06-09, dedup model revised after review)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Two composer buttons:** `Add to review` (stage a draft — current) and `Comment` (post now). When a review is already in progress the first button **relabels** to `Add review comment` (see D3); it is the same action, contextual copy. | Both write paths visible and equal-weight. Rejected: split-button + menu (hides the second path). |
| D2 | **Route post-now through the local draft session** (stage draft → post → clear), not bypass it. | Reuses text-is-sacred crash-safety and the root-comment precedent. Rejected: direct post bypassing drafts (loses crash-safety, diverges from precedent). |
| D3 | **Mutual exclusion** with the in-progress review. Post-now is offered only when **no _other_ drafts are staged** (a post-now's own in-flight transient draft does not count — § 9); once another draft exists, composers show only `Add review comment` (post-now disabled, with a tooltip) until submit/discard. | **Primary rationale: state-machine simplicity** — avoids a confusing mixed live/staged state and the more complex machinery of allowing both at once. (GitHub's own UI is *approximately* this; the simplicity argument is the load-bearing one, not strict parity.) Rejected: always-allow-both. |
| D4 | **Merged/closed PR → composer shows only `Comment`** (post-now), with a short explanatory sub-label (§ 7). The `Add to review` path is suppressed. | The merged-PR UX fix folded in — composers no longer open into a futile "type → disabled Save → 'not saved' banner" void. Existing threads otherwise render read-only. (Backend premise to verify: § 7 / S1.) |
| D5 | **Optimistic inline render.** The posted comment appears in the thread instantly in a dimmed `Posting…` state; resolves to a normal comment on success; on failure it is removed and the composer reopens with the text intact + an error banner. | The issue calls for "appears inline instantly." Draft-session routing (D2) makes the failure-revert safe (text is persisted). |
| D6 | **Idempotency via stamp-then-delete** (`PostedCommentId` + `PostedBodySnapshot`), matching the root-comment path exactly. **No `prism:client-id` marker, no server re-fetch.** | Chosen over the heavier marker-reconciliation model after review showed the latter rests on an unverified marker-durability premise on the single-comment endpoint, needs a persisted breadcrumb + a third interface method + cross-assembly `internal` exposure, and introduces a 422-loss retry-loop. The simpler model is proven and proportionate; the residual rare double-post window is accepted (§ 5). |

## 4. Architecture

### 4.1 Backend (PRism.Core / PRism.GitHub / PRism.Web)

**New `IReviewSubmitter` methods** (REST via the existing `SendGitHubAsync` plumbing,
modelled on `CreateIssueCommentAsync`; the GraphQL atomic-submit pipeline is
**untouched**). These bring the interface from 8 → **10** methods — the pinned
`ContractShapeTests.IReviewSubmitter_HasEightMethods` (`ContractShapeTests.cs:42,49`)
and **all `IReviewSubmitter` test fakes** (≥6: `InMemoryReviewSubmitter`,
`FakeReviewSubmitter`, `PrDetailFakeReviewService`, the submit-test doubles, etc.)
must be updated; the plan carries this (§ 10).

- `CreateReviewCommentAsync(PrReference, ReviewCommentRequest, CancellationToken)
  → CreatedReviewCommentResult` — **new inline thread.**
  `POST /repos/{o}/{r}/pulls/{n}/comments` with `{ body, commit_id, path, line,
  side }`. `commit_id` ← `DraftComment.AnchoredSha`, `path` ← `FilePath`,
  `line` ← `LineNumber`, `side` ← `Side` (all present on a freshly composed inline
  draft, `AppState.cs:62-76`).
- `CreateReviewCommentReplyAsync(PrReference, long inReplyToCommentId, string body,
  CancellationToken) → CreatedReviewCommentResult` — **reply to an existing thread.**
  `POST /repos/{o}/{r}/pulls/{n}/comments/{inReplyToCommentId}/replies` with
  `{ body }`.

  **Reply-id source (corrects the first draft).** The numeric `databaseId` the REST
  reply endpoint needs is **not** fetched today for review-thread comments — the
  thread query selects only the opaque node `id` (`GitHubReviewService.cs:42-43`);
  `databaseId` is fetched only for conversation-level comments (`:41`). This slice
  **adds `databaseId`** to the `reviewThreads … comments` selection, surfaces it as
  a new nullable field on `ReviewCommentDto`, and plumbs it to the frontend thread
  model so the reply composer can send the anchor comment's `databaseId` as
  `inReplyToCommentId`.

`CreatedReviewCommentResult(long Id, DateTimeOffset CreatedAt)` mirrors
`CreatedIssueCommentResult`.

**New endpoint module `PrCommentEndpoints`** (mirrors `PrRootCommentEndpoints`):
- `POST /api/pr/{owner}/{repo}/{number}/comment/post` — body discriminates a new
  inline comment (carries a local `draftId`) from a reply (carries `draftId` +
  `inReplyToCommentId`). Guarded by `IsSubscribed`; shares the per-PR
  `SubmitLockRegistry` slot (post and submit cannot run concurrently → 409
  `submit-in-progress`); same sanitized `MapGithubError` mapping; same defensive
  body-cap (`PipelineMarker.GitHubReviewBodyMaxChars`, a `public const`).
- **Session-scoped draft lookup (Security-3).** The endpoint loads the session
  keyed to the URL `{owner}/{repo}/{number}` and resolves the draft **within that
  session** (`session.DraftComments`/`DraftReplies`, by `draftId`). A `draftId` that
  resolves to no draft in the keyed session is `400 no-draft`; the endpoint must
  **not** search across sessions (prevents posting PR-A's draft onto PR-B).
- The endpoint **does not** invoke the pending-review pipeline and **does not**
  create or touch a `PendingReviewId`.

### 4.2 Frontend (frontend/src)

- **Composer footer** (`InlineCommentComposer`, `ReplyComposer`): add the
  `Comment` button beside `Add to review`; apply D3/D4 button logic and the D1
  relabel.
- **Mutual-exclusion derive:** an `anyOtherDraftsStaged` selector off
  `draftSession` — true when the session has any `DraftComment`/`DraftReply`
  **other than** (a) the one this composer owns **and** (b) any draft currently
  **in-flight as a post-now** (§ 9 / Adversarial-F5). In-flight post-now drafts are
  excluded **globally**, not just for the owning composer.
- **`prState` into `CollapsedComposerAffordance`** — today it only receives
  `readOnly` (`CollapsedComposerAffordance.tsx:29`); it must also receive `prState`
  so the affordance on a merged/closed PR opens a *post-now-only* composer rather
  than the open-into-a-void composer. **Plan-time:** audit the
  `CollapsedComposerAffordance` call-sites (diff lines + the `ExistingCommentWidget`
  reply path) and confirm `prState` is available in each parent or name the
  threading needed (Scope-4).
- **Post-now action:** stage the draft via the existing autosave flush → call the
  new endpoint → on success clear the draft + optimistically render → refetch-on-save
  (#299) reconciles. On failure, revert the optimistic comment and reopen the
  composer with the persisted draft body + an error banner.
- **New API client** `api/comment.ts` (`postComment`, `postReply`).

### 4.3 State schema (PRism.Core/State/AppState.cs)

`DraftReply` (`AppState.cs:78-84`) lacks the `PostedCommentId` /
`PostedBodySnapshot` fields that `DraftComment` carries; the post-now reply
idempotency stamp needs them. **Add both to `DraftReply` as trailing nullable
defaults** — the same additive pattern `DraftComment` used for its `// V7`
additions (`AppState.cs:75-76`).

**Migration characterisation (corrects the first draft's overstatement).** These are
additive **nullable trailing-default** fields. They are read leniently — an old
`state.json` deserializes them as `null` — so there is **no data-loss migration and
no version-dispatch read path**. Follow `DraftComment`'s V7 precedent for whether to
bump `AppState.Version` (currently `7`, `AppState.cs:41`); the bump, if any, is a
convention marker, not load-bearing logic. The B2 "persisted-schema" gate flag
applies because the schema changes, but the actual migration risk is minimal.

> The earlier draft's `PostAttempted` overlay breadcrumb is **removed** — it was
> needed only by the marker-reconciliation model (D6 rejected). `SessionOverlays` is
> a static transform helper, not a store, so such a field would have had to be
> persisted anyway; the simpler model needs no breadcrumb at all.

## 5. Idempotency & the lost-response window

Mirrors the root-comment path (`PrRootCommentEndpoints.cs:109-182`) exactly. On
`POST …/comment/post`:

| Draft post-state | Behavior |
|------------------|----------|
| **Not yet posted** (`PostedCommentId` null) | Call GitHub → on success stamp `PostedCommentId` + `PostedBodySnapshot` (overlay #1) → delete the draft (overlay #2) → publish `StateChanged`. |
| **Posted, same body** (`PostedCommentId` set, snapshot == body) | Idempotent: no GitHub call, delete the draft, publish. (Covers crash *between stamp and delete*.) |
| **Posted, different body** (snapshot != body) | `409` mismatch — the draft was edited after it first posted; the user discards the local draft or edits on github.com. |

**Accepted residual window.** If the process dies **between** GitHub creating the
comment and overlay #1 stamping `PostedCommentId` (a ~tens-of-ms window), the next
post re-calls GitHub and creates a **duplicate** comment. This is the same window
the root-comment path explicitly accepts ("acceptable for this PoC",
`PrRootCommentEndpoints.cs:159-163`). For a single-user desktop tool with low post
frequency it is rare; closing it for *both* paths via marker-reconciliation is the
§ 11 follow-up.

## 6. Error handling

| Failure | Behavior |
|---------|----------|
| Network error / 5xx | Optimistic comment reverts; composer reopens with persisted text + "Couldn't post — your text is saved, try again". Draft intact (retryable). |
| 403 / 401 (token/permission) | Sanitized error banner (`MapGithubError`); draft intact. |
| 422 (GitHub validation — e.g. line no longer in diff, or merged-PR new-thread rejected per S1) | Sanitized "GitHub rejected the request as invalid"; draft intact. On a merged PR this is the dead-end S1 calls out — see § 7. |
| Body > cap | `400 body-too-large` (defensive, pre-flight). |
| Lock contention with `/submit` | `409 submit-in-progress`. |
| Already posted, body edited | `409` mismatch (§ 5). |

**Slow post (>~2s).** The `Posting…` label is supplemented by a spinner after a short
delay; no hard client timeout beyond the platform default — the dimmed optimistic
comment stays until GitHub responds or the request errors. (Design-3.)

## 7. Merged / closed PR behavior

- `prState !== 'open'` → composers (inline + reply) render **post-now only**, with a
  short sub-label near the `Comment` button — e.g. *"PR is merged — comments post
  immediately"* — so the reviewer understands why there's no `Add to review`
  (Design-5). The verdict/submit surface stays suppressed.
- Affordances (`CollapsedComposerAffordance`, the `ExistingCommentWidget` reply
  trigger) receive `prState` and open the post-now-only composer — never the
  open-into-a-void composer.
- Existing threads render read-only as today, except the post-now reply affordance.
- Backend: the new endpoint does not gate on `prState` (GitHub enforces what is
  allowed on a merged PR).

**S1 — premise to verify before/at implementation.** D4 assumes GitHub accepts a
**new inline thread** (`POST /pulls/{n}/comments`) on a *merged* PR, not just a
reply or an issue comment. This is plausible (github.com lets you comment on merged
PR diffs) but unverified here. **Plan-time check:** confirm a new-thread post
succeeds on a merged PR against the head/merge commit for a line in the final diff.
**Fallback if GitHub rejects it:** on merged PRs, suppress the *new-thread* post-now
affordance too (keep reply + PR-root, which are known-good) and surface a one-line
"comment from the Conversation tab" hint — so D4's "no void" promise never leaves
the user with an action GitHub will reject.

## 8. Naming

The post-now `Comment` **button** (composer footer) is distinct from the existing
`Comment` **verdict** (submit dialog) — different surfaces. Code names them
unambiguously: the button action is `postComment`/`postReply` (§ 4.2); the verdict
stays `DraftVerdict.Comment`. User copy: the footer button reads `Comment`; the
verdict reads `Comment` inside the submit dialog — disambiguated by context. No
shared identifier.

## 9. Edge cases / interaction states

- **Mutual exclusion vs. in-flight post-now (Coherence-2 / Adversarial-F5).** A
  post-now comment is transiently a staged draft (D2: stage → post → clear). It
  must be excluded from `anyOtherDraftsStaged` **for every composer**, not just its
  owner — otherwise a second open composer (e.g. another line's reply box) flickers
  into "review in progress" mode for the ~0.3–2s of the post. The selector keys off
  an "in-flight post-now" flag on the transient draft. **Consequence (intentional):
  concurrent post-now from two composers serialize** — the second sees the first's
  in-flight draft is excluded, so it is *not* blocked, but the shared
  `SubmitLockRegistry` slot serializes the actual posts (409 on contention, retry).
- **Discard path back from mutual-exclusion (Design-2).** When post-now is disabled
  because a review is in progress, the reviewer reaches the post-now path by either
  **submitting** or **discarding** the in-progress review. The existing submit
  dialog already owns discard (whole-review). The disabled-`Comment` tooltip names
  this path (next bullet). No new discard control is introduced.
- **Tooltip copy (Design-1).** Disabled `Comment` tooltip: *"You have a review in
  progress — submit or discard it to post a single comment."*
- **Error banner (Design-4).** Sits at the top of the reopened composer, above the
  textarea; auto-dismisses when the user edits the body or on the next post attempt.
  Reuses the inline error treatment introduced in #287 rather than a new pattern.
- **Focus on success (Design-6).** Focus moves to the newly rendered posted comment
  (or its collapsed affordance); on failure, focus returns to the textarea with the
  cursor preserved.
- **Reply when `databaseId` is absent (Design-7).** With the § 4.1 query addition
  this is rare (only a stale cached thread model). Fallback: disable the reply
  post-now with a tooltip *"Reload the page to reply"* rather than guessing an id.
- **Optimistic vs. refetched comment (Adversarial-S3).** `PostedCommentId` is
  stamped **before** the draft is deleted and `StateChanged` published (§ 5), and the
  refetch is triggered by that publish — so the optimistic placeholder and the
  refetched real comment share identity and de-dup on `PostedCommentId`. No
  double-render window.
- **Two PRism tabs.** Refetch-on-save + the existing cross-tab stamp surface the new
  comment on the other tab via the normal poll/banner path; no new cross-tab
  protocol.

## 10. Testing strategy (test-first; this is net-new behavior)

**Backend (red→green within the PR):**
- `CreateReviewCommentAsync` / `CreateReviewCommentReplyAsync` — request shape,
  success parse, non-2xx → `HttpRequestException` with status.
- `databaseId` added to the thread query → parsed onto `ReviewCommentDto`.
- Endpoint: success stamps + deletes draft + publishes; **session-scoped draftId
  lookup** (cross-session `draftId` → `400 no-draft`, Security-3); 401 unauthorized;
  409 lock-contention; 400 body-too-large; sanitized error mapping (no raw upstream
  body leak).
- Idempotency: posted-same-body → no GitHub call + draft deleted; posted-different-
  body → 409; crash-before-stamp re-post window documented (not asserted-away).
- Schema: `DraftReply` additive fields round-trip; old `state.json` reads null.
- **Contract:** update `ContractShapeTests` (8 → 10) and all `IReviewSubmitter`
  fakes.

**Frontend (vitest):**
- Composer button states (§ 3 D3/D4) incl. the D1 relabel; mutual-exclusion disable
  + tooltip; in-flight post-now excluded globally (two-composer no-flicker).
- Post-now success → draft cleared + optimistic render + focus; failure → revert +
  reopen with text + banner.
- Merged/closed: affordance opens post-now-only composer (no void) + sub-label.

**e2e (Playwright, fake review backend):**
- Post a single inline comment on an open PR (no review submitted).
- Post a single reply.
- Atomic review flow still works unchanged alongside.
- Merged-PR composer shows only `Comment`.

## 11. Out of scope / deferrals

- **Unify dedup:** strengthen *both* the inline single-comment path **and** the
  root-comment path onto marker + server re-fetch reconciliation (closes the § 5
  crash-before-stamp window consistently). One follow-up issue — file it so the
  accepted window has a closing date.
- **Edit/delete** an already-posted single comment from PRism. **Note:** once two
  write paths exist, every future comment operation (edit, delete, react) inherits a
  two-path surface — price that into the follow-up estimates (Product-5).
- **Multi-line (range)** single comments.
- Any change to the **atomic pending-review** GraphQL pipeline.

## 12. Acceptance criteria

- [ ] A reviewer can post a single **inline** comment to an open PR without
  submitting a review.
- [ ] A reviewer can post a single **reply** to an existing thread without
  submitting a review.
- [ ] The atomic pending-review flow continues to work unchanged alongside it.
- [ ] The two paths are visually and behaviorally distinct (D1 buttons + relabel;
  D3 mutual exclusion).
- [ ] Idempotency holds for the new path: a re-post of an already-posted, unchanged
  draft makes **no** new GitHub call (§ 5); the rare crash-before-stamp double-post
  window is documented and accepted (not silently claimed closed).
- [ ] On a merged/closed PR the composer offers **only** post-now with the
  explanatory sub-label; no open-into-a-void; existing threads read-only otherwise
  (D4) — subject to the S1 verification/fallback (§ 7).
- [ ] Secrets scan clean over the diff.

## 13. Risk classification (for the gate)

- **B1 (UI-visual):** `needs-design` label; composer buttons + relabel,
  mutual-exclusion states, merged-PR composer + sub-label, optimistic render — a
  human must eyeball these.
- **B2 (Reviewer-atomic submit pipeline):** adds a **second write path** for comment
  bodies alongside the GraphQL atomic submit. The atomic pipeline itself is
  untouched, but the invariant ("comments reach GitHub only via atomic submit") is
  intentionally broken — gate. **Strategic note (Product-5):** this is a deliberate
  identity bet (PRism moves from batch-only toward GitHub-equivalent commenting);
  named and owned here.
- **B2 (persisted-schema):** additive `DraftReply` nullable fields (+ possible
  `AppState.Version` convention bump). Migration risk minimal (§ 4.3).

→ **Gated.** Human reviews this spec and the plan before implementation; no
gate-substitution.

## 14. `ce-doc-review` disposition (1 pass, 2026-06-09)

Findings surfaced, with action taken. (Personas: coherence, feasibility,
product-lens, design-lens, security-lens, scope-guardian, adversarial.)

**Applied — factual corrections (the gate's core value):**
- *Feasibility-1 / reply `databaseId` not fetched for thread comments* → § 4.1 now
  adds `databaseId` to the thread query + DTO + frontend; § 9 fallback. **Applied.**
- *Adversarial-F1 / `PostAttempted` can't be a non-persisted overlay* → moot under
  the simpler model; breadcrumb removed (§ 4.3 note). **Applied.**
- *Adversarial-F3 / marker injection is net-new, not "reuse"; durability unverified*
  → marker dropped entirely (D6 simpler model). **Applied.**
- *Scope-2 / 3-new-methods breaks pinned `ContractShapeTests` + ~6 fakes* → now 2
  methods; § 4.1 + § 10 carry the contract/fakes update. **Applied.**

**Applied — design completeness (B1):** tooltip copy (Design-1, § 9); discard path
back (Design-2, § 9); slow-post spinner (Design-3, § 6); error-banner placement +
dismissal (Design-4, § 9); merged-PR sub-label (Design-5, § 7); focus behavior
(Design-6, § 9); reload-to-reply form (Design-7, § 9). **Applied.**

**Applied — correctness/coherence:** in-flight post-now excluded **globally** from
mutual-exclusion (Coherence-2 / Adversarial-F5, § 4.2/§ 9); D1 relabel made explicit
(Coherence-1, D1/D3); session-scoped `draftId` lookup (Security-3, § 4.1);
`inReplyToCommentId` GitHub-backstop noted (Security-4, implicit in § 6 422 row);
Version-bump overstatement corrected (Adversarial-F4, § 4.3); merged-PR new-thread
premise + fallback (Adversarial-S1, § 7). **Applied.**

**Applied — decision change:** dedup model strong → simple stamp-then-delete (D6,
§ 5) — owner decision after the review showed the strong model's premises were
shakier than the first draft represented. Two-tier-reliability concern (Product-2)
resolved by deferring *both* paths' strengthening to one follow-up (§ 11).
Re-justified D3 on simplicity, softened "mirrors GitHub" (Product-1). **Applied.**

**Skipped / acknowledged (no change):**
- *Product-1 reversing D3 itself* — mutual exclusion retained (simplicity holds);
  only the rationale was corrected. **Acknowledged.**
- *Security-2 marker-collision pre-flight* — **moot** (no marker injection in the
  chosen model). **Skipped.**
- *Validations (Feasibility checks-out list, Product-3/4, Adversarial-S2/S3)* — no
  action needed; confirmations the design holds. **Acknowledged.**
