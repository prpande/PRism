# Resolve / Unresolve review-comment threads from the diff (#571)

- **Issue:** [#571](https://github.com/prpande/PRism/issues/571)
- **Tier / Risk:** T3 · gated (B1 UI + B2 risk-surface: net-new GitHub write path + PAT scope)
- **Sibling:** [#566](https://github.com/prpande/PRism/issues/566) (PR lifecycle actions) — shipped the reusable write-path foundation this feature plugs into.
- **Status:** spec gate PASSED (2026-07-03) — approved to plan; auth binding (§5.4) locked to **BIND**. Incorporates one round of `ce-doc-review` (feasibility, coherence, adversarial, security, design-lens, scope-guardian); dispositions recorded in the PR.

## 1. Problem

In the Files-tab diff, inline review-comment threads (`ExistingCommentWidget`) already *show* whether a
thread is resolved — `thread.isResolved` drives the `comment-thread--resolved` style and the collapsed
summary — but the state is **read-only**. To resolve an active thread or re-activate (unresolve) a resolved
one, the reviewer must leave PRism for github.com. This feature adds **Resolve** and **Unresolve** actions
directly on the thread widget.

Resolve/unresolve are **GraphQL-only** on GitHub (`resolveReviewThread` / `unresolveReviewThread`); REST has
no thread-resolution endpoint. They are keyed by the thread's opaque GraphQL node ID.

## 2. What already exists (grounding — so we build the delta, not the whole thing)

Three things the issue *assumes need building* are already in place:

1. **The thread node ID is on the wire end-to-end.** The `reviewThreads` GraphQL query already selects
   `id` and `isResolved` (`PRism.GitHub/GitHubReviewService.cs:53`); the parser maps `id → ThreadId`
   (`PRism.GitHub/GitHubPrParser.cs:212,243`); it serializes as `threadId`
   (`PRism.Core.Contracts/ReviewThreadDto.cs`) and reaches the frontend as `ReviewThreadDto.threadId`
   (`frontend/src/api/types.ts:327`), form `PRRT_…`. It is the exact input the mutations take, and it is
   already reused as `parentThreadId` when posting replies. **No DTO change is needed.**
2. **Collapse-on-resolve already exists — with one caveat.** `effectiveCollapsed(overrides, threadId,
   isResolved) = overrides[threadId] ?? isResolved` (`frontend/src/components/PrDetail/FilesTab/FilesTab.tsx:85`)
   means a resolved thread **defaults to collapsed** — the one-line summary (`ThreadDisclosureHeader`
   collapsed state). Flipping `isResolved` gets the fold for free **only when the user has not manually
   toggled that thread's disclosure**: a `overrides[threadId]` entry (set on any manual toggle,
   `FilesTab.tsx:93`) *shadows* `isResolved`. The reconcile therefore must clear that override on a
   confirmed resolve/unresolve — see §6.3 and the adversarial finding it closes.
3. **The #566 write-path foundation is reusable** and was explicitly left as the template
   (`PRism.Core/IPrLifecycleWriter.cs:8-11`: *"#571 mirrors the pattern on its own interface for thread
   resolve/unresolve"*; `frontend/src/hooks/useLifecycleChangedSubscriber.ts:13`: *"#571 reuses the shape"*).

Two things the issue *assumes* that do **not** hold, and shape the design:

- **There is no proactive PAT-scope capability check** — #566 deliberately declined it
  (`docs/specs/2026-06-26-pr-lifecycle-actions-slice1-design.md:44`): a probe is dead code for classic
  `repo` tokens and can't predict branch-protection or fine-grained 403s. **#571 handles scope reactively**,
  the same way.
- **#566's reconcile is a full PR-detail reload** on the invalidate→SSE seam. Correct for a whole-PR
  lifecycle change; heavier than necessary for a single-thread resolve. See §7 for how we handle this
  (mirror it now; a lighter targeted reconcile is a tracked deferral).

## 3. Goals / non-goals

### Goals
- Resolve an active thread and unresolve a resolved thread from the Files-tab diff.
- Confirm-then-apply UX: the control shows an inline spinner while the mutation is in flight; the thread
  state changes only after the write is confirmed. No optimistic flip, no rollback.
- Persist the new state across snapshot refreshes (explicit cache invalidation) and propagate to other open
  tabs via SSE without a manual reload.
- Reactive, **code-disambiguated** failure surface (full-width inline error banner in the thread column) for
  the two distinct 403s (lost-write-lock vs token-can't-write) and network failures.
- Accessible parity with the sibling `PrActionsPanel`: focus management across the pending/fold transitions
  and a live-region announcement of the in-flight action.
- GitHub-faithful placement/appearance (see §6), validated against the approved real-token mockup.

### Non-goals (first cut)
- Bulk "resolve all" actions. *(issue out-of-scope)*
- Auto-resolve heuristics. *(issue out-of-scope)*
- A combined **"Comment & resolve"** button — GitHub uses separate adjacent buttons; the "comment then
  resolve" workflow is served by clicking Comment, then Resolve. *(design decision — §9)*
- A **proactive** PAT-scope capability check — reactive only, per #566. *(§2)*
- One-click Unresolve from the collapsed summary — Unresolve is reached by expanding (GitHub-faithful; keeps
  the collapsed header a single click-to-expand target). *(§6.1)*
- The lighter **targeted-patch reconcile** (button releases on the mutation response + a confirmed
  per-thread flip, avoiding a full reload). Deferred; see §7 and §11.
- Reconciling the imported-drafts `IsResolved` preflight (`ImportedDraftsBanner`) against a later
  diff-resolve. Verified safe to defer (§8); tracked in §11.

## 4. Acceptance criteria

1. From an **active** thread, clicking **Resolve conversation** issues the GraphQL mutation; on confirmation
   the thread flips to resolved and folds to the collapsed summary — **including threads the user had
   manually toggled** (the reconcile clears the stale collapse override, §6.3).
2. From a **resolved** thread (expanded), clicking **Unresolve conversation** re-activates it; it returns to
   the active/expanded state (again independent of any prior manual toggle).
3. While a mutation is in flight, the button is **disabled and shows an inline spinner**, an sr-only
   live-region announces "Resolving…" / "Unresolving…", and the thread's rendered resolved state does **not**
   change until the write is confirmed (no optimistic flip).
4. The new resolved state **survives a subsequent PR-detail snapshot read** (the snapshot cache is
   invalidated even though `headSha` did not move) and **appears in a second open tab** on the same PR via
   SSE without a manual reload.
5. On a **token-can't-write** failure (403 `token-cannot-write`), the thread state is **unchanged** and a
   full-width inline error banner appears with copy actionable for **both** classic (`repo`) and fine-grained
   (`Pull requests: Read and write`) tokens.
6. On a **lost-write-lock** failure (403 `unauthorized` from the subscribe gate), the banner shows the
   **distinct** "this session lost access to the PR — reload the page" copy, **not** the token-scope copy
   (disambiguated by response `code`, never by HTTP status).
7. If the **write succeeds but the reconcile reload fails**, the button releases but the thread shows a soft
   "resolved — couldn't refresh, reload the PR" hint (not silent divergence, §6.3).
8. The control is **disabled under the cross-tab write lock** (`readOnly`), mirroring the reply affordance
   and `PrActionsPanel`.
9. Appearance matches the approved mockup: **green-outline Resolve**, **neutral Unresolve**, in the thread
   footer, with Resolve rendered **immediately left of** the composer's primary Comment button when the
   composer is open (both themes).
10. Focus survives the button-disable and the fold-on-resolve unmount (parked on the thread root), matching
    `PrActionsPanel`'s focus discipline.

## 5. Backend design

### 5.1 Writer seam — new sibling interface (`PRism.Core` + `PRism.GitHub`)

Mirror `IPrLifecycleWriter` exactly; **do not** extend it (per its own header note). The methods take
`PrReference` **and** `threadId` — matching the sibling convention where every write is keyed by its
`PrReference`, and enabling the ownership binding in §5.4:

```csharp
public interface IReviewThreadWriter
{
    Task<ReviewThreadResult> ResolveAsync(PrReference reference, string threadId, CancellationToken ct);
    Task<ReviewThreadResult> UnresolveAsync(PrReference reference, string threadId, CancellationToken ct);
}

public enum ReviewThreadErrorCode { None, TokenCannotWrite, ThreadNotFound, RateLimited, Generic }

public sealed record ReviewThreadResult(bool Success, ReviewThreadErrorCode ErrorCode)
{
    public static ReviewThreadResult Ok { get; } = new(true, ReviewThreadErrorCode.None);
    public static ReviewThreadResult Fail(ReviewThreadErrorCode code) => new(false, code);
}
```

Implementation `GitHubReviewThreadWriter` in `PRism.GitHub` (`internal sealed`), constructed via DI with the
host captured eagerly and the token late-bound (`() => tokens.ReadAsync(...)`), mirroring
`ServiceCollectionExtensions.cs:96`. Transport reuses `GitHubGraphQL.PostAsync`. The two mutations (opaque
`threadId` passed through verbatim — GraphQL Node IDs are opaque, per architectural-invariants):

```graphql
mutation ($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}
mutation ($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}
```

**Error classification — BOTH failure channels** (this is the sibling's hard-won contract, not optional):

- `GitHubGraphQL.PostAsync` **throws `HttpRequestException` on any non-2xx** (`GitHubGraphQL.cs`). Each
  mutation call MUST be wrapped in `try/catch (HttpRequestException ex)` mapping `ex.StatusCode` via a
  `ClassifyHttpStatus`-style switch (401/403 → `TokenCannotWrite`, 429 → `RateLimited`, else `Generic`) —
  otherwise a real 401/403/429/5xx escapes as an unhandled 500 instead of a typed code (the exact bug #566's
  own review caught and fixed — `GitHubPrLifecycleWriter.cs` carries the standing CORRECTED comment).
- On HTTP 200 with a GraphQL `errors[]` array, classify on the message body with the
  `FirstGraphQLErrorCode`-style substring match (`GitHubPrLifecycleWriter.cs:208`): "not have permission" /
  "Resource not accessible" → `TokenCannotWrite`; "Could not resolve to a node" → `ThreadNotFound`;
  rate-limit → `RateLimited`; else `Generic`.

**Live-validation gate (plan/impl gate, NOT a deferral).** The substrings above were validated against
`closePr`/`markReady`/`merge`, **not** `resolveReviewThread`/`unresolveReviewThread`. Before pinning the
body classifier, **live-validate the actual GraphQL error body** for a read-only (fine-grained) token
invoking `resolveReviewThread` against a real PR (per the repo's "live-validate GitHub write-API premises
against a REAL PR" rule; cf. the #636 rerequest-404 lesson) and pin the classifier to the observed
message(s). A wording mismatch would silently downgrade the headline failure UX (AC5) to `Generic` → 502 →
the non-actionable fallback. Add a backend test seeded with the **captured real** error body, not a
synthesized one.

The raw GitHub error body is logged server-side (`GitHubHttp.Truncate(body, 1024)`); only the machine
`ReviewThreadErrorCode` crosses to the client. Resolve/unresolve are **idempotent** on GitHub (resolving an
already-resolved thread returns `isResolved: true`), so no "already in state" code is needed.

### 5.2 Web endpoint — mirror `PrLifecycleEndpoints`

New `PrReviewThreadEndpoints` (`internal static`, `MapPrReviewThreadEndpoints`). Two routes:

```
POST /api/pr/{owner}/{repo}/{number:int:min(1)}/thread/resolve
POST /api/pr/{owner}/{repo}/{number:int:min(1)}/thread/unresolve
```

Body: `{ "threadId": "PRRT_…" }`. **The opaque node ID rides the JSON body, not the path** — it avoids
URL-encoding fragility on an opaque token. Read via `HttpJson.TryReadJsonAsync<T>` (#666, `where T : class`);
reject empty/missing `threadId` with 400 `thread-id-required`.

Gate order (mirrors `PrLifecycleEndpoints.cs:102-110`):
1. `RequireSubscribed.Check(activePrCache, prRef, …)` → 403 `{ code: "unauthorized" }` when not subscribed.
2. `TabStamps.TryValidateTabId(http.Request, out _)` (the shipped seam post-#666 — **not**
   `PrDetailEndpoints.TabIdAllowlistRegex()`, which does not exist) → 422 `{ code: "tab-id-missing" }`.
3. **Ownership binding** (§5.4): validate `threadId` is a member of the PR-detail snapshot loaded for
   `prRef` → 404 `thread-not-found` (or 400) if not.
4. Call the writer with `(prRef, threadId)`. On success → `bus.Publish(new ReviewThreadResolutionChanged(prRef))`
   then `Results.Ok()`. On failure → `MapError(code)`.

**Complete endpoint error table** (gate/validation codes + `MapError` codes — the coherence reviewer flagged
the prior table as covering only the last four):

| code | status | source |
|------|--------|--------|
| `unauthorized` | 403 | gate 1 — `RequireSubscribed` |
| `tab-id-missing` | 422 | gate 2 — tab-id CSRF |
| `thread-id-required` | 400 | body validation |
| `thread-not-found` | 404 | ownership binding (§5.4) **or** `MapError` |
| `token-cannot-write` | 403 | `MapError` |
| `rate-limited` | 429 | `MapError` |
| `generic` | 502 | `MapError` |

> **Two distinct 403 bodies.** `unauthorized` (gate 1) and `token-cannot-write` (`MapError`) both return HTTP
> 403 with *different* `code` values and *different* remediations. The frontend MUST disambiguate on `code`,
> never on HTTP status (§6.4) — the sibling `prLifecycle.ts:38-44` learned exactly this.

### 5.3 Event → invalidation → SSE (the non-headSha-moving seam)

A resolve does **not** move `headSha`, so the snapshot cache can't tell it's stale — the exact gotcha
`PrDetailLoader.Invalidate` (`PRism.Core/PrDetail/PrDetailLoader.cs:337`) exists for.

- **New event** (`PRism.Core/Events/SubmitBusEvents.cs`, mirroring `PrLifecycleChanged`):
  `public sealed record ReviewThreadResolutionChanged(PrReference PrRef) : IReviewEvent;`
  (prRef-only payload — the reconcile reload re-materializes all threads; a `threadId` field is only needed
  by the deferred targeted-patch reconcile.)
- **Invalidation:** subscribe in `PrDetailLoader`'s constructor next to `OnPrLifecycleChanged` (`:116,157`):
  `OnReviewThreadResolutionChanged(evt) => Invalidate(evt.PrRef)`. **Store the subscription `IDisposable` in a
  new field and dispose it in `PrDetailLoader.Dispose()` (`:351-359`)** — omitting the teardown leaks the
  subscription for the singleton's lifetime (#150).
- **SSE fanout:** subscribe in `SseChannel` (`:93,357`): `FanoutProjected(evt, evt.PrRef)`; **dispose the new
  subscription in `SseChannel.Dispose()` (`:429-446`)**. Add the projection case in
  `SseEventProjection.cs:110` → wire event name `"review-thread-resolution-changed"` with a prRef-only payload
  record.
- **Frontend event registration (necessary, not just the subscriber clone).** `EventSource` only listens for
  event names present in the `EVENT_TYPES` array (`frontend/src/api/events.ts:80-99,357` — *"adding a type to
  `EventPayloadByType` is necessary but not sufficient; it must also appear here"*). So the FE work is three
  steps, not one: (a) add a `ReviewThreadResolutionChangedEvent` payload type in `types.ts`; (b) add
  `'review-thread-resolution-changed'` to `EventPayloadByType`; (c) add the string to `EVENT_TYPES`. Only then
  does the subscriber (§6.3) receive frames. Without (c) the event is published + fanned out server-side but
  silently dropped in the browser → AC4 fails silently.

### 5.4 Authorization — bind `threadId` to `prRef` (the B2 gate decision)

**The security reviewer flagged this as the central B2 decision.** A writer keyed *only* on the
client-supplied `threadId` makes the route's `{owner}/{repo}/{number}` decorative: `RequireSubscribed`
validates only `prRef`, and `resolveReviewThread` resolves the target repo purely from the opaque node ID —
so a request to a subscribed PR in repo A carrying a `threadId` from repo B would resolve the repo-B thread,
bounded only by what the PAT can write. This is a pre-existing trait (the #302 reply-draft path accepts an
unbound `ParentThreadId`, format-validated only) and is bounded by PRism's single-user / single-PAT trust
model (GitHub's own token scope is the ultimate authz, and localhost + the tab-id-CSRF preflight prevent a
foreign origin from reaching the endpoint) — but it is **undocumented** and self-inconsistent.

**Decision (LOCKED at the spec gate, 2026-07-03 — BIND).** Thread `prRef` into the writer and, at endpoint
gate 3, validate the incoming `threadId` is one of the thread IDs in the PR-detail snapshot already loaded
for `prRef` (the snapshot carries `reviewComments[].threadId`) before issuing the mutation; reject with 404
`thread-not-found` otherwise. This is cheap (the snapshot is already loaded for the PR the user is viewing;
the frontend only ever sends a `threadId` it rendered from that snapshot), follows the `IPrLifecycleWriter`
convention, and makes the route self-consistent. The alternative — accept the inherited single-user-trust-model
risk and only document it — was **considered and rejected** at the gate: for a B2 write-path surface, binding
is the correct default and the cost is negligible.

## 6. Frontend design

### 6.1 The control

Add a state-aware button to the thread footer in `ExistingCommentWidget.tsx`'s `ThreadView`:

- **Active thread** → **Resolve conversation** (green-outline).
- **Resolved thread (expanded)** → **Unresolve conversation** (neutral secondary).
- In the thread footer actions row, alongside the `Reply…` affordance. When the composer is open, Resolve
  renders **immediately left of the primary Comment button** (Comment stays right-most, as the mockup shows),
  and **stays visible in both composer-closed and composer-open states** (unlike the reply affordance, which
  is `!composerOpen`-gated) — matching GitHub, where Resolve stays visible while replying.
- Disabled under `replyContext.readOnly` (cross-tab write lock).

**Composer-open placement seam.** `ComposerActionsBar` (shared by `ReplyComposer` **and**
`InlineCommentComposer`) has a closed, non-slotted props interface. To render Resolve left of Comment without
leaking a resolve concept into the new-comment composer, add an **optional** `extraActionStart?: ReactNode`
slot to `ComposerActionsBar`, rendered immediately before the Comment button, populated **only** by
`ReplyComposer` when its `ThreadView` parent supplies a thread-resolution action (never by
`InlineCommentComposer`). *(If this seam proves messy in implementation, the accepted fallback is a separate
thread-footer row below the composer — but the slot is the target so the visual matches the mockup.)*

**Placement vs. collapse.** The actions row lives inside `{!collapsed && …}`. Resolved threads default to
collapsed, so **Unresolve is reached by expanding** the thread (the existing disclosure) — GitHub-faithful,
and it avoids restructuring the collapsed header (a single click-to-expand `<button>`; a nested Unresolve
button would be invalid HTML).

**Collapse-override clearing (closes an AC-breaking bug).** Because `effectiveCollapsed = overrides[threadId]
?? isResolved`, a thread the user manually toggled carries an override that *shadows* `isResolved` — so a
resolved thread with `override=false` would **not** fold (AC1 violated), and an unresolved thread with
`override=true` would stay stuck-collapsed with Unresolve unreachable. On a confirmed resolve/unresolve the
reconcile MUST **delete `overrides[threadId]`** so `isResolved` governs the fold again. This needs a small
FilesTab affordance (a `clearCollapseOverride(threadId)` alongside the existing `collapse` control) threaded
to `ThreadView`.

### 6.2 Button styling — green-outline (new token class)

Add a success-outline button variant to `frontend/src/styles/tokens.css` (mirrors the `.btn-secondary` /
`.composer-post-now` family):

```css
.btn-success-outline { background: var(--surface-1); color: var(--success-fg); border-color: var(--success); }
.btn-success-outline:hover:not(:disabled) { background: var(--success-soft); border-color: var(--success); color: var(--success-fg); }
```

At-rest: green text (`--success-fg`) on the card surface with a green border (`--success`). Hover: light-green
fill (`--success-soft`) — the same pairing as `chip chip-success` (proven AA in both themes). Unresolve uses
the existing neutral `.btn-secondary`.

### 6.3 Reconcile — confirm-then-apply, thread-scoped `usePrAction` clone

A per-thread hook (`useThreadResolution`, cloned from `usePrAction.ts`), owned by each `ThreadView` instance
(so concurrent resolves on different threads don't collide — `usePrAction` is per-instance and keys release
on observed booleans, verified). The **target** is the opposite of the thread's pre-action `isResolved`.

1. Click → **park focus on the thread root** (`div[data-thread-id]`) *before* invoking, mirroring
   `PrActionsPanel.tsx:230-236`'s `onInvoke` — otherwise focus drops to `<body>` when the button is disabled
   and again when the fold unmounts the actions subtree (the focus/live-region logic lives in the
   *component*, not the hook, so cloning the hook does not bring it for free). Set `pending`, disable +
   spinner the button, and announce via an sr-only `role="status" aria-live="polite"` region ("Resolving…" /
   "Unresolving…"), mirroring `PrActionsPanel`'s `PENDING_ANNOUNCE` (added for its round-2 finding D3).
   **No local state change to the thread.**
2. `POST …/thread/{resolve|unresolve}` with `{ threadId }`.
3. On the response, **hold** `pending`; the invalidate→SSE→reload path refreshes the PR-detail snapshot; when
   the reloaded `thread.isResolved` reaches the target, release `pending` **and `clearTimer()` the fallback**
   (load-bearing — `usePrAction.ts:129-142` clears the timer in the reached-target effect precisely so a late
   fire can't re-`reload()` after reconcile; forgetting it self-inflicts the exact double-reload jank §7
   frets about). On release, also **clear the collapse override** for the thread (§6.1) so it folds/expands.
4. A `FALLBACK_MS = 5000 ms` timer (mirroring #566) reloads + releases if the SSE drop is missed.
5. **Write-ok-but-reconcile-failed (AC7).** If the fallback fires and the target is *still* not observed (the
   write succeeded but the reconcile `reload()` GET failed — `usePrDetail` keeps stale `data` on a same-prRef
   reload error), do **not** release silently: surface a soft "resolved — couldn't refresh, reload the PR"
   hint. Silent release would leave the button un-spun and the thread showing the old state with no error.
6. On **write failure** → clear `pending`, render the inline error keyed on `code` (§6.4). No rollback
   (nothing was flipped).

**`reload` wiring.** The hook's fallback needs `reload()`, which originates at `PrDetailView` and is a stable
`useCallback`. It is **not** on `ExistingCommentWidgetReplyContext` today; add it there (the bag is
identity-stable to preserve `React.memo` on diff rows, and a stable `useCallback` addition doesn't break
that). FE SSE subscriber: clone `useLifecycleChangedSubscriber.ts` for `review-thread-resolution-changed`,
filtered by prRef → `reload()` (requires the `EVENT_TYPES` registration in §5.3).

### 6.4 Failure surface — full-width inline error, disambiguated by `code`

A full-width error banner in the thread column (reusing the egress modal's `.errBox` treatment:
`--danger-soft` fill, `--danger` border, ⚠ icon + message, `role="alert"`), rendered below the actions row.
The FE decodes `e.body.code` (mirroring `prLifecycle.ts`'s `handleLifecycleError`) and branches the copy —
**never keys on HTTP status**, since two codes share 403:

- `token-cannot-write` → **actionable token-scope copy** (names *both* token types and the fix), e.g.:
  *"Couldn't resolve this conversation — your token can't write to this repo. Give it Pull requests: Read and
  write (fine-grained) or classic repo scope, then try again."*
- `unauthorized` → **session copy**: *"This session lost access to the PR. Reload the page."* (matches the
  sibling's `subscribe-rejected` mapping).
- `rate-limited` / `generic` / network → the neutral retry copy.

"Actionable" here means the copy names the specific remediation for its `code`. Starting a new attempt
**clears any prior error banner immediately** (before the retry resolves), so a fresh spinner never sits under
a stale "it failed" banner.

## 7. Reconcile: why mirror #566 now, defer the lighter path

We mirror #566's invalidate→SSE→**full PR-detail reload** reconcile for the first cut.

- **Consistency + reuse.** #566's seam is adversarially reviewed and names #571 as its reuse target.
- **Invariant-compliant.** "Banner, not mutation" forbids remote state auto-applying to the diff/drafts. A
  resolve moves neither `headSha` nor any draft; the reconcile reload keeps the diff subtree mounted (the
  `!data && isLoading` skeleton gate) and does **not** refetch the per-file diff (a separate `headSha`-keyed
  query), so only `prDetail.reviewComments` re-materializes → the thread-state overlay updates. The
  observable changes are the intended fold + a brief loading-bar flicker — the thread-state badge is the
  sanctioned informational-widget exception; nothing in the diff/drafts auto-mutates.
- **Actual cost of the deferral (corrected).** The earlier draft cited #180 (Files-tab reset); that was
  **wrong in the safe direction** — a *same-tab* reload does **not** reset selected file or scroll
  (`FilesTab.tsx:228-234` re-fires auto-select only when `selectedPath` is null or absent from `fileList`,
  and a resolve leaves `fileList` identical; #180 is a *tab-reactivation* code path). The real residual cost
  is a `LoadingBar` flicker + a redundant PR-detail GET per resolve (compounded by rapid successive
  resolves). Selected file, scroll, composer, and collapse state are preserved.
- **Deferred optimization (§11):** button releases on the mutation response + a confirmed per-thread flip
  (via a `ReviewThreadResolutionChanged` payload carrying `threadId` + `isResolved`), so the acting tab
  doesn't force its own full reload. It removes only the flicker + redundant GET, not a correctness gap — so
  it's a localized follow-up, not a blocker.

## 8. Interactions with existing invariants / flows

- **Opaque Node IDs** — `threadId` (`PRRT_…`) is passed through verbatim to GraphQL; no parsing/synthesis.
- **Standalone mutation, outside the pending review** — resolve/unresolve is an **immediate** GraphQL
  mutation, not staged into the `addPullRequestReview → … → submitPullRequestReview` pipeline (like the #302
  post-now reply). It does not depend on, or stage into, a pending review.
- **Imported-drafts `IsResolved` preflight (`ImportedDraftsBanner`)** — verified safe to defer.
  `hasResolvedImports` (`frontend/src/hooks/useSubmit.ts:240`) feeds a **purely advisory** banner
  (`ImportedDraftsBanner.tsx:35,52` renders informational text and **gates nothing**); re-publish-on-submit is
  governed by whether the user edited/discarded the imported drafts, independent of this flag. A later
  diff-resolve can make the banner stale in **either** direction — over-warn (user resolved-then-unresolved
  via the diff) or under-warn (user resolved via the diff, then submits an imported reply into that thread in
  the same visible session) — but **neither causes a wrong write or data corruption**. Folding a fix in would
  reach into the reviewer-atomic submit path (a B2 risk surface), so it stays deferred (§11) with the risk
  now stated in both directions.

## 9. Rejected alternatives

- **Optimistic local flip + rollback** — the issue's literal ask, but it shows a false state and needs
  rollback logic. #566 deliberately chose hold-until-confirmed; matching it is more honest and simpler.
- **Combined "Comment & resolve" button** — GitHub uses separate adjacent buttons; a combined button couples
  two writes (comment + resolve) with partial-failure UX. The workflow is served by Comment then Resolve
  (inline replies post immediately, so the sequence is live and coherent).
- **Extending `IPrLifecycleWriter`** — rejected per its own header note; a sibling `IReviewThreadWriter`
  keeps the thread-resolution write path cohesive and independent.
- **Node ID in the URL path** — rejected in favor of the JSON body (opaque token URL-safety).
- **Proactive PAT-scope probe** — rejected per #566 (dead code for classic tokens; can't predict
  branch-protection / fine-grained 403s).
- **Keying the error banner on HTTP status** — rejected; two codes share 403 (§6.4).

## 10. Testing strategy

**Backend**
- `GitHubReviewThreadWriter`: mutation request shape (recording/fake `HttpMessageHandler`); success parses
  `isResolved`; **the thrown-`HttpRequestException` path** — 401/403 → `TokenCannotWrite`, 429 →
  `RateLimited`, 5xx → `Generic`; the 200+`errors[]` body path → the pinned, **live-validated** permission
  message → `TokenCannotWrite` (test seeded with the captured real error body); not-found → `ThreadNotFound`.
- `PrReviewThreadEndpoints`: not-subscribed → 403 `unauthorized`; missing tab-id → 422 `tab-id-missing`;
  missing `threadId` → 400 `thread-id-required`; **`threadId` not in the PR-detail snapshot → 404
  `thread-not-found`** (§5.4 binding); success publishes `ReviewThreadResolutionChanged` + 200; each error
  code → its mapped status.
- `PrDetailLoader` evicts on `ReviewThreadResolutionChanged` **and disposes the subscription in `Dispose()`**;
  `SseEventProjection` maps it to `review-thread-resolution-changed` (prRef payload); `SseChannel` disposes
  its subscription.

**Frontend**
- `ExistingCommentWidget`: renders **Resolve** on active, **Unresolve** on resolved (expanded); present with
  composer open; disabled under `readOnly`.
- `useThreadResolution`: click → POST; spinner + disabled + **live-region announced** during flight; thread
  flips only after the reload reflects the target (not on the POST alone); **no second `reload()` after a fast
  reconcile** (clearTimer); **write-ok + reconcile-reload-fail → soft hint, not silent release**; failure →
  inline error, no flip; **`unauthorized` 403 → session copy, `token-cannot-write` 403 → token-scope copy**
  (keyed on `code`); retry clears the prior banner.
- **Collapse override**: a manually-toggled thread still folds on resolve / expands on unresolve (override
  cleared).
- **Focus**: focus parked on the thread root survives the disable and the fold/unmount.
- SSE: a `review-thread-resolution-changed` for the current prRef triggers `reload()` (with the `EVENT_TYPES`
  registration in place).
- (Test the readOnly-during-async path via the DOM attribute, not `userEvent`, per the repo gotcha.)

**E2E (where feasible)** — depends on a seeded resolvable thread; the `/test/seed-review-thread` hook proposed
in **#453** is the enabler. If it lands, add an e2e that seeds a thread, resolves it, and asserts the
collapsed `Resolved` summary; otherwise cover via unit/vitest + the visual mockup and note the gap.

## 11. Deferrals / follow-ups (file as tracked issues)

1. **Targeted-patch reconcile** — release on the mutation response + a confirmed per-thread flip (payload
   carries `threadId` + `isResolved`), removing the loading-bar flicker + redundant reload per resolve. Do it
   if the flicker proves annoying in the running app.
2. **Imported-drafts `IsResolved` desync** — re-derive `ImportedDraftsBanner`'s `hasResolvedImports` when a
   diff-resolve changes a thread in an active imported session. Advisory-only today (no corruption); folding
   it in touches the reviewer-atomic submit path.
3. **E2E enablement** — depends on #453's `/test/seed-review-thread` hook.

> Note: the classifier **live-validation** (§5.1) is a **plan/implementation gate**, not a deferral — it must
> be done before the failure-UX ACs can be trusted.

## 12. Decisions taken at the human spec gate (B1 + B2) — 2026-07-03

1. **Authorization binding (§5.4, B2)** — **RESOLVED: bind.** `threadId` is validated for membership in the
   PR-detail snapshot loaded for `prRef` before the mutation.
2. **Visual (B1)** — **APPROVED.** Button placement/appearance/error-surface stand as validated against the
   real-token mockup (Resolve green-outline, Unresolve neutral, Resolve left of the primary Comment when
   composing).

All other design decisions (reconcile strategy, scope, PAT-scope handling, deferrals) are settled and
recorded above. Spec approved to proceed to `writing-plans`.
