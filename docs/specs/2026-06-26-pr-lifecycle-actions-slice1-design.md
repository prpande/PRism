# PR detail: GitHub lifecycle actions — Slice 1 (foundation + close/reopen/draft-toggle) (#566)

**Status:** spec (T3 — full pipeline; gated **B1 UI-visual** + **B2 risk-surface: auth/PAT + first GitHub write actions**)
**Issue:** [#566](https://github.com/prpande/PRism/issues/566) — PR detail lifecycle actions.
**Sibling:** [#571](https://github.com/prpande/PRism/issues/571) — resolve/unresolve review threads. Shares the write-path foundation built here (owner directive on #566: *"design the UX separately, build the plumbing once"*).

## Problem

The PR detail screen is review-only. You can submit a review and post comments, and the header *displays* draft/open/merged/closed state — but you cannot take **GitHub PR lifecycle actions** (merge, close, reopen, draft↔ready) from inside PRism. Today the only escape hatch is the header's Open-in-GitHub link — you leave for github.com to act. `PRism.GitHub` itself only **reads** PR/merge state (`IPrReader`) and **writes review comments/submissions** (`IReviewSubmitter`); there are no lifecycle write methods.

## Scope: this is Slice 1 of two

Owner-selected slicing (option B): split #566 into two PRs rather than one.

- **Slice 1 (this spec):** the shared write-path foundation **+** the simple, optionless state actions — **Close, Reopen, Mark ready-for-review, Convert-to-draft**. No merge.
- **Slice 2 (future, separate spec):** **Merge** — merge-method choice (merge/squash/rebase, respecting repo-allowed methods), a net-new repo-allowed-methods read, eligibility gating off `MergeReadiness`, and a stronger confirmation. Slice 2 drops its merge box into the **same** Overview panel this slice builds (see UX), so no re-layout.

Rationale: merge carries all the genuinely hard parts (method picker, repo-settings read, eligibility, strong confirm). Landing the foundation in front of the *simplest* real actions exercises the plumbing with shipping behavior (not abstractly), keeps each diff reviewable, and gets the reusable layer #571 needs in sooner.

**Primary driver (positioning).** The lifecycle actions are infrequent (≈once per PR) and Open-in-GitHub already reaches them, so the marginal in-app convenience is modest. The principal justification is the **reusable write-path foundation** #571 (and later slice 2's merge) needs — the actions are the smallest shipping vehicle that exercises it. This is also PRism's **first non-review GitHub write**: it deliberately moves the tool from review-companion toward PR-lifecycle management, and each action is permanent GitHub-API surface (REST state, GraphQL mutations, node-id resolution, 403/branch-protection edges) a single maintainer commits to. That trajectory bet (slice 2 merge next) is accepted, not incidental.

## Resolved design decisions

Each of these was settled in brainstorming; recorded here so the plan and reviewers inherit the rationale (not just the conclusion).

1. **Update model — pending-state-then-reconcile, *not* optimistic-flip-with-rollback.** The issue text asked for optimistic+rollback; we rejected it for *these* actions. They are infrequent (once per PR) so the latency payoff is low, and a PR's state isn't one flag — flipping open→closed changes the glyph, the status label, *which buttons render*, and the readiness badge, so optimistic mutation + clean rollback on a 403 is real bug surface. Instead: the invoked button shows a spinner and disables its siblings; the **pending flag clears on the POST 200** (the in-flight request is done — see "reconcile mechanism" below for why pending does *not* wait on the reload); the authoritative new state then arrives via a dedicated reload (below) and swaps the button set. On failure the spinner clears and a toast explains. The perceived ~300ms–1s gap reads as "working" for a deliberate action. (Optimistic flip may suit #571's high-frequency thread-resolve later; the foundation hook leaves room for it as an opt-in, but slice 1 does not build it.)

2. **Confirmation — per action.**
   - **Reopen / Mark ready-for-review / Convert-to-draft** — non-destructive and reversible; **no confirmation**, just a spinner.
   - **Close** — reversible (Reopen exists), so it does **not** clear the bar for a blocking modal (`design-handoff` / behavioral guidance: *modals only for blocking decisions*). Guard it with an **inline two-step confirm**: the Close control morphs in place to "Close this PR? — Cancel / Confirm close". Reuses the in-place-confirm idiom already in `PrHeader` (the discard affordances). Full interaction contract:
     - **Dismissal:** Cancel, Escape, or a click outside the control all abort and restore the plain Close button. Tab-out does **not** dismiss.
     - **Focus / a11y:** on morph, focus moves to the Cancel button; an `aria-live` region announces the confirm prompt.
     - **Sibling lock:** while the confirm is open, **all other panel buttons are disabled** (same treatment as pending) so a conflicting action (e.g. Convert-to-draft sitting in the same row) can't be invoked mid-confirm. Confirm → transitions to pending (spinner); Cancel/dismiss → restores the full row.
     - **Failure reset:** on **any** POST failure (permission or generic), **both** the pending flag and the confirming state reset to the plain Close button **before** the error toast — otherwise the control could sit in the confirming state and a follow-up misclick re-fires the close, defeating the guard.

3. **Placement — adaptive bottom-sticky "PR actions" panel in the Overview tab; Overview-only.** The PR header (`PrHeader.tsx`) is already dense (action cluster = Refresh + Open-in-GitHub + Review action button; subtitle row carries the expanded readiness badge + chips). Lifecycle actions go in a **sticky panel pinned to the bottom of the Overview scroll area**, matching GitHub's own merge-box-at-bottom convention — improved by being sticky (no scrolling past a long timeline). The panel is **state-aware** (renders only the actions valid for the current state), stays **compact** (single row) for 1–2 buttons, and is the **same container** slice 2's merge box expands into. When **no** lifecycle action applies (merged), the panel is **not rendered** (no empty chrome).
   - **Structural containment (not pixels):** the panel must be a **full-width sticky footer of the Overview tab**, so it must mount as a **direct child of `.overviewTab` (outside the `.overviewGrid` wrapper)** — *not* appended after `ReviewFilesCta` inside `.overviewGrid`, which is the ~80%-width padded content column and would render a narrow, inset bar rather than a full-width footer (it would also fight `position: sticky` against the grid's box). This is an information-architecture/DOM-parent decision, fixed here; the exact spacing/tokens/both-theme treatment is the part deferred to the gate.
   - **Accepted tradeoff:** lifecycle actions are reachable only from Overview, not from Files/Checks/Drafts. This asymmetry is deliberate: review-submit follows you cross-tab (in the header) because it's the end of the Files-reading flow; lifecycle is a "step back and act on the whole PR" decision, and Overview is the PR's home.
   - **Final visual polish (exact spacing/tokens/both-theme treatment) is deferred to the B1 visual gate** — owner will tweak as it renders. This spec fixes *placement, structure, behavior, and state-awareness*, not pixels.

4. **Interface structuring — new `IPrLifecycleWriter`, separate from `IReviewSubmitter`.** Lifecycle actions are not reviews; mixing them muddies `IReviewSubmitter` and forces its several test fakes to implement four irrelevant methods (CS0535 fake-churn). New interface keeps the seam clean.

5. **PAT-scope handling — reactive, not proactive.** The classic `repo` scope PRism's auth validator requires for **classic** tokens (`GitHubAuthValidator.cs`) grants PR write, so a proactive token-capability probe is dead code for those users *and* still can't predict branch-protection 403s. Handle the write failure reactively: classify it (see error handling) and surface a clear, **actionable** message.
   - **Fine-grained PAT caveat (corrected):** `GitHubAuthValidator` also **accepts fine-grained PATs and does not scope-check them (fail-open)**. So a fine-grained token with read-but-not-`Pull requests: write` passes auth, reaches a lifecycle action, and 403s. The reactive copy must therefore be actionable for *both* token types — name enabling **"Pull requests: Read and write"** (fine-grained) / PR-write `repo` scope (classic), not a bare "needs PR write access" that dead-ends a fine-grained user.

6. **Error surface — toast/snackbar via existing `useToast`.** No new error primitive; same `show({ kind: 'error', … })` path the review-submit flow uses, consistent with the app's snackbar-over-banner guidance and #446 direction.

## Architecture

**No GET wire-shape change.** The panel reads PR state from the *existing* fields already on `PrDetailDto.Pr` — `State`, `IsDraft`, `IsClosed`, `IsMerged` (`PRism.Core.Contracts/Pr.cs`). Slice 1 adds **write** endpoints + UI only; it adds no field to any GET DTO. This shrinks blast radius — no new-wire-field sweep of e2e route mocks / FE consumers is required (the trap noted in prior wire-shape work).

The actions ride the established write seam: **endpoint → writer → publish a dedicated bus event (snapshot evict) → frontend reload refetch**, the same shape comment-posts already use (`PrSubmitEndpoints.cs` / the `…PostedBusEvent` → `PrDetailLoader.Invalidate` → SSE → subscriber → `usePrDetail.reload()` chain).

### Reconcile mechanism — a dedicated lifecycle event, NOT `StateChanged` (corrected)

> **Correction from ce-doc-review (feasibility + adversarial, confirmed in code).** An earlier draft claimed an *existing* "`StateChanged` → `usePrDetail.reload()`" path. **That path does not exist.** In `PrDetailView.tsx`, the `StateChanged` subscriber is wired only to `draftSession.refetch` (it refreshes the **draft session**, not the `PrDetailDto` the header glyph/badge and `PrActionsPanel` read). `usePrDetail.reload()` is driven exclusively by **dedicated** subscribers — `useRootCommentPostedSubscriber`, `useSingleCommentPostedSubscriber`, `useDraftSubmittedSubscriber` — each paired with its own `PrDetailLoader.Invalidate` handler. A lifecycle write that published only `StateChanged` would refetch the draft session but **never re-GET the PR detail**, so the header/panel would stay stale and (because `usePrAction` waits for a reload to swap state) the perceived UX would be broken.

The design therefore adds its **own** event + subscriber, mirroring the comment-posted precedent:

- **Backend:** after a successful lifecycle write the endpoint publishes a new bus event **`PrLifecycleChanged(prRef)`** (and may still publish `StateChanged` for draft-session consistency, but the reload does **not** depend on it). `PrDetailLoader` handles `PrLifecycleChanged` with an **unconditional `Invalidate(prRef)`** (exactly like `OnSingleCommentPosted`).
- **Frontend:** a new **`useLifecycleChangedSubscriber`** (mirroring `useSingleCommentPostedSubscriber`) calls **`usePrDetail.reload()`** on the SSE event. This subscriber is part of the reusable foundation — #571 reuses the same event/subscriber shape.
- **Own-tab note:** the comment-posted subscribers process their own tab's events (the `sourceTabId`-match suppression is specific to `StateChanged`/`useStateChangedSubscriber`); the new lifecycle subscriber follows that same "process own event" model, so the acting tab reloads. (See Open Questions for the tabId-threading nuance.)

## Components

### Backend

- **`IPrLifecycleWriter`** (`PRism.Core`) — four methods, each `(PrReference, CancellationToken)` → a typed result (`PrLifecycleResult`: success, or a failure carrying an **error code** so the endpoint can map causes to the right HTTP status + toast):
  - `CloseAsync` / `ReopenAsync` → REST `PATCH /repos/{o}/{r}/pulls/{n}` with body `{ "state": "closed" }` / `{ "state": "open" }`.
  - `MarkReadyForReviewAsync` / `ConvertToDraftAsync` → GraphQL `markPullRequestReadyForReview` / `convertPullRequestToDraft` (REST has **no** draft toggle), keyed by the PR's GraphQL **node id**.
- **`GitHubPrLifecycleWriter`** (`PRism.GitHub`) — implements the interface reusing the existing transport helpers (`PostGraphQLAsync`, `SendGitHubAsync`) and the injected `_readToken` factory, mirroring `GitHubReviewSubmitter`'s construction.
  - **Error classification (corrected — do not collapse all 403s).** GitHub returns 403 for **distinct** causes; the codebase already distinguishes them (`GitHubCiFailingDetector.cs` separates fine-grained 403 from rate-limit; `GitHubGraphQLException` reads `extensions.code`). The writer must inspect the **response body / GraphQL `extensions.code`**, not the bare status, and emit:
    - `token-cannot-write` — true permission/scope denial (body ≈ *"Resource not accessible by personal access token"* / GraphQL permission code). Toast directs the user to grant PR-write (actionable for classic **and** fine-grained per decision 5).
    - `repo-rule-blocked` — branch-protection / policy block (body ≈ *"Protected branch"* / *"Validation Failed"*). Toast explains the rule blocked it and **does not** tell the user to change their PAT.
    - Secondary-rate-limit / abuse 403 → route through the existing transport rate-limit path (`ThrowIfRateLimited`), **not** `token-cannot-write`.
    - other failure → generic code.
  - **Node-id resolution (committed strategy, no DTO change).** The two GraphQL mutations need the PR node id. **Prefer threading it from already-fetched server state** (the `PrDetailSnapshot` / active-PR cache the request already has) to avoid an extra hop; only if the node id is not retained there, fall back to a single server-side `GET /repos/{o}/{r}/pulls/{n}` (`node_id`). When the fallback fetch is needed it adds one serial round-trip to the action's latency budget — acceptable for these infrequent actions, but pick the threaded path when available. (Confirm at plan stage whether the snapshot retains `node_id`; see Open Questions.)
- **`PrLifecycleEndpoints.cs`** (`PRism.Web/Endpoints`) — one POST per action (matching the existing per-action convention `…/submit`, `…/root-comment/post`, `…/comments/post`):
  - `POST /api/pr/{owner}/{repo}/{number:int}/close`
  - `POST /api/pr/{owner}/{repo}/{number:int}/reopen`
  - `POST /api/pr/{owner}/{repo}/{number:int}/ready-for-review`
  - `POST /api/pr/{owner}/{repo}/{number:int}/convert-to-draft`
  - Each: **auth/subscribed guard + custom-header gate** (see security note) → call the writer → **on success**: publish `PrLifecycleChanged(prRef)` (→ snapshot evict + SSE) → 200; **on permission failure**: `{ code: "token-cannot-write" }` → **403**; **branch-protection**: `{ code: "repo-rule-blocked" }` → **403** (distinct code); other failure → 5xx + generic error DTO.
  - **CSRF parity (security).** The existing submit endpoint requires a non-empty allowlist-conforming `X-PRism-Tab-Id` custom header, which incidentally blocks cross-origin CSRF (browsers can't set custom headers cross-origin without a CORS preflight). `RequireSubscribed` alone does **not** prove the caller is the PRism UI, so a co-browsed malicious page could POST `…/close` for a subscribed PR. The four lifecycle POSTs must carry the **same custom-header requirement** (presence + allowlist match; no head-SHA/drift check needed for lifecycle) to match the write surface they're modeled on.
- **Explicit-invalidation seam (reusable foundation).** Close/reopen/ready/convert **don't move headSha**, and the snapshot cache (`PrDetailLoader._snapshots`) is headSha-keyed — so the key won't auto-swap and a stale snapshot would be served (the same gotcha as comment posts). The `PrLifecycleChanged` handler's unconditional `Invalidate(prRef)` fixes this for all four. #571 reuses this seam.
  - *Why explicit even though `OnActivePrUpdated` exists (corrected):* `OnActivePrUpdated` already evicts on any done-state flip (`doneNow != doneCached`), so **Close *and* Reopen are both caught on the next active-PR poll**. What it does **not** carry is the **draft flag**, so the two draft toggles would never evict via that path. The explicit `PrLifecycleChanged` evict is justified by (a) **immediacy** — all four reconcile now, not next-poll — and (b) covering the draft toggles at all.

### Frontend

- **`usePrAction` hook** (`frontend/src/hooks`, reusable foundation) — pending-state-then-reconcile. Tracks the in-flight action; POSTs via the api client.
  - **Pending clears on the POST 200**, not on reload completion (request-in-flight vs. UI-freshness are separate concerns). The authoritative button set is then swapped by the reload (below) as a subsequent step.
  - **SSE-drop fallback:** if the lifecycle reload has not fired within a short timeout (~5s) of the POST success, call `usePrDetail.reload()` directly. This prevents a dropped/reconnecting SSE from leaving the panel showing stale buttons indefinitely.
  - **on failure** clears pending (and the confirm state, per decision 2) and fires an error toast, mapping the error code → copy: `token-cannot-write` → the PAT copy (token-type-aware); `repo-rule-blocked` → the policy copy; a **subscribe/auth rejection** (the `RequireSubscribed` reject status — confirm code at plan stage) → its **own** "session lost access to this PR — reload" copy, **not** the PAT copy; else generic.
  - Exposes per-action pending flags + invoke functions. #571's resolve/unresolve plugs into the same hook.
- **`useLifecycleChangedSubscriber`** (`frontend/src/hooks` or `PrDetailView` wiring, reusable foundation) — SSE subscriber for `PrLifecycleChanged` → `usePrDetail.reload()`, mirroring `useSingleCommentPostedSubscriber`.
- **`PrActionsPanel`** (`frontend/src/components/PrDetail/OverviewTab`) — the adaptive bottom-sticky panel. Derives visible buttons from `prDetail.pr` (`isDraft` / `isClosed` / `isMerged` / `state`). Wires to `usePrAction`; buttons reflect pending (spinner + siblings disabled) and the Close confirm contract (decision 2). Render rules:
  - `null` when **no action applies** (merged).
  - `null` during **cold load** (`prDetail` null / loading), matching `PrHeader`'s loading-suppression of its action cluster (don't render buttons off undefined `pr` fields).
  - `null` when **`readOnly` is true** (peer-owned PR; `OverviewTab` already threads `readOnly` from context and suppresses writes elsewhere — lifecycle follows suit).
  - Mounted by `OverviewTab.tsx` as a **direct child of `.overviewTab`, outside `.overviewGrid`** (decision 3 structural note).
- **`prLifecycle` client** (`frontend/src/api`) — `closePr` / `reopenPr` / `markReady` / `convertToDraft` fns + the typed error codes (`token-cannot-write`, `repo-rule-blocked`, subscribe-rejection, generic).

### State → visible actions (the state-awareness matrix)

The panel renders **nothing** in any of these suppression cases first: cold-load, `readOnly`, or merged. Otherwise:

| PR state | Visible actions |
|---|---|
| Open, draft | Mark ready-for-review · Close |
| Open, non-draft | Convert-to-draft · Close *(slice 2 adds Merge here)* |
| Closed (not merged) | Reopen |
| Merged | *(panel not rendered)* |
| Any state, `readOnly` or cold-load | *(panel not rendered)* |

## Data flow

Click → `usePrAction` sets pending (button spins, siblings disable) → `POST /api/pr/{…}/{action}` (with `X-PRism-Tab-Id`) → writer hits GitHub → **200** → **`usePrAction` clears pending** (request done). In parallel: endpoint publishes `PrLifecycleChanged` → snapshot evict → SSE → `useLifecycleChangedSubscriber` → `usePrDetail.reload()` → fresh `PrDetailDto` → panel re-renders the new button set. *(If the reload hasn't fired within ~5s, `usePrAction` triggers it directly.)* **Failure** → error DTO → `usePrAction` clears pending **and** any confirm state + toast (code-mapped).

## Error handling

- **`token-cannot-write` (true scope/permission 403)** → toast naming the PR-write grant, **token-type-aware**: classic → PR-write `repo` scope; fine-grained → "Pull requests: Read and write".
- **`repo-rule-blocked` (branch-protection 403)** → toast explaining a repo rule blocked the action; **does not** advise changing the PAT.
- **Secondary rate-limit / abuse 403** → routed through the transport rate-limit path, surfaced as a transient/retry message — never `token-cannot-write`.
- **Subscribe/auth rejection** → its own "session lost access — reload" toast, not the PAT copy.
- **TOCTOU** (e.g. Close a PR a peer already closed) → GitHub errors → toast + the `reload()` reconciles the panel to actual state.
- **Close confirm on failure** → resets to the plain Close button (decision 2) before the toast.
- **Any other failure** → generic toast, pending cleared. All via `useToast`.

## Testing

Net-new behavior, so the proof is tests authored **test-first** (red → green within the PR history) plus the acceptance checklist below — **no red-on-main** (not a bug fix).

- **Backend**
  - `GitHubPrLifecycleWriter` unit tests (mocked transport): each of the four actions issues the correct REST/GraphQL call; **403 classification branches** — permission body → `token-cannot-write`; branch-protection body → `repo-rule-blocked`; rate-limit shape → rate-limit path (not `token-cannot-write`); other → generic.
  - Node-id resolution: uses the threaded id when present; falls back to the REST GET when absent.
  - `PrLifecycleEndpoints` tests: success → 200 **and** publishes `PrLifecycleChanged` **and** evicts the snapshot; permission failure → 403 + `token-cannot-write`; branch-protection → 403 + `repo-rule-blocked`; auth/subscribe guard rejects unsubscribed callers; **missing custom header → rejected** (CSRF parity).
  - Invalidation-seam test: a successful reopen/ready evicts the snapshot **despite unchanged headSha**.
- **Frontend**
  - `usePrAction`: pending clears on **200** (not gated on reload); SSE-drop fallback triggers reload after the timeout; failure → toast + pending **and** confirm cleared; error-code → copy mapping (`token-cannot-write` token-type-aware, `repo-rule-blocked`, subscribe-rejection, generic).
  - `useLifecycleChangedSubscriber`: `PrLifecycleChanged` SSE → `usePrDetail.reload()` called.
  - `PrActionsPanel`: state-aware rendering across draft/open / non-draft/open / closed / merged; **not rendered** on cold-load, `readOnly`, merged; inline Close confirm (morph → siblings disabled → Escape/Cancel/click-out aborts + focus-to-Cancel → Confirm fires → failure resets to plain Close); pending disables siblings.
  - `prLifecycle` client.
- **Backend test factory note:** test containers that wire `AddPrismCore` must construct `IPrLifecycleWriter` via the same optional/DI seam used for existing adapters; confirm no test container throws on resolution (the optional-ILogger / `GetService` precedent).

## Acceptance criteria

- [ ] From the Overview tab, on an **open draft** PR I can **Mark ready-for-review** and the header glyph/badge reflect the change without a manual refresh.
- [ ] On an **open non-draft** PR I can **Convert-to-draft** and **Close** (Close behind the inline two-step confirm).
- [ ] On a **closed (not merged)** PR I can **Reopen**.
- [ ] On a **merged** PR, a **`readOnly`** PR, and during **cold load**, the panel is **not shown**.
- [ ] A token lacking PR-write permission produces a clear, **token-type-aware** "grant PR write" toast; a **branch-protection** block produces a distinct toast that does **not** advise changing the PAT.
- [ ] Each action shows a pending spinner and disables siblings while in flight; **pending clears on the POST response**; state reconciles via the lifecycle SSE/reload (with a ~5s direct-reload fallback); on failure the spinner **and** any Close-confirm state clear and a toast explains.
- [ ] The inline Close confirm is keyboard-operable (Escape cancels, focus moves to Cancel, prompt announced).
- [ ] Lifecycle POSTs require the `X-PRism-Tab-Id` custom header (CSRF parity with submit).
- [ ] No change to any GET DTO wire shape.

## Foundation reuse for #571 (explicit)

Written once here, consumed by #571: `usePrAction` (pending-reconcile + error-code→copy mapping), the **`PrLifecycleChanged`-style dedicated bus event + `PrDetailLoader.Invalidate` handler + `useLifecycleChangedSubscriber`** reload path, the typed error surface (`token-cannot-write` / `repo-rule-blocked`), and the toast treatment. #571 then only adds `resolveReviewThread` / `unresolveReviewThread` GraphQL methods (on its own interface, mirroring `IPrLifecycleWriter`) + the per-thread diff control.

## Deferred / Open Questions (from 2026-06-26 ce-doc-review — resolve at plan/impl stage)

- **Node-id retention:** does `PrDetailSnapshot` / the active-PR cache retain the PR `node_id`? If yes, thread it (no extra hop); if no, the REST-GET fallback is used. Confirm before implementation.
- **`convertPullRequestToDraft` on unsupported plan:** does it return a structured GraphQL error (distinct `extensions.code`) or an HTTP 422 when the repo's plan doesn't support draft PRs? Determines whether the error map needs an extra branch.
- **Node-id fetch 404:** if the resolution `GET` 404s (PR deleted / visibility changed since subscription), should the endpoint return 404 or 5xx? Affects whether the FE can distinguish "PR gone" from "GitHub unreachable".
- **Subscribe-rejection status code:** what HTTP code does the `RequireSubscribed` guard reject with (401 vs other)? Determines the `usePrAction` error-classifier branch for the "session lost access" copy.
- **Own-tab event nuance:** lifecycle endpoints publish with `SourceTabId: null`, so the acting tab processes its own event (intended — it should reload). If a spurious double-reload is observed, thread the acting tabId instead. Confirm during implementation.
- **B2 sign-off:** the gate needs a **live PAT-write verification** (a real lifecycle action against a real PR) during human review — CI can't assert write success against GitHub.

## Out of scope (slice 1)

- **Merge** and everything it entails (method choice, repo-allowed-methods read, eligibility gating, merge confirmation) → **slice 2**.
- Optimistic-flip-with-rollback (rejected for these actions; see decision 1).
- Proactive PAT-scope probe (rejected; see decision 5).
- Lifecycle actions on the open-PR **tab context menu** (issue lists as out-of-scope first cut).
- Pixel-level visual treatment (deferred to the B1 visual gate; structure/IA is fixed here).
- Auto-merge / merge-queue, merge-commit-message editing, branch deletion on merge (issue out-of-scope).

## Rejected alternatives

- **One PR for all four+merge (slice option A):** largest diff; merge complexity gates the simple toggles; delays the reusable foundation #571 needs. Rejected for B.
- **Foundation as its own PR (slice option C):** maximum isolation but the foundation has no user-visible behavior to review/merge in a vacuum. Rejected for B.
- **Lifecycle actions in `PrHeader` (issue's first suggestion):** header is already dense; adding four state-aware buttons tips it over. Rejected for the Overview panel.
- **Single "PR actions ▾" header menu:** keeps cross-tab reach but hides a destructive Close behind a dropdown (discoverability) and makes the inline confirm awkward. Rejected.
- **Extend `IReviewSubmitter`:** fewer files but conflates review-submit with lifecycle and churns every review fake. Rejected for the new interface.
- **Reload via the existing `StateChanged` subscriber:** that subscriber only refetches the draft session, not the PR detail — it would not refresh the header/panel. Rejected for a dedicated `PrLifecycleChanged` event + subscriber (see Reconcile mechanism).
