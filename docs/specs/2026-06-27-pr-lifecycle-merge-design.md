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
   "Confirm …" button. Escape / click-outside cancels. No modal — stays in the Overview sticky footer.
2. **Method picker is populated from repo-allowed methods** (`mergeCommitAllowed` / `squashMergeAllowed`
   / `rebaseMergeAllowed`), fetched on the PR-detail query. The user never sees a method that would 405.
3. **Enable boundary matches GitHub** (Option X). Merge is enabled whenever GitHub would accept it —
   including `ready`, `ready-with-changes-requested`, and `unstable` (non-required checks failing). PRism
   is never *more* restrictive than the source of truth. Disabled-with-reason only when GitHub would
   reject: `conflicts`, `behind-base`, `changes-requested`, `review-required`, `blocked-by-protection`,
   or still-computing (`none`). Drafts are a separate case — the Merge affordance is **hidden** on drafts
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
  re-populates the picker from fresh allowed-methods and resolves the actual current state.

### 2. Backend endpoint — `PRism.Web`

`POST /api/pr/{owner}/{repo}/{number:int:min(1)}/merge` in `PrLifecycleEndpoints`. Same gates as
slice 1: subscribe gate (`RequireSubscribed.Check`) and `X-PRism-Tab-Id` CSRF custom-header gate.

- **Subscribe gate is PR-specific.** `RequireSubscribed.Check(cache, prRef, …)` calls
  `cache.IsSubscribed(prRef)` against the exact owner/repo/number — a crafted merge against a PR outside
  the subscribed set is rejected 403, so the held PAT can't be aimed at an arbitrary repo via this endpoint.
- **Request body DTO** (read via `ReadFromJsonAsync<MergeRequest>`, the `InboxEndpoints` pattern):
  `{ method: string, headSha: string }`.
  - `headSha` is **required**: the handler rejects null/empty with `400` before calling `MergeAsync`, so
    the staleness guard (decision #4) is never silently dropped.
  - `method` is validated against an **explicit ordinal, case-exact allowlist** `{ "merge", "squash",
    "rebase" }` (then mapped to `MergeMethod`) — **not** a permissive `JsonStringEnumConverter` bind, which
    accepts case variants and numeric strings like `"1"` (the `stj-enum-converter-permissive` gotcha) and
    would undermine the 400 contract. An unrecognized value returns `400`.
- On success → publish `PrLifecycleChanged(prRef)` → existing invalidate/SSE/reload path (header flips to
  `merged`, panel self-suppresses). Error mapping additions:

```
MergeNotMergeable → (422, "merge-not-mergeable")
MergeHeadChanged  → (409, "merge-head-changed")
```
(existing: `TokenCannotWrite` → 403 `token-cannot-write`, `RepoRuleBlocked` → 403 `repo-rule-blocked`,
`RateLimited` → 429 `rate-limited`, `Generic` → 502 `generic`.)

### 3. Repo-allowed-methods data — `PRism.GitHub` query + parser + contracts

Add to the **`PrDetailGraphQLQuery`** constant (the one feeding `GetPrDetailAsync`/`ParsePr`; not
`TimelineQuery`), on the `repository` node: `mergeCommitAllowed`, `squashMergeAllowed`,
`rebaseMergeAllowed`. These are **repository-level** fields, siblings of `pullRequest`, so they are **not
reachable from `ParsePr`** (which receives `data.repository.pullRequest`). Following the established
pattern for repo-sibling data (`viewer.login`, resolved at the `GitHubReviewService` call site from
`doc.RootElement`, not inside `ParsePr`), parse the three fields from the `data.repository` node at the
call site and thread them into the `Pr` record. New contract shape:

```csharp
public sealed record AllowedMergeMethods(bool Merge, bool Squash, bool Rebase);
// Pr gains: AllowedMergeMethods AllowedMergeMethods = new(true, true, true)  // safe default = offer all
```

The safe default is **all-three**, not merge-only: if the GraphQL fields are absent or fail to parse
(older GHES, parser miss), the picker degrades to offering everything and GitHub stays the authority via
405 — rather than silently collapsing to merge-only and 405-ing on a squash-only repo.

Threaded to `PrDetailPr` (frontend `types.ts`) as `allowedMergeMethods: { merge, squash, rebase }`.
**Default-selection rule:** first allowed in order merge → squash → rebase.

### 4. Frontend

- **`prLifecycle.ts`** — add `mergePr(prRef, method, headSha)` → `POST {prPath}/merge`. Extend
  `PrLifecycleErrorCode` with `'merge-not-mergeable'` and `'merge-head-changed'`.
- **`types.ts`** — `PrDetailPr.allowedMergeMethods` is optional; when absent or with no `true` flags, the
  panel **defaults to all-three** (`{ merge: true, squash: true, rebase: true }`), mirroring the backend
  default so the picker always has methods to offer. This is the frontend half of the compose-to-offer-all
  fallback referenced in §3.
- **`usePrAction.ts`** —
  - `PrActionKind` gains `'merge'`; `PrLifecycleState` gains `isMerged`; `reachedTarget('merge', s) = s.isMerged`.
  - `invoke('merge', { method, headSha })` (other kinds ignore the payload).
  - **`isMerged`-true short-circuit** is kept as defense-in-depth (e.g., a stale closure invoking after a
    state change), **not** as the concurrent-tab safeguard: `showMerge` (below) already removes the only
    caller the instant `isMerged` flips, so the real concurrent-confirm race is handled by the reconcile
    paths, not this guard. The doc does not claim otherwise.
  - **Reconcile window — one constant for all merge paths.** Define `MERGE_RECONCILE_MS = 10_000` (vs
    slice-1's 5s), sized to cover commit-creation + GitHub GraphQL read-after-write propagation. The
    happy-path SSE→reload, the SSE-drop fallback, and the error-path `isMerged` re-checks all use this same
    window, so a single slow-propagation event can't make one path succeed while another false-fails.
    (Tunable; B2 live validation confirms it covers observed propagation.)
  - **Success / fallback:** on the 200, hold `pending` until `isMerged` flips true via SSE→reload. The
    SSE-drop fallback does **not** blanket-release/error: it `reload()`s and re-checks `isMerged`; if still
    false after the window, it shows the *still-finishing* state (below), not an error.
  - **Error handling that reconciles before failing** (mirrors #636 `superseded`):
    - On `merge-head-changed` (409): `reload()` to refresh `headSha`, collapse the armed state to unarmed.
      **Re-confirm is gated on `headSha` having actually changed** from the value that 409'd — if the
      reload failed or the head is unchanged, surface a distinct transient "couldn't refresh — try again"
      state rather than re-enabling Confirm against the same stale `headSha` (which would loop 409 forever).
    - On `merge-not-mergeable` (405/422): drop the merge-in-flight spinner and show a neutral **"Checking…"**
      state (distinct from the merge spinner) while `reload()` + the `isMerged` re-check (using
      `MERGE_RECONCILE_MS`) run. If `isMerged` is now true (the merge actually succeeded but the UI missed
      it), reconcile to **success**. Otherwise collapse to unarmed and toast; the button re-evaluates and
      likely shows disabled-with-reason because mergeability changed.
    - Other codes (`token-cannot-write`, `repo-rule-blocked`, `rate-limited`, `generic`) keep the slice-1
      immediate-release + actionable toast.
  - **Still-finishing state** (fallback fired, `isMerged` still false): a non-blocking snackbar
    ("The merge may still be processing — refresh if the status doesn't update") — explicitly **not** the
    `merge-not-mergeable` error toast — and the Merge button returns to unarmed/enabled for a manual retry.
- **`PrActionsPanel.tsx`** —
  - `showMerge = !pr.isClosed && !pr.isMerged && !pr.isDraft`. Merge is **hidden** on drafts (mark ready
    first, via the existing `showReady` affordance) — matching GitHub.
  - Enable per Option X (decision #3): enabled for `ready`, `ready-with-changes-requested`, `unstable`;
    disabled-with-reason for `conflicts`, `behind-base`, `changes-requested`, `review-required`,
    `blocked-by-protection`, `none`.
  - **Disabled-reason surface:** a **visible inline text node** below the Merge button, with
    `aria-describedby` on the button pointing at it (not an HTML `title`, invisible to keyboard/SR). For
    `conflicts` / `behind-base` / `changes-requested` / `review-required` / `blocked-by-protection` it
    reuses the `mergeReadiness` `READINESS_LONG`/`READINESS_TOOLTIP` copy. **`none` has no reusable copy**
    (`READINESS_LONG['none']` / `READINESS_TOOLTIP['none']` are empty strings), so the panel supplies its
    own string: **"Mergeability is still being calculated — Refresh"**, where **Refresh** is an inline link
    calling `usePrDetail.reload()` (no background poll).
  - **Selected-method state lives in `PrActionsPanel`** (not transient inside `MergeMethodPicker`), so the
    user's choice survives an armed-state collapse (e.g., a 409 retry) and re-arms at their prior selection
    rather than silently resetting to the positional default — important because a reset-to-default on an
    irreversible action could produce a merge commit when the user chose squash.
  - **Confirm button label always names the selected method** — "Confirm merge commit" / "Confirm squash
    merge" / "Confirm rebase merge" — in **both** the multi-method and single-method cases. The button is
    self-describing, so a user who arms-and-confirms quickly still sees what will happen; this also
    mitigates the positional-default risk (Known limitations).
  - Armed state (reusing the Close two-step morph): arm → reveal `<MergeMethodPicker>` (allowed methods,
    default selected; **suppressed when only one method is allowed** — see below) + the method-named Confirm
    button → on confirm call `invoke('merge', { method, headSha: pr.headSha })`.
    - When `mergeReadiness === 'unstable'`, the armed/confirm state renders a non-blocking note
      ("Non-required checks are failing") **referenced by `aria-describedby` on the Confirm button**, so a
      keyboard/SR user hears "Confirm … — Non-required checks are failing" before activating — otherwise the
      "confirm informed" intent is invisible to SR. Matches GitHub's "merge anyway."
  - **In-flight disable scope** covers the Confirm button **and** the `MergeMethodPicker` (same
    `pending !== null || isLoading` guard, `aria-disabled` + visual dim) so the selection can't change
    mid-request.
- **`MergeMethodPicker.tsx`** (new) — custom radio / segmented control (NOT native `<select>`).
  - **Single-allowed-method degenerate case:** when exactly one method is allowed, the picker renders
    **nothing**; the method is conveyed entirely by the Confirm button's label ("Confirm squash merge").
    No sibling label node — one focusable, self-describing element. A one-option radio group is a false
    affordance.
  - **Accessibility / keyboard contract:** container `role="radiogroup"` + `aria-label="Merge method"`;
    each option `role="radio"` + `aria-checked`. Arrow-left/right navigates and commits selection (roving
    `tabindex`); `Tab` moves focus out to the Confirm button, not between options; `Escape` inside the
    picker forwards to the armed-state dismiss (collapse arm, return focus to the Merge button).

### 4a. Accessibility & focus contract (cross-cutting)

A single `aria-live="polite"` region **outside** `PrActionsPanel` (so it survives the panel's unmount)
hosts the lifecycle announcements. On every observed transition to `isMerged === true` — **whether via
direct success or the error-path reconcile** — the flow is: (1) write "Pull request merged" into the live
region; (2) on the next animation frame, move focus to a stable landmark (the PR title heading /
PR-detail container). Announcing before the focus move prevents the SR from clobbering the confirmation
with the newly-focused element's label.

Focus landing on other transitions:
- **On arm:** focus moves to the default-selected picker option (multi-method) or to the Confirm button
  (single-method, no picker).
- **On the `none`-state Refresh link:** if `reload()` moves mergeability off `none` (the reason block
  unmounts), focus moves to the now-re-evaluated Merge button; if it stays `none`, the Refresh link stays
  mounted and focus stays put.

## Error handling

All failures route through the slice-1 error-toast treatment in `usePrAction` with actionable copy keyed
on `PrLifecycleErrorCode`, **after** the reconcile-before-toast checks in §4 (the two merge codes
reload-and-recheck `isMerged` within `MERGE_RECONCILE_MS` before deciding success vs failure). The server
remains the final authority: even when the button was enabled, a stale-mergeability race surfaces as
`merge-head-changed` / `merge-not-mergeable` and is reconciled, never a silent wrong-merge. Error copy:
- `merge-head-changed` → "the PR changed since you loaded it — re-arm to retry with the latest."
- `merge-not-mergeable` → "this PR can't be merged right now (checks, protection, or method changed)."

## Testing

**Backend**
- `GitHubPrLifecycleWriterTests`: merge request shape (URL, `merge_method`, `sha` present); classification
  of 200 / 405 / 409 / 403-protected / 403-default / 422 / 429.
- `PrLifecycleEndpointsTests`: merge success + `PrLifecycleChanged` published; error-code → status/body
  mapping for the two new codes; **`headSha` missing/empty → 400**; **invalid `method` (incl. wrong-case
  "Merge" and "1") → 400** (asserts the allowlist, not the permissive enum bind); tab-id gate; subscribe
  gate (PR-specific reject).
- `GitHubReviewService`/parser test: the three allowed-method fields parse into `Pr.AllowedMergeMethods`
  from the `data.repository` node; **absent fields → all-three default**.
- **`GraphQlByteIdentityTests`** pin: adding the three fields changes the query bytes — update the pinned
  expectation in the same PR (intentional query change).

**Frontend**
- `usePrAction.test.ts`: merge reconcile releases on `isMerged` flip; fallback within `MERGE_RECONCILE_MS`
  reloads-and-rechecks (success-if-merged, still-finishing snackbar otherwise, never error on the happy
  path); `merge-head-changed` reloads + collapses + gates re-confirm on a changed `headSha`;
  `merge-not-mergeable` shows "Checking…" then reconciles to success when `isMerged` flipped else toasts.
- `PrActionsPanel` test: gating per readiness (enabled vs disabled-with-reason sets, incl.
  `changes-requested`/`review-required`); hidden on draft; disabled-reason is a visible node with
  `aria-describedby`; `none` shows the explicit "calculating" copy + Refresh link; `unstable` note is
  `aria-describedby`-linked to Confirm; Confirm label names the selected method; selected method survives
  an armed-collapse; picker + Confirm both disabled while pending.
- `MergeMethodPicker` test: renders allowed subset; single-allowed → no picker (label on the button);
  `role="radiogroup"`/`role="radio"`/`aria-checked`; arrow-key selection; Escape forwards to dismiss.

**Live validation (B2 gate — first irreversible GitHub merge write)**
- Against a mergeable sandbox PR (`prpande/prism-sandbox` #2 or #10), exercise the full flow in the
  running app: arm → pick method → confirm → observe header reconcile to `merged` and panel suppression.
  Per [[reference_live_validate_real_pr_in_running_app]]. Verify the **default merge-commit title** GitHub
  produced is acceptable (no recovery path after merge). A live merge consumes the sandbox PR; recreate a
  fixture by opening a trivial PR in `prpande/prism-sandbox` (e.g., a one-line commit on a new branch →
  `gh pr create`) before re-running.

## Gates

- **B1 (UI-visual):** the panel's merge affordance + method picker, **both themes**, demonstrating at
  minimum: armed with multiple allowed methods, armed with a single allowed method (method-named button,
  no picker), disabled-with-reason (one example), the `none` calculating+Refresh state, the `unstable`
  failing-checks note, and the in-flight state.
- **B2 (auth/PAT + irreversible write):** live merge against a real PR with a write-scoped PAT;
  `token-cannot-write` surfaced cleanly on an under-scoped token; default commit title verified.

## Known limitations / residual

- **Positional method default may not match team convention.** The picker pre-selects the first allowed
  method (merge → squash → rebase), mirroring GitHub's own default bias. GitHub's GraphQL exposes no
  per-repo "default merge method" field to honor, so this is accepted; the mitigation is the two-step
  confirm **plus** the method-named Confirm button (the button always says which method will run). Revisit
  if GitHub adds a default-method field.
- **Head branch not deleted on repos without auto-delete.** Branch cleanup is deferred to the GitHub repo
  setting (out of scope). On repos with auto-delete off, an in-app merge leaves the head branch behind with
  no in-app remedy or signal. Accepted for this slice.
- **Rapidly-moving head.** On a PR receiving frequent pushes, the 409 → reload → re-arm cycle is correct
  per attempt but has no backoff or "head is moving" signal, so a reviewer can be stuck re-arming as each
  retry races a new push. Accepted (any merge UI, GitHub's included, shares this); no backoff this slice.
- **Mergeability stuck at `none`.** If GitHub never resolves `mergeStateStatus` (transient backend stall),
  the Refresh link can be clicked indefinitely with no timeout/escalation. Accepted; the user can fall back
  to github.com. No auto-escalation this slice.
