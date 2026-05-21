# pr-updated SSE Wire-Contract Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `pr-updated` SSE event so the Reload banner surfaces — project the payload to the string-`prRef` wire shape the frontend expects, the root cause confirmed in `docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md`.

**Architecture:** Backend-only. `SseChannel.OnActivePrUpdated` currently serializes the raw `ActivePrUpdated` record, emitting `prRef` as a nested object; every other SSE event routes through `SseEventProjection.Project` (string `prRef`). This adds an `ActivePrUpdated` arm to `Project` and routes `OnActivePrUpdated` through it — the same shape `FanoutProjected` uses. The frontend `PrUpdatedEvent` contract (`prRef: string`, `commentCountDelta: number`) is already correct and is not touched. `ActivePrUpdated.NewCommentCount` (absolute, unused after this change) is replaced by `CommentCountDelta` so the wire can carry the delta the frontend accumulates.

**Tech Stack:** C# / .NET 10, xUnit + FluentAssertions, `System.Text.Json` via `JsonSerializerOptionsFactory.Api` (camelCase). Playwright TypeScript config for the two harness follow-ups.

**Source:** [docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md](../specs/2026-05-19-stale-oid-banner-investigation-finding.md) § 5.

**Scope (Option A):** the H5 wire fix + a wire-contract test + two low-hanging harness follow-ups (out-of-band #1 and #5). The real-flow spec `s5-real-stale-commit-oid.spec.ts` stays `test.skip`-ed — un-skipping it is blocked on out-of-band #7 (its second-submit choreography does not drive the intentional stale-draft override gate, `SubmitButton.tsx:61-64`). Out-of-band #2/#3/#4/#7 are out of scope; #6 is folded into Task 1-4.

---

## File Structure

**Production code:**
- `PRism.Core/Events/ActivePrUpdated.cs` — replace `int? NewCommentCount` with `int CommentCountDelta`.
- `PRism.Core/PrDetail/ActivePrPoller.cs` — compute and pass `CommentCountDelta` at the publish site.
- `PRism.Web/Sse/SseEventProjection.cs` — add `ActivePrUpdatedWire` record + an `ActivePrUpdated` arm to `Project`; update the stale header comment.
- `PRism.Web/Sse/SseChannel.cs` — route `OnActivePrUpdated` through `SseEventProjection.Project`.

**Tests:**
- `tests/PRism.Web.Tests/Sse/ActivePrUpdatedProjectionTests.cs` — new; the wire-contract regression net.
- Updated for the `ActivePrUpdated` signature change: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerBackoffTests.cs`, `tests/PRism.Web.Tests/Sse/SseChannelActivePrFanoutLogTests.cs`, `tests/PRism.Web.Tests/Sse/SseChannelActivePrDeliveryLogTests.cs`, `tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs`, `tests/PRism.Web.Tests/Endpoints/SseChannelMultimapTests.cs`.

**Harness follow-ups:**
- `frontend/playwright.real.config.ts` — webServer command builds the frontend first (#1); log the DataDir (#5).

**Docs:**
- `docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md` — fix landed in this PR, not via a later writing-plans run.
- `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md` — progress note on the deferral entry.
- `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts` — refresh the `DEFERRED` comment block.

---

## Task 1: `ActivePrUpdated` carries the comment-count delta

**Files:**
- Modify: `PRism.Core/Events/ActivePrUpdated.cs`

- [ ] **Step 1: Replace the `NewCommentCount` field.**

```csharp
// PRism.Core/Events/ActivePrUpdated.cs
public sealed record ActivePrUpdated(
    PrReference PrRef,
    bool HeadShaChanged,
    bool CommentCountChanged,
    string? NewHeadSha,
    int CommentCountDelta) : IReviewEvent;
```

`CommentCountDelta` replaces `int? NewCommentCount`: the frontend `PrUpdatedEvent` accumulates a delta (`s.commentCountDelta + event.commentCountDelta`), and the absolute count was consumed by nothing except the raw serialization this PR removes. `HeadShaChanged` / `CommentCountChanged` stay — `OnActivePrUpdated`'s EventId-4 fan-out log reads both.

- [ ] **Step 2: Build to surface every broken call site.**

Run: `dotnet build --configuration Release`
Expected: compile errors at `ActivePrPoller.cs` and the five test files listed in File Structure. Tasks 2 and 5 fix them.

## Task 2: Poller computes the delta

**Files:**
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs:129-137`

- [ ] **Step 1: Pass `CommentCountDelta` at the publish site.**

The poll already holds the previous count in `state.LastCommentCount` and the new count in `snapshot.CommentCount`. Replace the `NewCommentCount` argument:

```csharp
if (firstPoll || headChanged || commentChanged)
{
    var commentCountDelta = state.LastCommentCount is { } prevCount
        ? snapshot.CommentCount - prevCount
        : 0;
    _bus.Publish(new ActivePrUpdated(
        prRef,
        HeadShaChanged: headChanged,
        CommentCountChanged: commentChanged,
        NewHeadSha: headChanged ? snapshot.HeadSha : null,
        CommentCountDelta: commentCountDelta));
}
```

First poll has no prior count → delta `0`. This matches the existing `commentChanged` logic, which is also `false` on first poll.

- [ ] **Step 2: Build.** Run: `dotnet build --configuration Release` — `PRism.Core` compiles; test projects still error (Task 5).

## Task 3: `SseEventProjection` gains a `pr-updated` arm

**Files:**
- Modify: `PRism.Web/Sse/SseEventProjection.cs`

- [ ] **Step 1: Add the wire record + projection arm.**

Add the wire record alongside the others (field order/names produce the camelCase JSON `{prRef, newHeadSha, headShaChanged, commentCountDelta}` the frontend `PrUpdatedEvent` expects):

```csharp
internal sealed record ActivePrUpdatedWire(
    string PrRef, string? NewHeadSha, bool HeadShaChanged, int CommentCountDelta);
```

Add the arm to the `Project` switch:

```csharp
ActivePrUpdated e => ("pr-updated", new ActivePrUpdatedWire(
    e.PrRef.ToString(), e.NewHeadSha, e.HeadShaChanged, e.CommentCountDelta)),
```

- [ ] **Step 2: Update the stale header comment.**

The file header currently says "existing pr-updated / inbox-updated continue to serialize the event record directly." Replace the `pr-updated` half: `pr-updated` now projects here; only `inbox-updated` still serializes its record directly (it is broadcast, not per-PR, and its frontend contract already matches its raw shape).

- [ ] **Step 3: Build.** Run: `dotnet build --configuration Release` — `PRism.Web` compiles.

## Task 4: Route `OnActivePrUpdated` through the projection

**Files:**
- Modify: `PRism.Web/Sse/SseChannel.cs:252-265`

- [ ] **Step 1: Replace the raw serialize with the projected payload.**

Keep the EventId-4 fan-out log and the per-subscriber loop unchanged; only the JSON source changes:

```csharp
private void OnActivePrUpdated(ActivePrUpdated evt)
{
    var subscriberList = _activeRegistry.SubscribersFor(evt.PrRef);
    s_sseActivePrFanoutLog(_log, nameof(ActivePrUpdated), evt.PrRef, subscriberList.Count, evt.HeadShaChanged, evt.CommentCountChanged, null);

    var (eventName, payload) = SseEventProjection.Project(evt);
    var json = JsonSerializer.Serialize(payload, JsonSerializerOptionsFactory.Api);
    var frame = $"event: {eventName}\ndata: {json}\n\n";
    foreach (var subscriberId in subscriberList)
    {
        if (_subscribers.TryGetValue(subscriberId, out var sub))
            _ = WriteAndEvictOnFailureAsync(sub, frame, evt.PrRef, nameof(ActivePrUpdated));
    }
}
```

`Project` returns `eventName = "pr-updated"` for `ActivePrUpdated`; using the returned name keeps the event-name single-sourced in `SseEventProjection`.

- [ ] **Step 2: Build.** Run: `dotnet build --configuration Release` — `PRism.Web` compiles.

## Task 5: Update the rippled tests

**Files:**
- Modify: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerBackoffTests.cs`, `tests/PRism.Web.Tests/Sse/SseChannelActivePrFanoutLogTests.cs`, `tests/PRism.Web.Tests/Sse/SseChannelActivePrDeliveryLogTests.cs`, `tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs`, `tests/PRism.Web.Tests/Endpoints/SseChannelMultimapTests.cs`

- [ ] **Step 1: Update the `new ActivePrUpdated(...)` construction sites.**

Five call sites currently pass `NewCommentCount: null` (or positional `null`). Change the last argument to `CommentCountDelta: 0` (these sites exercise head-change events, delta `0`). `StateChangedSseTests.cs:91` is positional — change the trailing `null` to `0`. The fan-out/delivery-log tests (`SseChannelActivePrFanoutLogTests`, `SseChannelActivePrDeliveryLogTests`, `SseChannelMultimapTests`) assert on EventId 4/5 log lines, not the frame body — they need only the construction-syntax change.

- [ ] **Step 2: Update the `ActivePrPollerBackoffTests` assertions on the dropped field.**

`ActivePrPollerBackoffTests.cs` reads `evt.NewCommentCount` at lines ~121 and ~164. Replace both with `evt.CommentCountDelta`. The first-poll/no-delta case (~121) asserts `.Be(0)` (was `.BeNull()`). The comment-delta case (~164): the test seeds comment count `0` then `3` across two polls, so the delta is `3 − 0 = 3` — `.CommentCountDelta.Should().Be(3)` keeps the same numeric literal the test already asserts. Re-read the test during implementation to confirm the seed values before committing to `3`.

- [ ] **Step 3: Rewrite `StateChangedSseTests.Unhandled_event_type_throws` — Task 3 inverts its premise.**

`StateChangedSseTests.cs:83-97` asserts `Project(evt)` *throws* `ArgumentOutOfRangeException`, using `ActivePrUpdated` as the unhandled-type example. Task 3 adds an `ActivePrUpdated` arm to `Project`, so `Project(ActivePrUpdated)` no longer throws — this test FAILS its assertion (not just its constructor). Switch the test to a genuinely-unhandled event type: `DraftSubmitted` (`record DraftSubmitted(PrReference PrRef)`), which `SseEventProjection.cs`'s own header comment names as intentionally absent from the switch. Replace the constructed event and update the test's stale comment (lines 86-90, which claims `ActivePrUpdated` "is intentionally NOT in the projection switch — it ships its own wire shape inline") to describe `DraftSubmitted` instead:

```csharp
[Fact]
public void Unhandled_event_type_throws()
{
    // DraftSubmitted is intentionally NOT in the projection switch — SseChannel does
    // not subscribe to it (see SseEventProjection.cs header comment). Calling Project
    // on it must throw the default-arm ArgumentOutOfRangeException so a future
    // contributor adding a new IReviewEvent type without updating the switch hears
    // about it loudly.
    var evt = new DraftSubmitted(SamplePr);

    var act = () => Project(evt);

    act.Should().Throw<TargetInvocationException>()
        .WithInnerException<ArgumentOutOfRangeException>();
}
```

- [ ] **Step 4: Run the affected suites.**

Run: `dotnet test --configuration Release`
Expected: PASS — including `Unhandled_event_type_throws` (now exercising `DraftSubmitted`).

## Task 6: `pr-updated` wire-contract test (the regression net)

**Files:**
- Create: `tests/PRism.Web.Tests/Sse/ActivePrUpdatedProjectionTests.cs`

- [ ] **Step 1: Write the failing test.**

This is the coverage gap that hid the bug — `pr-updated` head-change delivery was never asserted end-to-end. Assert the projected wire shape directly:

```csharp
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Json;
using PRism.Web.Sse;

namespace PRism.Web.Tests.Sse;

public class ActivePrUpdatedProjectionTests
{
    [Fact]
    public void Project_ActivePrUpdated_emits_pr_updated_with_string_prRef()
    {
        var evt = new ActivePrUpdated(
            new PrReference("octo", "repo", 7),
            HeadShaChanged: true,
            CommentCountChanged: false,
            NewHeadSha: "abc123",
            CommentCountDelta: 0);

        var (eventName, payload) = SseEventProjection.Project(evt);
        eventName.Should().Be("pr-updated");

        var json = JsonSerializer.Serialize(payload, JsonSerializerOptionsFactory.Api);
        var doc = JsonDocument.Parse(json).RootElement;

        // prRef MUST be a string "owner/repo/number" — an object {owner,repo,number}
        // is the bug this test exists to catch (the frontend compares prRef === string).
        doc.GetProperty("prRef").ValueKind.Should().Be(JsonValueKind.String);
        doc.GetProperty("prRef").GetString().Should().Be("octo/repo/7");
        doc.GetProperty("headShaChanged").GetBoolean().Should().BeTrue();
        doc.GetProperty("newHeadSha").GetString().Should().Be("abc123");
        doc.GetProperty("commentCountDelta").GetInt32().Should().Be(0);
    }

    [Fact]
    public void Project_ActivePrUpdated_carries_comment_count_delta()
    {
        var evt = new ActivePrUpdated(
            new PrReference("octo", "repo", 7),
            HeadShaChanged: false,
            CommentCountChanged: true,
            NewHeadSha: null,
            CommentCountDelta: 2);

        var (_, payload) = SseEventProjection.Project(evt);
        var json = JsonSerializer.Serialize(payload, JsonSerializerOptionsFactory.Api);
        JsonDocument.Parse(json).RootElement.GetProperty("commentCountDelta").GetInt32()
            .Should().Be(2);
    }
}
```

- [ ] **Step 2: Run.** Run: `dotnet test --configuration Release` — both tests PASS (the projection arm from Task 3 makes them green).

- [ ] **Step 3: Commit Tasks 1-6.**

```bash
git add PRism.Core/Events/ActivePrUpdated.cs PRism.Core/PrDetail/ActivePrPoller.cs PRism.Web/Sse/SseEventProjection.cs PRism.Web/Sse/SseChannel.cs tests/
git commit -m "fix(sse): project pr-updated to string-prRef wire shape"
```

## Task 7: Harness follow-up — fresh-worktree wwwroot race (out-of-band #1)

**Files:**
- Modify: `frontend/playwright.real.config.ts`

- [ ] **Step 1: Build the frontend before the backend starts.**

The `webServer` backend command runs `dotnet run` concurrently with `globalSetup`'s build; on a fresh worktree `PRism.Web/wwwroot` does not exist when the backend initialises static-file serving. `npm run build` runs Vite, which emits directly into `PRism.Web/wwwroot` (observed across every investigation capture run — the build log writes `../PRism.Web/wwwroot/index.html`). Prepend the frontend build to the command so `wwwroot` exists first:

```ts
command:
  'npm run build && cd .. && dotnet run --project PRism.Web --no-launch-profile --urls http://localhost:5181 -- --no-browser',
```

The `webServer.timeout` is already `120_000`, enough headroom for the added build.

## Task 8: Harness follow-up — surface the DataDir (out-of-band #5)

**Files:**
- Modify: `frontend/playwright.real.config.ts`

- [ ] **Step 1: Log the per-run DataDir.**

After `fs.mkdirSync(e2eDataDir, ...)`, add a permanent line so the on-disk log path is locatable (the runbook in the design spec § 4.1 wrongly assumed Playwright prints it):

```ts
console.log(`[real-flow] DataDir=${e2eDataDir}`);
```

- [ ] **Step 2: Commit Tasks 7-8.**

```bash
git add frontend/playwright.real.config.ts
git commit -m "fix(real-flow-e2e): build frontend before backend; log DataDir"
```

## Task 9: Doc updates

**Files:**
- Modify: `docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md`
- Modify: `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md`
- Modify: `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts`

- [ ] **Step 1: Finding artifact — record the fix landed here.**

In § 3.2 and § 5, the finding says the production fix "ships via writing-plans" / is reverted pending a later run. Update to: the fix shipped in this same PR per `docs/plans/2026-05-21-pr-updated-wire-fix.md`; the un-skip of the real-flow spec remains deferred on out-of-band #7. Keep the § 5 sketch-amendment as the historical record but note it is now implemented.

- [ ] **Step 2: Deferral entry — progress note.**

At the stale-OID deferral entry in `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md` (the "Real-flow stale-OID spec — SSE/Reload-banner non-surfacing" entry), append:
`**PARTIALLY RESOLVED 2026-05-21:** banner root cause found + fixed (pr-updated SSE wire-contract mismatch — see docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md and this PR). The spec stays test.skip-ed; un-skip is now blocked only on the stale second-submit choreography (finding out-of-band #7).`

- [ ] **Step 3: Spec skip comment — refresh.**

Replace the `s5-real-stale-commit-oid.spec.ts` 19-line `DEFERRED` header block (which lists two now-disproven hypotheses) with a short, accurate note: the banner cause was a `pr-updated` SSE wire-contract mismatch, fixed; the spec stays skipped because its second-submit choreography does not drive the stale-draft override gate. Cite the finding doc. Leave `test.skip` in place.

- [ ] **Step 4: Commit Task 9.**

```bash
git add docs/ frontend/e2e/real/s5-real-stale-commit-oid.spec.ts
git commit -m "docs(stale-oid): record wire-fix landed; refresh deferral + skip note"
```

## Verification (whole plan)

- [ ] `dotnet build --configuration Release` — 0 errors, 0 warnings.
- [ ] `dotnet test --configuration Release` — all green, including the new `ActivePrUpdatedProjectionTests`.
- [ ] `cd frontend && npm run lint && npm run build && npm test` — green.
- [ ] Confirm the frontend was NOT modified — `git diff --stat` shows no `frontend/src/` changes (the `PrUpdatedEvent` contract was already correct).
