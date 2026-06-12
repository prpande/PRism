---
type: refactor
issue: 334
epic: 317
tier: T2
risk: hands-off
status: draft
---

# Test-strategy consolidation (#334)

## Problem

Three test-suite strategy/layout problems from the 2026-06 code-quality review
(epic #317), distinct from the mechanical scaffolding consolidation (#332):

1. **Dual frontend test-location convention.** Many components have a test file
   under `frontend/__tests__/` **and** a co-located one under `src/`. Contributors
   can't tell where a component's tests live, and where cases overlap, every prop
   change is edited twice.
2. **`ViewerLoginHydrator` (a Core class) tested in two projects with two doubling
   strategies** — house-style fakes + real `ConfigStore` in `Core.Tests`, and Moq
   (including a loose `new Mock<IConfigStore>()` that silently no-ops the
   config-write side effect) in `Web.Tests`.
3. **Moq on internal collaborators**, against the house rule ("mock external
   boundaries; test real classes against real collaborators inside the project").
   The Inbox tests Moq the internal `IAppStateStore` / `IConfigStore` stores and
   the `IInboxRefreshOrchestrator` seam, while the project already ships real
   in-memory doubles for all three.

Plus inventory hygiene: a permanently-skipped e2e stub and a near-collision
filename pair.

## Decision: co-located is the convention

Co-located (`src/.../<Component>.test.tsx`) wins. It matches the newer files, keeps
a component's test next to its source, and is the direction the codebase already
drifted. Recorded in `.ai/docs/frontend-conventions.md`.

**Scope the convention-doc wording precisely** (do not overclaim). `frontend/__tests__/`
is **not** being retired wholesale — only the components that *currently* have a test
in *both* locations are consolidated here. After this work, ~100 component-level
`.test.tsx` files with **no** co-located sibling still live under `__tests__/` (they
are single-location, so they don't double maintenance and aren't this issue's
dual-location problem). A blanket "co-located is THE convention, full stop" would be
contradicted on day one by that residue. So the doc records: **co-located is required
for new component tests, and the dual-location duplicates are resolved here; the
historical single-location `__tests__/` component files migrate opportunistically**
(tracked as a separate follow-up issue filed during execution). This keeps the
recorded convention credible rather than immediately violated by the directory mass.
This issue closes the *dual-location* problem, not the directory.

## Reframing: most pairs are location-splits, not case-duplicates

Investigation found the issue's "duplicated cases double maintenance" premise holds
for only a few pairs. In most, the `__tests__/` file holds the older comprehensive
bulk and the co-located `src/` file is a newer, narrow, feature-specific file
(tagged `#214`, `#118`, `#291`, `#219`, `#119`) with little-to-no literal overlap.
So the work is predominantly **relocate `__tests__` content into the co-located
file**, dropping only genuinely-duplicated cases — lower coverage-loss risk than the
issue framing implies.

**Merge discipline (the correctness property):** for every pair, read *both* files
and carry the **union** of distinct cases into the **co-located file** (the merge
direction is *always* into `src/`, regardless of which side currently has more
cases — e.g. AppearanceSync's co-located file is canonical even though its
`__tests__/` twin exists). Coverage must be unchanged-or-better.

**Equivalence is assertion-level, not title-level.** A case is dropped as a
"duplicate" only after reading the *body* of both candidates and confirming the
surviving case asserts the **same behavior at equal-or-greater strength**. Similar
titles are *not* evidence of equivalence — the Modal pair is the cautionary example:
`EscKey_ClosesViaCancelAction` (asserts the cancel **action** fires) is not the same
as co-located `calls onClose on Escape` (asserts **onClose** fires), and
`returns null when open is false (no DOM presence)` is *stronger* than
`renders nothing when closed`. Dropping the stronger/different assertion ships a
regression a green `vitest` run will **not** catch (the weaker surviving test still
passes). **Proof obligation:** for every dropped case, the PR names the surviving
file:line that asserts the same behavior. A preserved before/after case *count* is
**not** a coverage proof (delete A, keep near-twin B → count unchanged, behavior
lost).

## Scope — the complete dual-location set (18 components)

Computed by intersecting component base-names present in both `frontend/__tests__/`
and co-located `src/**` (hyphen/case-insensitive). This exceeds the issue's "~10"
estimate; the AC ("one test location per component") mandates the full set —
stopping short respawns the problem for the remainder.

| # | Component | `__tests__/` file | Co-located file | Disposition |
|---|-----------|-------------------|-----------------|-------------|
| 1 | Modal | `Modal.test.tsx` | `components/Modal/Modal.test.tsx` | **per-case merge** — the Esc/closed cases are *near*-twins, NOT true duplicates: keep `__tests__`'s cancel-action + no-DOM-presence assertions (stronger/different than co-located's onClose + renders-nothing); relocate focus-mgmt/Tab-trap/ARIA. Confirm assertion-equivalence by reading bodies before dropping anything |
| 2 | FileTree | `FileTree.test.tsx` | `components/PrDetail/FilesTab/FileTree.test.tsx` | relocate (co-located = `#214` synthetic scrollbar, no overlap) |
| 3 | InboxRow | `InboxRow.test.tsx` | `components/Inbox/InboxRow.test.tsx` | **merge+dedup** — PR-state-icon + CI-glyph + nav overlap; co-located is the fuller/newer set |
| 4 | PrHeader | `PrHeader.test.tsx` | `components/PrDetail/PrHeader.test.tsx` | **careful harness-merge** — divergent harnesses; co-located tests post-`#291` unified `ReviewActionButton`; verify no superseded cases survive |
| 5 | DraftsTab | `DraftsTab.test.tsx` | `components/PrDetail/DraftsTab/DraftsTab.test.tsx` | relocate + dedup empty-state (co-located = `#118`) |
| 6 | Header | `header.test.tsx` | `components/Header/Header.test.tsx` | relocate (co-located = gear/help; `__tests__` = nav/wordmark) |
| 7 | PrRootConversation | `PrRootConversation.test.tsx` | `components/PrDetail/OverviewTab/PrRootConversation.test.tsx` | relocate (co-located = 1 avatar case) |
| 8 | VerdictPicker | `VerdictPicker.test.tsx` | `components/PrDetail/VerdictPicker.test.tsx` | relocate (co-located = per-verb color hooks) |
| 9 | ErrorBoundary | `error-boundary.test.tsx` | `components/ErrorBoundary.test.tsx` | **merge+dedup** — both render-fallback; co-located is fuller |
| 10 | InboxSection | `InboxSection.test.tsx` | `components/Inbox/InboxSection.test.tsx` | relocate + dedup recently-closed-caption (co-located = grouping/forceOpen) |
| 11 | UnresolvedPanel | `UnresolvedPanel.test.tsx` | `components/PrDetail/Reconciliation/UnresolvedPanel.preload.test.tsx` | relocate `__tests__` → sibling co-located file (`.preload` is a separate subject — keep both, both co-located) |
| 12 | InboxPage | `InboxPage.test.tsx` | `pages/InboxPage.test.tsx` (+ `InboxPage.activityGate.test.tsx`) | relocate/merge — read both for overlap |
| 13 | usePrDetail | `usePrDetail.test.tsx` | `hooks/usePrDetail.test.tsx` | relocate/merge |
| 14 | useFilesTabShortcuts | `useFilesTabShortcuts.test.tsx` | `hooks/useFilesTabShortcuts.test.tsx` | relocate/merge |
| 15 | useAiGate | `useAiGate.test.tsx` | `hooks/useAiGate.reactivity.test.tsx` | relocate `__tests__` → `hooks/useAiGate.test.tsx` (sibling to `.reactivity`) |
| 16 | ExistingCommentWidget | `ExistingCommentWidget.optimistic.test.tsx` | `components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx` | relocate `.optimistic` → co-located sibling |
| 17 | AppearanceSync | `appearance-sync.test.tsx` | `components/AppearanceSync.test.tsx` | relocate/merge |
| 18 | PrRootReplyComposer | `PrRootReplyComposer.test.tsx` | `components/PrDetail/Composer/PrRootReplyComposer.badge.test.tsx` | relocate `__tests__` → `Composer/PrRootReplyComposer.test.tsx` (sibling to `.badge`) |

For each, the final state is: the component's tests live only under `src/`, the
`__tests__/` file is deleted, no case is lost. Import paths shorten from `../src/...`
to `./...` / relative-within-`src`.

## Item 2 — `ViewerLoginHydrator` → one project, real-collaborator style

`Web.Tests/Hosting/ViewerLoginHydratorTests.cs` has **6** Moq cases (issue said 3).
Three overlap `Core.Tests/Auth/ViewerLoginHydratorConfigWriteTests.cs`; **three are
unique** and must be preserved:

- `when_ValidateCredentials_throws_leaves_login_empty` (forgiving startup on network error)
- `does_not_clobber_existing_login` (race: `/api/auth/connect` already won)
- `propagates_cancellation`

Plan:
- Extend `StubReviewAuth` with a `StubReviewAuth(Exception toThrow)` ctor that throws
  the supplied exception from `ValidateCredentialsAsync` (the current `throwOnValidate`
  ctor only throws a fixed `InvalidOperationException`, which can't express the
  `HttpRequestException` / `OperationCanceledException` cases).
- Add `tests/PRism.Core.Tests/Auth/ViewerLoginHydratorTests.cs` with the 3 unique
  cases rewritten on `FakeTokenStore` / `StubReviewAuth` / `InMemoryViewerLoginProvider`
  + real `ConfigStore` on a `TempDataDir`. Fold the only unique assertions from the
  3 overlapping cases into the existing `ConfigWriteTests` (the invalid-token →
  `loginCache.Get() == ""` cache-empty assertion). The `Times.Once` verify on the
  *valid-token* case is dropped as an implementation detail — the outcome assertion
  (`loginCache.Get() == "alice"`, already present) proves validation ran.
- **Preserve the "ValidateCredentials NEVER called" guarantees — they are behavioral,
  not implementation detail.** Two cases assert non-invocation:
  `does_not_clobber_existing_login` (#5, a unique case: pre-set login + token present
  → validate must NOT run) and `no_token_does_not_call_ValidateCredentials` (#2,
  overlaps Core's `does_not_clobber_config_login_when_no_token_present`). In the
  house style, the equivalent of `MockBehavior.Strict` + `Verify(Times.Never)` is a
  **throwing stub**: `StubReviewAuth(throwOnValidate: true)` throws if `Validate` is
  reached, so a passing `StartAsync` with the login preserved *is* the proof it was
  never called. Both surviving cases MUST use the throwing stub (Core #2 already does)
  — do not rewrite them onto a result-returning stub, which would silently drop the
  guarantee with no failing test.
- Delete `tests/PRism.Web.Tests/Hosting/ViewerLoginHydratorTests.cs`. The hydrator's
  host-startup integration angle (it is a registered `IHostedService` whose
  `StartAsync` ordering matters) is **not** in this deleted file — that coverage lives
  in the poller-hosting tests — so the deletion loses no integration coverage.

## Item 3 — migrate Inbox Moq off internal stores

The two seam classes have **different** migration profiles — the earlier draft's
"clean drop-in, no `.Verify`/`.Raise`" claim holds only for the orchestrator test,
not the poller tests:

- **`InboxRefreshOrchestratorTests.cs`** — purely state-based (verified: no `.Verify`
  / `.Raise` / `MockBehavior` on these seams). `ConfigStoreMock` (`Mock<IConfigStore>`
  + `SetupGet(Current)`) → `FakeConfigStore { Current = … }`; `StateStoreMock`
  (`Mock<IAppStateStore>` + `Setup(LoadAsync)`) → `new InMemoryAppStateStore(state)`.
  Clean drop-ins.
- **`InboxPollerTests.cs` / `InboxPollerImmediateRefreshTests.cs`** — these are
  **interaction + timing** tests, not pure spies. `Mock<IInboxRefreshOrchestrator>` is
  used three ways: (a) `.Verify(o => o.RefreshAsync(…), Times.Never/AtLeastOnce/AtLeast(2))`
  and `.Invocations.Count(RefreshAsync)` call-count assertions; (b)
  `.Setup(…).Returns(() => { …; throw … })` **throw-on-Nth-call** injection (fail then
  recover); (c) per-call `DateTime.UtcNow` capture to assert the Retry-After backoff
  gap between successive `RefreshAsync` calls. A bare `RefreshCalls` counter does NOT
  cover (b) and (c). The Core-local fake must therefore mirror the existing Web.Tests
  `FakeInboxRefreshOrchestrator`: a `RefreshOverride : Func<CancellationToken, Task>?`
  (a test injects throw-on-Nth and/or records timestamps inside the callback) **plus**
  an `Interlocked.Increment`-backed `RefreshCalls` read via `Volatile.Read` — the
  poller writes the counter from its `BackgroundService` thread while the test thread
  reads it, so a plain `int++` is a data race that Moq's synchronized `.Invocations`
  hid for free. The 4 `.Verify(Times.*)` assertions become `RefreshCalls` comparisons.
  Also migrate `Mock<IConfigStore>` (fast-poll config) → `FakeConfigStore`, and
  `Mock<ILogger<InboxPoller>>` → `NullLogger<InboxPoller>.Instance` (or the existing
  `CapturingLogger<T>` only if a test asserts on logs).
- **`BrowserLauncherTests.cs`** — left on Moq; `IBrowserLauncher` is the boundary-ish
  seam the house rule explicitly allows. Justified in a code comment.

**Reference the existing fakes in place — do NOT relocate them.** `FakeConfigStore`
(`Core.Tests/PrDetail/`, namespace `…PrDetail`) and `InMemoryAppStateStore`
(`Core.Tests/Submit/Pipeline/Fakes/`, **13 consumers**) are `internal` and live in the
same assembly as the Inbox tests, so the Inbox tests reach them with a `using` — no
file move, zero churn to the 13 existing `InMemoryAppStateStore` consumers + the
`PrDetailLoaderTests` consumer. The mild oddity (Inbox tests importing a
`Submit.Pipeline.Fakes` namespace) is accepted; consolidating shared test doubles into
`TestHelpers/` is a broader hygiene sweep deliberately left as a **separate follow-up**
rather than dragging a 14-file using-churn into this PR.

- **Cross-project fake decision:** `Web.Tests` references `PRism.Core` but **not**
  `PRism.Core.Tests`, so the orchestrator fake cannot be shared across the two test
  projects without a new test→test project reference. Decision: **project-local**
  fakes — add the Core-local fake described above, leave the existing Web.Tests fake
  untouched. This is a lower-coupling tradeoff, not a literal de-duplication: the
  Moq-vs-fake inconsistency the issue flags is replaced by two project-local fakes of
  the same shape (a known, accepted cost — a future shared test-support package could
  converge them), which is still strictly better than mock-here/fake-there because
  both sides now hand-fake the seam.

## Item 4 — hygiene

- Delete the permanently-skipped `test.skip('SSE banner appears on inbox-updated
  event', …)` stub at `frontend/e2e/inbox.spec.ts:308`; move its rationale to a
  short comment noting where the behavior is covered (`useInboxUpdates` unit +
  `EventsEndpointsTests`).
- Resolve the near-collision: rename `frontend/__tests__/DiffPaneHighlight.test.tsx`
  (thread-row / commented-line highlighting — asserts `.diff-line--commented`) →
  `frontend/__tests__/DiffPane.threadHighlight.test.tsx` so it no longer reads as a
  typo of `DiffPane.highlight.test.tsx` (syntax highlighting — asserts
  `.codeToken`/`.codeLine`). **The rename stays inside `__tests__/`** — `DiffPane`'s
  own tests (`DiffPane.test.tsx`, `DiffPane.highlight.test.tsx`,
  `DiffPane.driftGuard.test.tsx`) all live in `__tests__/` with no co-located sibling,
  so `DiffPane` is *not* in the item-1 dual-location set. Moving only this one file to
  `src/` would *manufacture* a dual-location split for `DiffPane` — exactly what item 1
  removes. So this is a pure disambiguating rename, not a relocation; the broader
  `DiffPane.*` cluster migrates with the residue follow-up.

## Acceptance criteria

- [ ] One test location per component for all 18 pairs; co-located; cases merged
      keeping the **assertion-level superset**; `__tests__/` siblings deleted.
- [ ] Convention recorded in `.ai/docs/frontend-conventions.md`, scoped to "required
      for new component tests; dual-location duplicates resolved here"; residue
      follow-up issue filed.
- [ ] `ViewerLoginHydrator` tested in exactly one project (`Core.Tests`),
      real-collaborator style; Moq variant deleted; the 3 unique cases preserved; the
      two "validate-never-called" guarantees preserved via a throwing stub.
- [ ] No Moq on `IAppStateStore` / `IConfigStore` / `IInboxRefreshOrchestrator`;
      remaining Moq (`IBrowserLauncher`) justified per the house rule.
- [ ] Skipped e2e stub deleted; `DiffPaneHighlight` collision resolved (rename within
      `__tests__/`, no new split).
- [ ] Coverage unchanged-or-better; full FE (`vitest`) + backend (`dotnet test`)
      suites green.

## Proof plan

- **Coverage preservation (assertion-level):** for each merged pair the PR shows the
  union of cases in the surviving co-located file; **for every dropped case, the PR
  names the surviving file:line that asserts the same behavior** (a before/after case
  *count* is not accepted as proof — see merge discipline). The per-case mapping is
  given explicitly for the higher-risk pairs (Modal, InboxRow, PrHeader, ErrorBoundary,
  DraftsTab, InboxSection). Green `vitest` run is the regression backstop.
- **Backend:** `dotnet test --settings .runsettings` green; the 3 unique
  `ViewerLoginHydrator` behaviors present in `Core.Tests` + both validate-never-called
  guarantees enforced by a throwing stub; zero `using Moq;` in the 3 migrated Inbox
  files (grep proof); the Core-local orchestrator fake reproduces the poller tests'
  throw-on-Nth + timing behavior; `BrowserLauncherTests` Moq retained + justified.
- **Secrets scan** over the diff (test-only; expect none).
- **Doc-review dispositions** (1× `ce-doc-review`, T2) recorded.

## Risks & mitigations

- **Coverage loss in a merge** (the top risk) → assertion-level union discipline (read
  bodies, not titles) + per-dropped-case surviving-assertion mapping in the PR + green
  `vitest`. Modal and PrHeader read fully before merging (near-twin assertions / era
  divergence). Counts are explicitly *not* trusted as proof.
- **Large diff (~40 files)** → one clean commit per logical group (FE merges batched,
  item 2, item 3, item 4) so review is navigable; all test-only.
- **Poller-fake under-built** → the Core-local orchestrator fake is *not* a bare
  counter; it mirrors the Web.Tests `FakeInboxRefreshOrchestrator` (override for
  throw-on-Nth + timestamp capture) with an `Interlocked`/`Volatile` counter for the
  cross-thread read. `dotnet test` (the timing/retry tests) is the backstop.
- **Hidden interaction-based assertion** in a "state-based" Moq site →
  `InboxRefreshOrchestratorTests` verified clean (no `.Verify`/`.Raise`/`MockBehavior`
  on the migrated seams); the **poller tests are NOT clean** (they use `.Verify(Times.*)`
  + throw-injection + timing) and are handled as interaction tests with the
  full-featured fake above, not treated as drop-ins.

## Out of scope

- Retiring `frontend/__tests__/` wholesale (only dual-location files move).
- Same-name-but-different-subject co-located files that have no `__tests__` twin.
- Any production-source change. This is test-only.
