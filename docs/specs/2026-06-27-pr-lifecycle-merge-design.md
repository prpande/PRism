# #566 Slice 2 — Merge PR lifecycle action

**Issue:** [#566](https://github.com/prpande/PRism/issues/566) — PR detail: support GitHub lifecycle actions.
**Status of #566:** OPEN. Slice 1 (Close / Reopen / Mark-ready / Convert-to-draft) shipped via PR #649.
This slice adds the remaining action: **Merge**.

## Goal

Let a reviewer merge a PR from the PRism PR-detail screen, with a merge-method choice restricted to
what the repository allows, explicit two-step confirmation, mergeability-aware gating, and reconciled
state — without leaving the app. Merge is the most irreversible lifecycle action, so the design errs
toward "confirm the right PR, with the right method, that hasn't changed under you," and treats the
**reconcile and error paths as first-class** (merge has real server latency and race windows that the
instant slice-1 flips did not).

## Design decisions (settled in brainstorming)

1. **Affordance: inline two-step in `PrActionsPanel`** (extends the slice-1 Close pattern). The "Merge"
   button arms in place; the armed state reveals an allowed-method picker (default pre-selected) plus a
   "Confirm merge" button. Escape / click-outside cancels. No modal — stays in the Overview sticky footer.
2. **Method picker is populated from repo-allowed methods** (`mergeCommitAllowed` / `squashMergeAllowed`
   / `rebaseMergeAllowed`), fetched on the PR-detail query. The user never sees a method that would 405.
3. **Enable boundary matches GitHub** (Option X). Merge is enabled whenever GitHub would accept it —
   including `unstable` (non-required checks failing) and `ready-with-changes-requested`. PRism is never
   *more* restrictive than the source of truth. Disabled-with-reason only when GitHub would reject:
   `conflicts`, `behind-base`, `changes-requested`, `review-required`, `blocked-by-protection`, or
   still-computing (`none`). Drafts are a separate case — the Merge affordance is **hidden** on drafts
   (see §4), not disabled, matching GitHub's "Ready for review" swap.
   - *On `behind-base` not violating Option X:* GitHub reports `mergeStateStatus = BEHIND` only when the
     base requires the head to be up to date (the "require branches to be up to date" protection). When
     that protection is off, a behind head reports `CLEAN`/`UNSTABLE`, not `BEHIND`. So `BEHIND` ⟹ GitHub
     blocks the merge until the branch updates — disabling on `behind-base` stays consistent with X.
4. **Head-SHA staleness guard.** The merge call passes the head SHA PRism rendered as `sha`. If the head
   moved since load, GitHub returns 409 and we surface a reload-and-retry path (see §4 / Error handling)
   rather than silently merging commits the reviewer never saw. Mirrors the #636 `superseded` guard. The
   guard is **mandatory at the HTTP boundary** — the endpoint rejects a missing/empty `headSha` with 400
   (see §2) so the guard can't be bypassed by a direct caller.
5. **No commit-message editing.** GitHub's default commit title/message is used (issue out-of-scope).
6. **Method picker extracted into a `MergeMethodPicker` subcomponent** so `PrActionsPanel` orchestration
   stays readable; panel keeps owning the arm/confirm/gating logic.

## Out of scope (this slice)

- Auto-merge / merge-when-ready queueing.
- Editing the merge commit message body.
- Branch deletion on merge (GitHub repo setting handles it — see Known limitations for the residual case).
- Run-level / context-menu merge entry points.

## Architecture — extending the slice-1 seam

The slice-1 seam (endpoint → `IPrLifecycleWriter` → `PrLifecycleChanged` → `PrDetailLoader.Invalidate`
→ SSE `pr-lifecycle-changed` → `useLifecycleChangedSubscriber` → `usePrDetail.reload()`) is reused
verbatim. Merge plugs into it as one more action; the net-new substrate is (a) the merge write,
(b) two new error codes + their reconcile handling, and (c) repo-allowed-method data on the PR-detail query.

### 1. Backend write seam — `PRism.Core` / `PRism.GitHub`

Extend `IPrLifecycleWriter`:

```csharp
Task<PrLifecycleResult> MergeAsync(
    PrReference reference, MergeMethod method, string? expectedHeadSha, CancellationToken ct);
```

New enum `MergeMethod { Merge, Squash, Rebase }` (in `PRism.Core`, mapped to the GitHub
`merge_method` wire values `"merge"` / `"squash"` / `"rebase"`). The writer keeps `expectedHeadSha`
nullable for internal flexibility; the HTTP boundary (§2) guarantees it is non-empty in practice.

`GitHubPrLifecycleWriter.MergeAsync`:
- Issues **REST** `PUT /repos/{o}/{r}/pulls/{n}/merge` with JSON body
  `{ "merge_method": <method>, "sha": <expectedHeadSha> }` (`sha` omitted when null).
  REST matches the slice-1 close/reopen path; no `commit_title` / `commit_message` override.
- Classifies the response (`ClassifyMergeFailure`):

  | HTTP | Body signal | `PrLifecycleErrorCode` |
  |------|-------------|------------------------|
  | 200 | — | `None` (success) |
  | 405 | "not mergeable" | `MergeNotMergeable` |
  | 409 | "Head branch was modified" / sha mismatch / conflict | `MergeHeadChanged` |
  | 403 | "Protected branch" / rule | `RepoRuleBlocked` |
  | 403 | (default) | `TokenCannotWrite` |
  | 422 | required checks / validation | `MergeNotMergeable` |
  | 429 / 403 "rate limit"/"abuse" | — | `RateLimited` |
  | else | — | `Generic` |

  New `PrLifecycleErrorCode` values: `MergeNotMergeable`, `MergeHeadChanged`.

  *405 ambiguity note:* GitHub also returns 405 when the requested `merge_method` is not allowed (allowed
  methods went stale between load and confirm). Because §2 requires the picker only offers repo-allowed
  methods, this is unlikely, but the `merge-not-mergeable` user copy is phrased to cover both ("this PR
  can't be merged right now") rather than asserting a specific cause; the FE reload-and-recheck (§4)
  resolves the actual current state.

### 2. Backend endpoint — `PRism.Web`

`POST /api/pr/{owner}/{repo}/{number:int:min(1)}/merge` in `PrLifecycleEndpoints`. Same gates as
slice 1: subscribe gate (`RequireSubscribed.Check`) and `X-PRism-Tab-Id` CSRF custom-header gate.

- **Subscribe gate is PR-specific.** `RequireSubscribed.Check(cache, prRef, …)` calls
  `cache.IsSubscribed(prRef)` against the exact owner/repo/number — a crafted merge against a PR outside
  the subscribed set is rejected 403, so the held PAT can't be aimed at an arbitrary repo via this endpoint.
- **Request body DTO:** `{ method: "merge"|"squash"|"rebase", headSha: string }`.
  - `headSha` is **required**: the handler rejects null/empty with `400` before calling `MergeAsync`, so
    the staleness guard (decision #4) is never silently dropped.
  - `method` is **validated against `MergeMethod`** at the model-binding/allowlist layer; an unrecognized
    value returns `400` rather than being forwarded verbatim to GitHub.
- On success → publish `PrLifecycleChanged(prRef)` → existing invalidate/SSE/reload path (header flips to
  `merged`, panel self-suppresses). Error mapping additions:

```
MergeNotMergeable → (422, "merge-not-mergeable")
MergeHeadChanged  → (409, "merge-head-changed")
```
(existing: `TokenCannotWrite` → 403 `token-cannot-write`, `RepoRuleBlocked` → 403 `repo-rule-blocked`,
`RateLimited` → 429 `rate-limited`, `Generic` → 502 `generic`.)

### 3. Repo-allowed-methods data — `PRism.GitHub` query + parser + contracts

Add to the PR-detail GraphQL query (`GitHubReviewService` query string), on the `repository` node:
`mergeCommitAllowed`, `squashMergeAllowed`, `rebaseMergeAllowed`. These are **repository-level** fields,
siblings of `pullRequest`, so they are **not reachable from `ParsePr`** (which receives
`data.repository.pullRequest`). Following the established pattern for repo-sibling data (`viewer.login`,
resolved at the `GitHubReviewService` call site, not inside `ParsePr`), parse the three fields from the
`data.repository` node at the call site and thread them into the `Pr` record. New contract shape:

```csharp
public sealed record AllowedMergeMethods(bool Merge, bool Squash, bool Rebase);
// Pr gains: AllowedMergeMethods AllowedMergeMethods = new(true, true, true)  // safe default = offer all
```

The safe default is **all-three**, not merge-only: if the GraphQL fields are absent or fail to parse
(older GHES, parser miss), the picker degrades to offering everything and GitHub stays the authority via
405 — rather than silently collapsing to merge-only and 405-ing on a squash-only repo. This composes with
the frontend's "none flagged → offer all" fallback (§4) instead of contradicting it.

Threaded to `PrDetailPr` (frontend `types.ts`) as `allowedMergeMethods: { merge, squash, rebase }`.
**Default-selection rule:** first allowed in order merge → squash → rebase.

### 4. Frontend

- **`prLifecycle.ts`** — add `mergePr(prRef, method, headSha)` → `POST {prPath}/merge`. Extend
  `PrLifecycleErrorCode` with `'merge-not-mergeable'` and `'merge-head-changed'`.
- **`usePrAction.ts`** —
  - `PrActionKind` gains `'merge'`; `PrLifecycleState` gains `isMerged`; `reachedTarget('merge', s) = s.isMerged`.
  - `invoke('merge', { method, headSha })` (other kinds ignore the payload).
  - **Short-circuit:** if `pr.isMerged` is already true, `invoke('merge')` no-ops (covers a second tab /
    double observation).
  - **Reconcile + fallback tuned for merge** (merge has commit-creation + GraphQL read-after-write
    propagation latency, unlike the instant slice-1 flips):
    - On success response, hold `pending` until `isMerged` flips true via the SSE→reload path.
    - The SSE-drop fallback for merge does **not** blanket-release/error. It runs `reload()` and re-checks
      `isMerged`; it only releases-as-success if merged, and only surfaces a soft "still finishing — refresh"
      state otherwise. The fallback window is lengthened for merge (≥ the slice-1 5s, sized for merge
      latency) so the happy path doesn't trip it.
  - **Error handling that reconciles before failing** (mirrors #636 `superseded`):
    - On `merge-head-changed` (409): trigger `reload()` so the panel re-renders with the fresh `headSha`,
      collapse the armed state to unarmed, and toast "the PR changed since you loaded it — re-arm to retry
      with the latest." The retry then sends the *new* head SHA. Never re-enable Confirm against the stale
      `headSha` (that loops 409 forever).
    - On `merge-not-mergeable` (405/422): `reload()` and re-check `isMerged` first — if the PR is now
      merged (the merge actually succeeded but the UI missed it), reconcile to **success**, not error.
      Otherwise collapse to unarmed; the button re-evaluates and likely shows disabled-with-reason because
      mergeability changed. Toast only after the isMerged re-check rules out success.
    - Other codes (`token-cannot-write`, `repo-rule-blocked`, `rate-limited`, `generic`) keep the slice-1
      immediate-release + actionable toast.
- **`PrActionsPanel.tsx`** —
  - `showMerge = !pr.isClosed && !pr.isMerged && !pr.isDraft`. Merge is **hidden** on drafts (mark ready
    first, via the existing `showReady` affordance) — matching GitHub, which replaces Merge with "Ready
    for review" on drafts.
  - Enable per Option X (decision #3): enabled for `ready`, `ready-with-changes-requested`, `unstable`;
    disabled-with-reason for `conflicts`, `behind-base`, `changes-requested`, `review-required`,
    `blocked-by-protection`, `none`.
  - **Disabled-reason surface:** a **visible inline text node** below the Merge button (reusing the
    `mergeReadiness` `READINESS_TOOLTIP`/`READINESS_LONG` copy), with `aria-describedby` on the button
    pointing at it — not an HTML `title` (invisible to keyboard/SR users). A `title` may be additive but
    is not the primary surface.
  - **Computing (`none`) state:** GitHub computes mergeability asynchronously and emits no
    `pr-lifecycle-changed` event when it finishes, so the button would otherwise stay disabled until a
    manual page reload. The disabled reason for `none` is actionable and includes an inline **Refresh**
    link that calls `usePrDetail.reload()` (no background poll).
  - Armed state (reusing the Close two-step morph): arm → reveal `<MergeMethodPicker>` (allowed methods,
    default selected) + "Confirm merge" → on confirm call `invoke('merge', { method, headSha: pr.headSha })`.
    - When `mergeReadiness === 'unstable'`, the armed/confirm state renders a non-blocking note
      ("Non-required checks are failing") so the user confirms informed — matching GitHub's "merge anyway."
  - **In-flight disable scope** covers both the Confirm button **and** the `MergeMethodPicker` (the picker
    is disabled, `aria-disabled` + visual dim, by the same `pending !== null || isLoading` guard) so the
    selection can't change mid-request.
  - **Focus on success unmount:** before the panel suppresses on merge success, move focus to a stable
    landmark (PR title heading / PR-detail container), and follow the in-flight "Merging pull request…"
    `sr-only` announcement with a "Pull request merged" announcement — so keyboard/SR users aren't dropped
    to `body` with no context after the most consequential action.
  - **Armed-state disposition on error** (both new codes): collapse to unarmed (per the `usePrAction`
    error handling above); the user re-arms to retry, which forces re-reading the current PR state.
- **`MergeMethodPicker.tsx`** (new) — custom radio / segmented control (NOT native `<select>`, per
  design-system rules), controlled value + onChange.
  - **Single-allowed-method degenerate case:** when exactly one method is allowed, suppress the picker and
    render the single method as a static label inline with Confirm (e.g., "Confirm squash merge"); still
    pass the method to `invoke`. A one-option radio group is a false affordance and wastes footer space.
  - **Accessibility / keyboard contract:** container `role="radiogroup"` + `aria-label="Merge method"`;
    each option `role="radio"` + `aria-checked`. Arrow-left/right navigates and commits selection (roving
    `tabindex`); `Tab` moves focus out to "Confirm merge", not between options; `Escape` inside the picker
    forwards to the armed-state dismiss (collapse arm, return focus to the Merge button).

## Error handling

All failures route through the slice-1 error-toast treatment in `usePrAction` with actionable copy keyed
on `PrLifecycleErrorCode`, **after** the reconcile-before-toast checks in §4 (the two merge codes
reload-and-recheck `isMerged` before deciding success vs failure). The server remains the final authority:
even when the button was enabled, a stale-mergeability race surfaces as `merge-head-changed` /
`merge-not-mergeable` and is reconciled, never a silent wrong-merge. Error copy:
- `merge-head-changed` → "the PR changed since you loaded it — re-arm to retry with the latest."
- `merge-not-mergeable` → "this PR can't be merged right now (checks, protection, or method changed)."

## Testing

**Backend**
- `GitHubPrLifecycleWriterTests`: merge request shape (URL, `merge_method`, `sha` present); classification
  of 200 / 405 / 409 / 403-protected / 403-default / 422 / 429.
- `PrLifecycleEndpointsTests`: merge success + `PrLifecycleChanged` published; error-code → status/body
  mapping for the two new codes; **`headSha` missing/empty → 400**; **invalid `method` → 400**; tab-id
  gate; subscribe gate (PR-specific reject).
- `GitHubReviewService`/parser test: the three allowed-method fields parse into `Pr.AllowedMergeMethods`
  from the `data.repository` node; absent fields → all-three default.
- **`GraphQlByteIdentityTests`** pin: adding the three fields changes the query bytes — update the pinned
  expectation in the same PR (intentional query change).

**Frontend**
- `usePrAction.test.ts`: merge reconcile releases on `isMerged` flip; merge fallback reloads-and-rechecks
  (success-if-merged, soft state otherwise) and does not error on the happy path; `merge-head-changed`
  triggers `reload()` + unarmed collapse; `merge-not-mergeable` reconciles to success when `isMerged`
  flipped, else toasts; `isMerged`-already short-circuit.
- `PrActionsPanel` test: gating per readiness (enabled vs disabled-with-reason sets, including
  `changes-requested`/`review-required` disabled); hidden on draft; disabled-reason is a visible node with
  `aria-describedby`; `none` shows the Refresh link; `unstable` shows the failing-checks note; picker +
  Confirm both disabled while pending; two-step confirm calls `invoke('merge', {method, headSha})`.
- `MergeMethodPicker` test: renders allowed subset; single-allowed → static label (no radio group);
  `role="radiogroup"`/`role="radio"`/`aria-checked`; arrow-key selection; Escape forwards to dismiss.

**Live validation (B2 gate — first irreversible GitHub merge write)**
- Against a mergeable sandbox PR (`prpande/prism-sandbox` #2 or #10), exercise the full flow in the
  running app: arm → pick method → confirm → observe header reconcile to `merged` and panel suppression.
  Per [[reference_live_validate_real_pr_in_running_app]]. Verify the **default merge-commit title** GitHub
  produced is acceptable (no recovery path after merge). Note: a live merge consumes the sandbox PR;
  recreate a mergeable fixture if needed.

## Gates

- **B1 (UI-visual):** the panel's merge affordance + method picker, **both themes**, demonstrating at
  minimum: armed with multiple allowed methods, armed with a single allowed method (static label),
  disabled-with-reason (one example), the `unstable` failing-checks note, and the in-flight state.
- **B2 (auth/PAT + irreversible write):** live merge against a real PR with a write-scoped PAT;
  `token-cannot-write` surfaced cleanly on an under-scoped token; default commit title verified.

## Known limitations / residual

- **Positional method default may not match team convention.** The picker pre-selects the first allowed
  method (merge → squash → rebase), mirroring GitHub's own default bias. On a repo that allows multiple
  methods but conventionally squashes, a reviewer who arms-then-quickly-confirms could produce an unwanted
  merge commit. GitHub's GraphQL does not expose a per-repo "default merge method" field to honor, so this
  is accepted; the two-step confirm + visible selected method is the mitigation. Revisit if GitHub adds a
  default-method field.
- **Head branch not deleted on repos without auto-delete.** Branch cleanup is deferred to the GitHub repo
  setting (out of scope). On repos with auto-delete off, an in-app merge leaves the head branch behind with
  no in-app remedy or signal. Accepted for this slice.
