# #323 item 3 — Slice C (typed not-found exception + MSAL comment) design

**Issue:** [#323](https://github.com/prpande/PRism/issues/323) (epic [#317](https://github.com/prpande/PRism/issues/317), Theme C)
**Date:** 2026-06-21
**Tier:** T2 — Light. **Risk:** **gated (B2)** — touches the submit pipeline and auth-adjacent `TokenStore`. The hands-off authorization in project `CLAUDE.md` does **not** apply; this slice goes spec → `ce-doc-review` → **human gate** before implementation.

## Scope

#323 groups four robustness findings. Slice B (PR #567, merged) shipped items 1, 2, 4a, 4b. This slice — **Slice C** — ships **item 3a + 3b**:

| # | Finding | File(s) |
|---|---------|---------|
| 3a | `SubmitPipeline.IsParentThreadGone` classifies a deleted parent thread by **message-text sniffing** calibrated to the in-memory fake, not GitHub's real error shape | `PRism.Core/Submit/Pipeline/SubmitPipeline.cs`, `PRism.GitHub/GitHubReviewSubmitter.Submit.cs`, `PRism.GitHub/GitHubGraphQLException.cs`, `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitter.cs` |
| 3b | `TokenStore` keychain catch sniffs `"DBus"` / `"no provider"` in MSAL exception messages with no record of which MSAL type it wraps | `PRism.Core/Auth/TokenStore.cs` |

**Deferred out of this slice (documented, not silently dropped):**

- **Item 3c** — `PrState` is a magic string compared case-insensitively in `ActivePrPoller` purely because test fakes emit `"OPEN"` while production emits lowercase. The user chose the **enum** resolution (make `PrState` a real C# enum per the kebab-case house convention). That is a **wire-shape change**: `ActivePrPollSnapshot.PrState` serializes into the inbox/PR-detail payloads and is consumed by the frontend (`reviewActionState.ts`, `InboxRow.tsx`, `PrHeader.tsx`). It needs its own spec, a frontend-consumer check, and Playwright verification — **its own PR**, not bundled here (bundling re-couples a backend exception-typing change with a cross-tier contract change).
- **Item 4c** — `ConfigStore.HandleFileChangedAsync` unobserved-task-exception. Deferred in Slice B for a structural reason (`ConfigStore` has no `ILogger`); lands standalone or under **#338**.

Because 3c and 4c remain, **this PR does not close #323** — it checks off item 3a/3b on the epic and leaves the issue open. Use a bare `#323` reference, never a closing keyword (Slice B's body auto-closed #323 via a negated "does NOT close" sentence — see global memory `github-conventional-fix-scope-autocloses`).

## Why this is cleanup, not a live-bug fix (value calculus)

The honest framing, verified against the code:

- **Production already self-heals a deleted parent.** Step 4 re-fetches the pending-review snapshot before `AttachReplyAsync`. A parent deleted on github.com between submit attempts is caught by the `parent is null` branch (`SubmitPipeline.cs:440`), which demotes the reply to `Stale` and never touches the message-sniff.
- **The sniff (`SubmitPipeline.cs:461`) only fires in a narrow race** — a parent deleted *between* the re-fetch and the `AttachReplyAsync` call. On a false-negative there, the failure falls through to the generic retryable-step catch (`:468`) and **self-heals on the next attempt** via the `parent is null` branch (the next re-fetch sees the parent gone). Worst case today is a slightly cryptic first-attempt toast, not a stranded reply.
- The real adapter throws `GitHubGraphQLException` (NOT_FOUND structured in the error's top-level `type` field — GitHub's "could not resolve to a node" shape — possibly also `extensions.code`); the fake throws `HttpRequestException("NOT_FOUND: parent thread …")`. The sniff is calibrated to the **fake's** string and, because the current sniff matches `"could not be found"` rather than GitHub's actual `"could not resolve to a node"`, it **already fails to fire in production today** — corroborating the self-heal framing.

So the payoff is **code clarity + removing fake-calibration from a production classification path**, the scheduled cleanup the issue's own TODO names — not a user-facing defect. Tracked as T2 tech-debt, not a hotfix. Reading the structured `type` field (vs the old message text) is also what lets the typed catch actually *fire* in production for the first time, where the message-sniff never did.

**Why now (vs deferring to a feature touch):** doing 3a/3b now completes #323 item 3's bug-class cleanup while the issue is open and the submit-pipeline context is loaded from Slice B. The alternative — wait until a feature reopens `SubmitPipeline.cs` — is unbounded: the submit pipeline is stable and has no queued feature work that would carry this for free. **Open question for the gate:** if there *is* a near-term submit-pipeline change on the roadmap, deferring 3a to ride along is the higher-leverage call (ce-doc-review product-lens).

## Item 3a — typed not-found exception

### New contract type

`PRism.Core/Submit/ReviewThreadNotFoundException.cs` (next to `SubmitResults.cs`, the existing submit-contract surface):

```csharp
namespace PRism.Core.Submit;

/// <summary>
/// Thrown by an <see cref="IReviewSubmitter"/> adapter when a reply's parent
/// review thread no longer exists on the pending review (its author deleted it
/// on github.com between submit attempts). A typed signal so the submit pipeline
/// classifies "parent gone" by exception type rather than by sniffing the
/// adapter's message text — which previously matched only the in-memory fake's
/// "NOT_FOUND: parent thread …" string, not GitHub's GraphQL error shape.
/// </summary>
public sealed class ReviewThreadNotFoundException : Exception
{
    public ReviewThreadNotFoundException() { }
    public ReviewThreadNotFoundException(string message) : base(message) { }
    public ReviewThreadNotFoundException(string message, Exception innerException)
        : base(message, innerException) { }
}
```

Name chosen: `ReviewThreadNotFoundException` (not the narrower `ParentReviewThreadNotFoundException`) — the pipeline only uses it for the reply-parent case, but the shorter name reads correctly in general and is the contract the fake + adapter both throw.

### Adapter translates (`GitHubReviewSubmitter.AttachReplyAsync`)

`AttachReplyAsync` (`GitHubReviewSubmitter.Submit.cs:104`) routes through `PostSubmitGraphQLAsync`, which throws `GitHubGraphQLException` on any non-empty `errors` array. Wrap the call so a NOT_FOUND GraphQL error becomes the typed Core exception:

```csharp
try
{
    var data = await PostSubmitGraphQLAsync(mutation, /* vars */, ct).ConfigureAwait(false);
    // … existing parse …
}
catch (GitHubGraphQLException ex) when (GitHubGraphQLException.IsFirstErrorNotFound(ex.ErrorsJson))
{
    throw new ReviewThreadNotFoundException(
        $"Parent review thread {parentThreadId} no longer exists on the pending review.", ex);
}
```

**Detection must read both the top-level error `type` and `extensions.code` — not `extensions.code` alone** (ce-doc-review adversarial F3 + scope F-SG2). GitHub tags a deleted-node error as `"Could not resolve to a node with the global id of 'X'"` with **`type: "NOT_FOUND"` at the top level of the error object**, and frequently **no `extensions.code` at all** — the existing adapter test `AttachReplyAsync_OnGraphqlError_ThrowsGitHubGraphQLException` uses exactly this shape (message-only, no code). `FormatErrorsMessage` today reads only `extensions.code`, so an `extensions.code`-only filter would **never fire on the real deleted-thread error — the classification would ship dead in production while tests pass against a synthesized payload.**

Add a focused predicate to `GitHubGraphQLException` rather than a broad public `Code` property (scope F-SG1 — a public accessor for one internal caller widens the exception's API surface):

```csharp
// internal — PRism.GitHub.Tests sees it via the existing InternalsVisibleTo.
internal static bool IsFirstErrorNotFound(string errorsJson)
    => string.Equals(FirstErrorCode(errorsJson), "NOT_FOUND", StringComparison.Ordinal);

// Reads the first error's machine-readable category from EITHER the top-level
// `type` field (GitHub's "could not resolve to a node" shape) OR `extensions.code`
// (rate-limit / permission shapes). Factored out of FormatErrorsMessage so the
// formatter and this predicate share one parse path — no duplicated JSON walk.
private static string? FirstErrorCode(string errorsJson) { /* type ?? extensions.code */ }
```

`FormatErrorsMessage` is refactored to call `FirstErrorCode` for its `[CODE]` prefix (it gains top-level-`type` coverage as a side benefit — strictly additive). The predicate returns false on empty/unparseable/codeless arrays, so the `when` filter doesn't match and the exception propagates unchanged — no behavior change for non-NOT_FOUND errors.

**Unverified-payload caveat (adversarial deferred question).** No real captured GitHub payload for `addPullRequestReviewThreadReply` against a deleted parent thread is on hand; the `type: "NOT_FOUND"` shape is GitHub's documented node-resolution-failure form but is asserted, not captured. **Pre-implementation step:** confirm the real shape (capture a payload or cite GitHub's schema) before finalizing the predicate. If production turns out to emit a *message-only* NOT_FOUND with neither `type` nor `extensions.code`, the typed catch will not fire and the failure falls through to the generic retryable catch and **self-heals on the next attempt exactly as today** — so this is **never a regression** (today's message-sniff already fails to match the real `GitHubGraphQLException` in production; it only matches the fake). Do **not** re-introduce message-text matching to chase that case; structured detection or self-heal-by-fallthrough only.

**`prReviewId`-gone vs `threadId`-gone ambiguity (accepted — adversarial F4).** `AttachReplyAsync`'s mutation takes both `$prReviewId` and `$threadId`; a NOT_FOUND is indistinguishable at the code level between a deleted pending review (bad `prReviewId`) and a deleted thread (bad `threadId`), and A1 rewraps both as `ReviewThreadNotFoundException` → demote-to-`Stale`. This conflation is **accepted for this slice**: both are sub-races (the snapshot was re-fetched non-null moments earlier at Step 4), and a mis-typed pending-review-gone case **self-heals on the next attempt** — the next Step-4 re-fetch returns a null snapshot, hitting the `snapshot is null` retryable branch (`:380`), which re-detects "no pending review" correctly. Distinguishing the two would require parsing the error `path`/message (the message-sniffing this slice removes), so it is deliberately not done.

### Fake matches (`InMemoryReviewSubmitter.cs:65`)

```csharp
var thread = pending.Threads.FirstOrDefault(t => t.Id == parentThreadId)
    ?? throw new ReviewThreadNotFoundException($"parent thread {parentThreadId}");
```

(The sibling `RequirePending` throw at `:131` — `"NOT_FOUND: no pending review"` — is a *different* semantic, "no pending review at all," not "parent thread gone." It is **not** caught by `IsParentThreadGone` in the demote-reply path and is out of scope; leave it as-is so this slice does not widen.)

### Pipeline catches by type (`SubmitPipeline.cs:461`)

```csharp
catch (ReviewThreadNotFoundException ex)
{
    current = await DemoteReplyAndPersistAsync(sessionKey, current, reply.Id, done, total, progress, ct).ConfigureAwait(false);
    throw new SubmitFailedException(SubmitStep.AttachReplies,
        $"reply {reply.Id}: parent thread {reply.ParentThreadId} no longer exists on the pending review", current, ex);
}
```

**Delete `IsParentThreadGone` and its TODO block (`SubmitPipeline.cs:508-518`) entirely.** The `catch (OperationCanceledException)` / `catch (SubmitFailedException)` ordering above it is unchanged; the new typed catch slots where the `when (IsParentThreadGone(ex))` catch was, before the generic `catch (Exception ex)` retryable catch (which keeps the `#pragma warning disable CA1031`).

### Approaches considered (3a)

- **A1 (recommended):** `IsFirstErrorNotFound` predicate on `GitHubGraphQLException` (sharing the `FirstErrorCode` parse with `FormatErrorsMessage`) + translate in `AttachReplyAsync`. One reusable parse, localized translation, no broad public API added.
- **A2:** Parse `ErrorsJson` inline at the `AttachReplyAsync` catch — rejected: duplicates the `type`/`extensions.code` JSON walk that `FormatErrorsMessage` already does.
- **A3:** Translate generically inside `PostSubmitGraphQLAsync` for all submit mutations — rejected: NOT_FOUND means different things for different mutations (a missing PR review vs a missing thread vs a missing comment); blanket-translating would mis-type unrelated failures. Keep the translation local to the reply path that has the parent-thread semantic.

## Item 3b — MSAL exception-type comment (`TokenStore.cs:87`)

The keychain catch:

```csharp
catch (Exception ex) when (ex.Message.Contains("DBus", StringComparison.OrdinalIgnoreCase)
                        || ex.Message.Contains("no provider", StringComparison.OrdinalIgnoreCase))
```

matches libsecret/keyring failure text. **Fix: comment-only**, and — per ce-doc-review feasibility (P2) — the comment must record the *uncertainty*, not assert a type it cannot confirm:

- The catch at `:87` wraps only `MsalCacheHelper.CreateAsync(props.Build())`. The keyring is not actually read until `LoadUnencryptedTokenCache` (`:102/112/306`), which sits **outside** this try/catch. So the exception type that reaches `:87` — and whether the `"DBus"`/`"no provider"` branch is even reachable on the `CreateAsync` path — is **not established by this call path** without a Linux keyring repro.
- The candidate type is `MsalCachePersistenceException` (from `Microsoft.Identity.Client.Extensions.Msal` — confirmed to *exist* in the package, not confirmed to be what `CreateAsync` throws here). libsecret may instead surface a raw interop error carrying the same text.

So the comment pins `MsalCachePersistenceException` **as the documented persistence-failure candidate**, states that the type/message reaching this catch is environment-dependent and unverified, and records *that* as why the code discriminates on `Message` text rather than exception type. This satisfies the issue's "at minimum pin which MSAL exception types it wraps" by honestly recording the candidate plus its caveat — pinning a wrong type as settled fact would be worse than the status quo.

**Not narrowing the catch type, and not chasing reachability, in this slice.** Changing `catch (Exception)` to `catch (MsalCachePersistenceException)` is an unverifiable auth-surface behavior change; whether the keyring-agent branch is reachable at all on the `CreateAsync` path is a separate `TokenStore` concern needing a Linux repro. Both are noted as follow-ups in the comment; neither is actioned here.

## Testing (TDD, red-on-main)

1. **Pipeline reply-parent-gone via the race window** (`PRism.Core.Tests`, existing submit-pipeline suite). **The parent must be PRESENT in the snapshot but rejected at attach time** — the "parent absent in the snapshot" scenario is unreachable for this catch, because `parent` resolves from the re-fetched snapshot (`SubmitPipeline.cs:395`) and an absent parent triggers the `parent is null` branch (`:440`), which demotes and throws **before `AttachReplyAsync` is ever called** (the existing `ForeignAuthorThreadDeletedTests` asserts `AttachReplyCallCount == 0` for exactly that path). The fake reads one `_pendingByRef` dict for both the snapshot and `AttachReplyAsync`, so it cannot present-then-reject on its own. Use the fake's existing one-shot seam: `fake.InjectFailure(nameof(AttachReplyAsync), new ReviewThreadNotFoundException("parent thread …"))` with the thread present in the snapshot — this simulates the delete-between-refetch-and-call race the `:461` catch actually guards. Assert: the reply is demoted to `Stale`, `SubmitFailedException(AttachReplies)` is thrown with the `ReviewThreadNotFoundException` as inner, and `AttachReplyCallCount == 1`. **Red on main:** the pipeline catches via `IsParentThreadGone` message-sniff and a `ReviewThreadNotFoundException` doesn't exist there; the typed-catch assertion is impossible on main.
2. **Adapter translation** (`PRism.GitHub.Tests`): `AttachReplyAsync` exercised against a fake transport returning a **real-shape** deleted-node error — `{"type":"NOT_FOUND","message":"Could not resolve to a node with the global id of 'PRRT_x'"}` (top-level `type`, **no `extensions.code`**) — rethrows `ReviewThreadNotFoundException`. A second case with the code under `extensions.code` instead also matches (both shapes covered). **Guard:** a non-NOT_FOUND submit error (e.g. `FORBIDDEN`) still propagates as `GitHubGraphQLException` (predicate returns false) — proves the translation is code-scoped, not a blanket rewrap. **Existing-test note:** `AttachReplyAsync_OnGraphqlError_ThrowsGitHubGraphQLException` currently fixtures a `NOT_FOUND`-shaped "could not resolve to a node" error while asserting `GitHubGraphQLException`; after this change that fixture would reclassify. Update that existing test's fixture to a genuinely non-NOT_FOUND error (so it still validates the generic-error path) and let the new test above own the NOT_FOUND-translation assertion — do not leave the existing test silently exercising the wrong path.
3. **`GitHubGraphQLException.IsFirstErrorNotFound` / `FirstErrorCode`** (`PRism.GitHub.Tests`, via the existing `InternalsVisibleTo`): returns the code from the top-level `type` field, falls back to `extensions.code`, and is false/null on empty/unparseable/codeless arrays. Includes the message-only-no-code case (returns false → not reclassified). Confirms `FormatErrorsMessage`'s `[CODE]` output is unchanged for the `extensions.code` shape and now also prefixes the top-level-`type` shape (strictly additive).
4. **3b is comment-only → no test.**

## Acceptance criteria (this slice)

- [ ] `IsParentThreadGone` is deleted; the submit pipeline classifies a deleted parent thread by `catch (ReviewThreadNotFoundException)`, not message text.
- [ ] The GitHub adapter throws `ReviewThreadNotFoundException` when `AttachReplyAsync` hits a NOT_FOUND GraphQL error detected via top-level `type` **or** `extensions.code`; non-NOT_FOUND errors still surface as `GitHubGraphQLException`.
- [ ] The in-memory fake throws `ReviewThreadNotFoundException` for a missing parent thread (adapter/fake parity); the demote-path test drives the typed catch via `InjectFailure`, not the absent-in-snapshot path.
- [ ] `GitHubGraphQLException.IsFirstErrorNotFound` (internal predicate, not a public `Code` property) detects NOT_FOUND from `type` or `extensions.code`, sharing one `FirstErrorCode` parse path with `FormatErrorsMessage`.
- [ ] The real GitHub deleted-thread payload shape is confirmed (captured or schema-cited) before the predicate is finalized; if it is message-only, the typed catch self-heals by fall-through (documented) and message-sniffing is **not** re-introduced.
- [ ] The existing `AttachReplyAsync_OnGraphqlError_ThrowsGitHubGraphQLException` test fixture is updated to a non-NOT_FOUND error so it still exercises the generic-error path.
- [ ] `TokenStore.cs:87` carries a comment recording `MsalCachePersistenceException` as the **candidate** persistence-failure type with the unverified-on-this-call-path caveat and the string-match rationale.
- [ ] Existing submit-pipeline + adapter tests stay green; the demote-reply behavior (Stale + `SubmitFailedException`) is unchanged.

## Out of scope / non-goals

- Item 3c (`PrState` enum) — separate wire-shape PR (frontend-consumer check + Playwright).
- Item 4c (ConfigStore) — deferred, #338.
- No wire-shape change, no DTO change, no UI change in **this** slice → no frontend-consumer check needed here.
- `RequirePending`'s "no pending review" throw is a different semantic and stays as-is.

## Risk classification (record in triage)

- **Tier:** T2 — three small production files + two test files, one real design choice (where the NOT_FOUND detection lives), single coherent unit.
- **Risk:** **gated (B2).** Touches the **submit pipeline** (enumerated B2 surface) and auth-adjacent `TokenStore`. The change is additive exception typing — it preserves the existing demote-reply behavior and only swaps the classification mechanism (message-sniff → typed catch) — but because the surface is gated, the human review gate is retained. Pre-PR re-check will re-verify the committed diff against the Axis-B table.

## `ce-doc-review` dispositions (1× — coherence, feasibility, security-lens, adversarial, scope-guardian, product-lens)

| Finding (persona) | Sev / conf | Disposition | Note |
|---|---|---|---|
| Test 1 unwritable — absent-in-snapshot parent short-circuits AttachReply (adversarial) | P1 / 75 | **Applied** | Test 1 rewritten to use `InjectFailure(AttachReplyAsync, …)` with the thread present, simulating the delete-between-refetch-and-call race the `:461` catch guards; asserts `AttachReplyCallCount == 1`. |
| Fake throw must use InjectFailure, not unconditional missing-thread (adversarial) | P1 / 75 | **Applied** | Fake line-65 edit kept for adapter/fake parity; demote-path test drives the catch via the `InjectFailure` seam. |
| Narrowing to `extensions.code` drops message-only NOT_FOUND coverage / ships dead in prod (adversarial F3 + scope F-SG2) | P2 / 50–75 | **Applied** | Detection now reads top-level `type` **and** `extensions.code` via `IsFirstErrorNotFound`; existing test fixture is GitHub's real `type:NOT_FOUND` shape; payload-capture made a pre-impl step; non-regression documented. |
| `Code` public property has one caller — use a focused predicate (scope F-SG1) | P3 / 50 | **Applied** | Replaced the public `Code` property with internal `IsFirstErrorNotFound` predicate (testable via existing `InternalsVisibleTo`); folds with F3. |
| Existing AttachReply NOT_FOUND test silently exercises wrong path (scope F-SG2) | P2 / 75 | **Applied** | AC + test 2 require updating that fixture to a non-NOT_FOUND error so it keeps covering the generic path. |
| MSAL pin unverified on the `CreateAsync` call path (feasibility) | P2 / 75 | **Applied** | 3b comment hedged to candidate-not-verified; notes the catch wraps `CreateAsync` (keyring read is at `LoadUnencryptedTokenCache`, outside the try) and that the branch's reachability is a separate deferred `TokenStore` concern. |
| `prReviewId`-gone vs `threadId`-gone NOT_FOUND ambiguity (adversarial F4) | P2 / 50 | **Applied** | Design note: conflation accepted (both sub-races; pending-review-gone self-heals via the next Step-4 null-snapshot retryable branch); distinguishing would need the removed message-parsing. |
| Why-now not weighed vs deferring to next pipeline touch (product-lens) | P3 / 50 | **Applied** | Added a "Why now" paragraph; surfaced the ride-along roadmap question to the human gate. |
| Endpoint may echo `SubmitFailedException.Message` (node IDs) verbatim (security FYI) | — / FYI | **Noted** | Node IDs are opaque, not secret; pre-existing behavior unchanged by this slice. No action; flagged for awareness. |
| `Code`/`Message` PAT-leak surfaces; generic TokenStore catch embeds `ex.Message` (security) | — | **Skipped (pre-existing)** | Not introduced by this slice; the auth message-embedding path is untouched. |
| Document coherence (coherence) | — | **Skipped** | Zero findings — no contradictions, refs/line-anchors verified. |
