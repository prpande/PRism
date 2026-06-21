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
- The real adapter throws `GitHubGraphQLException` (NOT_FOUND in `.extensions.code`); the fake throws `HttpRequestException("NOT_FOUND: parent thread …")`. The sniff is calibrated to the **fake's** string.

So the payoff is **code clarity + removing fake-calibration from a production classification path**, the scheduled cleanup the issue's own TODO names — not a user-facing defect. Tracked as T2 tech-debt, not a hotfix.

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

`AttachReplyAsync` (`GitHubReviewSubmitter.Submit.cs:104`) routes through `PostSubmitGraphQLAsync`, which throws `GitHubGraphQLException` on any non-empty `errors` array. Wrap the call so a NOT_FOUND-coded GraphQL error becomes the typed Core exception:

```csharp
try
{
    var data = await PostSubmitGraphQLAsync(mutation, /* vars */, ct).ConfigureAwait(false);
    // … existing parse …
}
catch (GitHubGraphQLException ex) when (ex.Code == "NOT_FOUND")
{
    throw new ReviewThreadNotFoundException(
        $"Parent review thread {parentThreadId} no longer exists on the pending review.", ex);
}
```

To branch on the code cleanly, **add a `string? Code` property to `GitHubGraphQLException`** that exposes the first error's `extensions.code`, parsed once from `ErrorsJson` using the exact `extensions.code` extraction already present in `FormatErrorsMessage` (factor that snippet into a private `static string? FirstErrorCode(string errorsJson)` helper so the formatter and the property share one parse path — no duplicated JSON walking). The property is null when the errors array is empty/unparseable/codeless, so the `when` filter simply doesn't match and the exception propagates unchanged — no behavior change for non-NOT_FOUND errors.

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

- **A1 (recommended):** `Code` property on `GitHubGraphQLException` + translate in `AttachReplyAsync`. One reusable parse, localized translation.
- **A2:** Parse `ErrorsJson` inline at the `AttachReplyAsync` catch — rejected: duplicates the `extensions.code` JSON walk that `FormatErrorsMessage` already does.
- **A3:** Translate generically inside `PostSubmitGraphQLAsync` for all submit mutations — rejected: NOT_FOUND means different things for different mutations (a missing PR review vs a missing thread vs a missing comment); blanket-translating would mis-type unrelated failures. Keep the translation local to the reply path that has the parent-thread semantic.

## Item 3b — MSAL exception-type comment (`TokenStore.cs:87`)

The keychain catch:

```csharp
catch (Exception ex) when (ex.Message.Contains("DBus", StringComparison.OrdinalIgnoreCase)
                        || ex.Message.Contains("no provider", StringComparison.OrdinalIgnoreCase))
```

matches libsecret/keyring failure text surfaced by MSAL's persistence layer. **Fix: comment-only** — record that MSAL's `Microsoft.Identity.Client.Extensions.Msal` library surfaces keyring/libsecret failures as `MsalCachePersistenceException`, whose `Message` is the only discriminator it exposes between "agent not running" (DBus / no provider) and "library missing" (the `DllNotFoundException` case caught above at `:82`). Note the string-match is a deliberate consequence of MSAL's poor exception surface, and flag narrowing the catch to `catch (MsalCachePersistenceException …)` as a candidate follow-up.

**Not narrowing the catch type in this slice.** Changing `catch (Exception)` to `catch (MsalCachePersistenceException)` is a behavior change on the auth surface (it would let a non-MSAL exception carrying "DBus" in its message fall through to the generic catch instead) that I cannot fully verify without a Linux keyring repro. The issue explicitly accepts "at minimum pin … in a comment." Comment-only is the lowest-risk action that satisfies it.

## Testing (TDD, red-on-main)

1. **Pipeline reply-parent-gone** (`PRism.Core.Tests`, existing submit-pipeline suite): a reply whose parent thread is absent in the fake → reply demoted to `Stale (NoMatch via demote)`, `SubmitFailedException(AttachReplies)` thrown carrying the typed exception as inner. Drives the fake throwing `ReviewThreadNotFoundException`. Red on main: the fake throws `HttpRequestException` and the pipeline catches via `IsParentThreadGone` message-sniff; once the typed catch replaces it, the test asserts `ex.InnerException is ReviewThreadNotFoundException` (or equivalent), which is impossible on main.
2. **Adapter translation** (`PRism.GitHub.Tests`): a `GitHubGraphQLException` constructed from a NOT_FOUND errors array → `Code == "NOT_FOUND"`; an `AttachReplyAsync` exercised against a fake transport returning that errors shape rethrows `ReviewThreadNotFoundException`. Also a guard: a non-NOT_FOUND submit error (e.g. `FORBIDDEN`) still propagates as `GitHubGraphQLException` (the `when` filter doesn't match) — proves the translation is code-scoped, not a blanket rewrap.
3. **`GitHubGraphQLException.Code`** (`PRism.GitHub.Tests`): parses the first error's `extensions.code`; null on empty/unparseable/codeless arrays (the formatter's existing fallbacks are unchanged).
4. **3b is comment-only → no test.**

## Acceptance criteria (this slice)

- [ ] `IsParentThreadGone` is deleted; the submit pipeline classifies a deleted parent thread by `catch (ReviewThreadNotFoundException)`, not message text.
- [ ] The GitHub adapter throws `ReviewThreadNotFoundException` when `AttachReplyAsync` hits a NOT_FOUND GraphQL error; non-NOT_FOUND errors still surface as `GitHubGraphQLException`.
- [ ] The in-memory fake throws `ReviewThreadNotFoundException` for a missing parent thread.
- [ ] `GitHubGraphQLException.Code` exposes the first error's `extensions.code` (null when absent), sharing one parse path with `FormatErrorsMessage`.
- [ ] `TokenStore.cs:87` carries a comment pinning `MsalCachePersistenceException` and the string-match rationale.
- [ ] Existing submit-pipeline + adapter tests stay green; the demote-reply behavior (Stale + `SubmitFailedException`) is unchanged.

## Out of scope / non-goals

- Item 3c (`PrState` enum) — separate wire-shape PR (frontend-consumer check + Playwright).
- Item 4c (ConfigStore) — deferred, #338.
- No wire-shape change, no DTO change, no UI change in **this** slice → no frontend-consumer check needed here.
- `RequirePending`'s "no pending review" throw is a different semantic and stays as-is.

## Risk classification (record in triage)

- **Tier:** T2 — three small production files + two test files, one real design choice (where the NOT_FOUND detection lives), single coherent unit.
- **Risk:** **gated (B2).** Touches the **submit pipeline** (enumerated B2 surface) and auth-adjacent `TokenStore`. The change is additive exception typing — it preserves the existing demote-reply behavior and only swaps the classification mechanism (message-sniff → typed catch) — but because the surface is gated, the human review gate is retained. Pre-PR re-check will re-verify the committed diff against the Axis-B table.
