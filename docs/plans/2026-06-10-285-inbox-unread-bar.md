# #285 Inbox unread-bar reset-on-view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an inbox row's left "new changes" bar clear after the user views the PR, by re-projecting the (cheap, local) viewed-state live on every `GET /api/inbox` instead of leaving it frozen in the orchestrator snapshot.

**Architecture:** The inbox snapshot (`orch.Current`) conflates the expensive GitHub-sourced feed with the cheap local viewed-state. `mark-viewed` writes a view stamp to `state.json` but never recomputes the snapshot, so the stale `lastViewedHeadSha` survives the inbox refetch and the bar stays lit. Fix: extract the viewed-state projection into one shared helper, and have the GET handler re-apply it as a read-only overlay onto the cached snapshot from live `state.json`. Backend only; no frontend change. The current head-sha model already produces the intended "unviewed reads unread on a fresh install" baseline (Symptom 2 is intended, not a bug).

**Tech Stack:** C# / .NET (PRism.Core, PRism.Web), xUnit + FluentAssertions, Playwright (real-backend e2e). Spec: `docs/specs/2026-06-10-285-inbox-unread-bar-design.md`.

---

## File Structure

- **Create** `PRism.Core/Inbox/InboxViewedState.cs` — the single source of truth for viewed-state projection. Two public static methods: `Project(PrReference, AppState)` (the per-PR projection, extracted verbatim from `MaterializePrInboxItem`) and `ApplyViewedState(InboxSnapshot, AppState)` (the overlay that re-projects every item).
- **Modify** `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — `MaterializePrInboxItem` calls `InboxViewedState.Project` instead of inlining the projection (makes refresh-time and overlay share the one helper).
- **Modify** `PRism.Web/Endpoints/InboxEndpoints.cs` — `GET /api/inbox` injects `IAppStateStore`, loads `AppState`, and applies `InboxViewedState.ApplyViewedState` to `orch.Current` before serializing.
- **Create** `tests/PRism.Core.Tests/Inbox/InboxViewedStateTests.cs` — unit tests for `Project` (the single-source-of-truth contract) and `ApplyViewedState` (overlay behavior).
- **Modify** `tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs` — add the Symptom-1 divergence regression guard (GET reflects a `state.json` stamp without a refresh).
- **Create** `frontend/e2e/inbox-unread-reset.spec.ts` — real-backend Playwright proof: inbox row unread → open PR → return → bar cleared.

No frontend source changes. No new visual baselines expected (init render is unchanged).

---

## Task 1: Extract the shared viewed-state projection + overlay

**Files:**
- Create: `PRism.Core/Inbox/InboxViewedState.cs`
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:289-318` (`MaterializePrInboxItem`)
- Test: `tests/PRism.Core.Tests/Inbox/InboxViewedStateTests.cs`

Reference — the current inlined projection in `MaterializePrInboxItem` (lines 295-310), which moves into `Project` unchanged:
```csharp
var sessionKey = r.Reference.ToString();
string? lastViewedHeadSha = null;
long? lastSeenCommentId = null;
if (state.Reviews.Sessions.TryGetValue(sessionKey, out var session))
{
    lastViewedHeadSha = session.TabStamps.Values
        .OrderByDescending(s => s.StampedAtUtc)
        .FirstOrDefault()?.HeadSha;
    if (session.LastSeenCommentId != null
        && long.TryParse(session.LastSeenCommentId, System.Globalization.CultureInfo.InvariantCulture, out var n))
        lastSeenCommentId = n;
}
```

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Core.Tests/Inbox/InboxViewedStateTests.cs`:

```csharp
using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public class InboxViewedStateTests
{
    private static AppState StateWithSession(string key, ReviewSessionState session)
    {
        var sessions = new Dictionary<string, ReviewSessionState> { [key] = session };
        return AppState.Default.WithDefaultReviews(
            AppState.Default.Reviews with { Sessions = sessions });
    }

    private static ReviewSessionState Session(
        Dictionary<string, TabStamp> tabStamps, string? lastSeenCommentId = null) =>
        new(tabStamps, lastSeenCommentId, null, null,
            new Dictionary<string, string>(),
            new List<DraftComment>(), new List<DraftReply>(),
            null, DraftVerdictStatus.Draft);

    private static PrInboxItem Item(PrReference reference, string headSha,
        string? lastViewedHeadSha = null, long? lastSeenCommentId = null) =>
        new(reference, "T", "a", "acme/api",
            System.DateTimeOffset.UtcNow, System.DateTimeOffset.UtcNow,
            1, 0, 1, 0, headSha, CiStatus.None, lastViewedHeadSha, lastSeenCommentId);

    [Fact]
    public void Project_returns_most_recent_tab_stamp_head_by_stamped_at()
    {
        var reference = new PrReference("acme", "api", 1);
        var session = Session(new Dictionary<string, TabStamp>
        {
            ["older"] = new TabStamp("OLD", new System.DateTime(2026, 6, 1, 0, 0, 0, System.DateTimeKind.Utc)),
            ["newer"] = new TabStamp("NEW", new System.DateTime(2026, 6, 2, 0, 0, 0, System.DateTimeKind.Utc)),
        }, lastSeenCommentId: "42");
        var state = StateWithSession(reference.ToString(), session);

        var (lastViewedHeadSha, lastSeenCommentId) = InboxViewedState.Project(reference, state);

        lastViewedHeadSha.Should().Be("NEW");
        lastSeenCommentId.Should().Be(42);
    }

    [Fact]
    public void Project_returns_nulls_when_no_session()
    {
        var (lastViewedHeadSha, lastSeenCommentId) =
            InboxViewedState.Project(new PrReference("acme", "api", 999), AppState.Default);

        lastViewedHeadSha.Should().BeNull();
        lastSeenCommentId.Should().BeNull();
    }

    [Fact]
    public void ApplyViewedState_overwrites_a_stale_baked_value_with_the_live_stamp()
    {
        var reference = new PrReference("acme", "api", 1);
        // Snapshot baked at refresh time with a STALE viewed head.
        var snapshot = new InboxSnapshot(
            new Dictionary<string, IReadOnlyList<PrInboxItem>>
            {
                ["review-requested"] = new[] { Item(reference, headSha: "HEAD", lastViewedHeadSha: "STALE") },
            },
            new Dictionary<string, InboxItemEnrichment>(),
            System.DateTimeOffset.UtcNow);
        // Live state: the user has since viewed the PR at HEAD.
        var state = StateWithSession(reference.ToString(), Session(new Dictionary<string, TabStamp>
        {
            ["t1"] = new TabStamp("HEAD", System.DateTime.UtcNow),
        }));

        var result = InboxViewedState.ApplyViewedState(snapshot, state);

        result.Sections["review-requested"][0].LastViewedHeadSha.Should().Be("HEAD");
    }

    [Fact]
    public void ApplyViewedState_leaves_unviewed_item_null_and_preserves_other_fields()
    {
        var reference = new PrReference("acme", "api", 2);
        var item = Item(reference, headSha: "HEAD", lastViewedHeadSha: null);
        var snapshot = new InboxSnapshot(
            new Dictionary<string, IReadOnlyList<PrInboxItem>> { ["review-requested"] = new[] { item } },
            new Dictionary<string, InboxItemEnrichment>(),
            System.DateTimeOffset.UtcNow);

        var result = InboxViewedState.ApplyViewedState(snapshot, AppState.Default);

        var overlaid = result.Sections["review-requested"][0];
        overlaid.LastViewedHeadSha.Should().BeNull();   // unviewed → still unread (intended init baseline)
        overlaid.HeadSha.Should().Be("HEAD");           // non-viewed fields untouched
        overlaid.Reference.Should().Be(reference);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InboxViewedState"`
Expected: FAIL to compile — `InboxViewedState` does not exist.

- [ ] **Step 3: Create the helper**

Create `PRism.Core/Inbox/InboxViewedState.cs`:

```csharp
using PRism.Core.Contracts;
using PRism.Core.State;

namespace PRism.Core.Inbox;

/// <summary>
/// Single source of truth for the inbox "viewed-state" projection. Both the refresh-time
/// materialization (<see cref="InboxRefreshOrchestrator"/>) and the read-time overlay
/// (GET /api/inbox) route through <see cref="Project"/>, so the projection cannot fork.
/// </summary>
public static class InboxViewedState
{
    /// <summary>
    /// Projects a PR's last-viewed head + last-seen comment id from the persisted session.
    /// The "last viewed head" is the most-recent <see cref="TabStamp"/> across all tabs
    /// (the user has one inbox, not one per tab). Session key is the canonical slash form
    /// (<see cref="PrReference.ToString"/>), matching how mark-viewed writes its stamp.
    /// </summary>
    public static (string? LastViewedHeadSha, long? LastSeenCommentId) Project(
        PrReference reference, AppState state)
    {
        if (!state.Reviews.Sessions.TryGetValue(reference.ToString(), out var session))
            return (null, null);

        var lastViewedHeadSha = session.TabStamps.Values
            .OrderByDescending(s => s.StampedAtUtc)
            .FirstOrDefault()?.HeadSha;

        long? lastSeenCommentId = null;
        if (session.LastSeenCommentId != null
            && long.TryParse(session.LastSeenCommentId, System.Globalization.CultureInfo.InvariantCulture, out var n))
            lastSeenCommentId = n;

        return (lastViewedHeadSha, lastSeenCommentId);
    }

    /// <summary>
    /// Returns a copy of <paramref name="snapshot"/> in which every item's
    /// <c>LastViewedHeadSha</c>/<c>LastSeenCommentId</c> is re-projected from the live
    /// <paramref name="state"/>. Total replacement (never a merge), so the result depends
    /// only on <paramref name="state"/> — the snapshot's baked viewed-state is irrelevant
    /// once overlaid. Section keys are preserved, so endpoint ordering is unaffected.
    /// </summary>
    public static InboxSnapshot ApplyViewedState(InboxSnapshot snapshot, AppState state)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(state);

        var rebuilt = snapshot.Sections.ToDictionary(
            kv => kv.Key,
            kv => (IReadOnlyList<PrInboxItem>)kv.Value
                .Select(item =>
                {
                    var (lastViewedHeadSha, lastSeenCommentId) = Project(item.Reference, state);
                    return item with
                    {
                        LastViewedHeadSha = lastViewedHeadSha,
                        LastSeenCommentId = lastSeenCommentId,
                    };
                })
                .ToList());

        return snapshot with { Sections = rebuilt };
    }
}
```

- [ ] **Step 4: Refactor `MaterializePrInboxItem` to call the shared helper**

In `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`, replace the body of `MaterializePrInboxItem` (the `sessionKey`/`lastViewedHeadSha`/`lastSeenCommentId` block, lines 295-310) with a single call:

```csharp
private static PrInboxItem MaterializePrInboxItem(
    RawPrInboxItem r,
    Dictionary<PrReference, CiStatus> ciByRef,
    AppState state)
{
    var ci = ciByRef.TryGetValue(r.Reference, out var c) ? c : CiStatus.None;
    var (lastViewedHeadSha, lastSeenCommentId) = InboxViewedState.Project(r.Reference, state);
    return new PrInboxItem(
        r.Reference, r.Title, r.Author, r.Repo,
        r.UpdatedAt, r.PushedAt,
        r.IterationNumberApprox, r.CommentCount,
        r.Additions, r.Deletions, r.HeadSha, ci,
        lastViewedHeadSha, lastSeenCommentId,
        r.MergedAt, r.ClosedAt, r.AvatarUrl);
}
```

- [ ] **Step 5: Run the tests to verify they pass + nothing regressed**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InboxViewedState"`
Expected: PASS (4 tests).
Then run the orchestrator suite to confirm the refactor is behavior-preserving:
Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InboxRefreshOrchestrator"`
Expected: PASS (unchanged).

- [ ] **Step 6: Commit**

```bash
git -C D:/src/PRism-285-inbox-unread-bar add PRism.Core/Inbox/InboxViewedState.cs PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/InboxViewedStateTests.cs
git -C D:/src/PRism-285-inbox-unread-bar commit -m "feat(#285): shared inbox viewed-state projection + ApplyViewedState overlay"
```

---

## Task 2: Apply the overlay on GET /api/inbox (Symptom-1 fix)

**Files:**
- Modify: `PRism.Web/Endpoints/InboxEndpoints.cs:30-60` (the `GET /api/inbox` handler)
- Test: `tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs`

This is the regression guard the bug actually needs: a `mark-viewed` write must be reflected on the very next GET, with **no** orchestrator refresh.

- [ ] **Step 1: Write the failing test**

Add to `tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs` (the file already has `using` for `PRism.Core.Contracts`, `PRism.Core.Inbox`, `PRism.Web.Tests.TestHelpers`; add `using PRism.Core.State;` at the top if not present):

```csharp
[Fact]
public async Task Get_inbox_overlays_live_viewed_state_without_a_refresh()
{
    // Snapshot baked with a STALE viewed head (as if the user had not yet viewed at the
    // current head): item head = "HEAD", baked LastViewedHeadSha = "STALE" → would render unread.
    var reference = new PrReference("acme", "api", 7);
    var staleItem = new PrInboxItem(
        reference, "Calc", "author", "acme/api",
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
        1, 0, 1, 0, "HEAD", CiStatus.None,
        LastViewedHeadSha: "STALE", LastSeenCommentId: null);
    var fakeOrch = new FakeInboxRefreshOrchestrator
    {
        Current = MakeSnapshot(new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { staleItem },
        }),
    };

    using var factory = new PRismWebApplicationFactory();
    factory.FakeOrchestrator = fakeOrch;
    var client = factory.CreateClient();   // triggers ConfigureWebHost → DataDir + DI ready

    // Live state: the user has since viewed the PR at the CURRENT head ("HEAD").
    var store = factory.Services.GetRequiredService<IAppStateStore>();
    await store.UpdateAsync(state =>
    {
        var session = new ReviewSessionState(
            new Dictionary<string, TabStamp> { ["t1"] = new TabStamp("HEAD", DateTime.UtcNow) },
            null, null, null,
            new Dictionary<string, string>(),
            new List<DraftComment>(), new List<DraftReply>(),
            null, DraftVerdictStatus.Draft);
        var sessions = new Dictionary<string, ReviewSessionState> { [reference.ToString()] = session };
        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
    }, CancellationToken.None);

    var resp = await client.GetAsync(new Uri("/api/inbox", UriKind.Relative));

    resp.StatusCode.Should().Be(HttpStatusCode.OK);
    var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
    var item = body.GetProperty("sections")[0].GetProperty("items")[0];
    item.GetProperty("lastViewedHeadSha").GetString().Should().Be("HEAD",
        "the GET overlay must re-project the live stamp over the stale baked value");
    fakeOrch.RefreshCalls.Should().Be(0,
        "the overlay reflects the write without triggering an orchestrator refresh");
}
```

Add `using Microsoft.Extensions.DependencyInjection;` and `using PRism.Core.State;` to the test file's usings if absent.

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Get_inbox_overlays_live_viewed_state"`
Expected: FAIL — `lastViewedHeadSha` is `"STALE"` (the endpoint serves the frozen snapshot, no overlay yet).

- [ ] **Step 3: Wire the overlay into the handler**

In `PRism.Web/Endpoints/InboxEndpoints.cs`, change the `GET /api/inbox` lambda to inject `IAppStateStore` and overlay. Add `using PRism.Core.State;` at the top. The handler becomes:

```csharp
app.MapGet("/api/inbox", async (
    IInboxRefreshOrchestrator orch,
    IConfigStore config,
    IAppStateStore stateStore,
    CancellationToken ct) =>
{
    if (orch.Current == null)
    {
        orch.TryColdStartRefresh();
        if (!await orch.WaitForFirstSnapshotAsync(TimeSpan.FromSeconds(10), ct).ConfigureAwait(false))
            return Results.Problem(
                title: "Inbox initializing",
                statusCode: 503,
                type: "/inbox/initializing");
    }
    // Re-project viewed-state live from state.json onto the cached snapshot, so a
    // mark-viewed write is reflected immediately (read-only; no GitHub refetch, no
    // orchestrator mutation). #285.
    var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
    var snap = InboxViewedState.ApplyViewedState(orch.Current!, state);
    var sections = snap.Sections
        .OrderBy(kv =>
        {
            var i = Array.IndexOf(SectionOrder, kv.Key);
            return i < 0 ? int.MaxValue : i;
        })
        .Select(kv => new InboxSectionDto(kv.Key, Labels.TryGetValue(kv.Key, out var lbl) ? lbl : kv.Key, kv.Value))
        .ToList();
    return Results.Ok(new InboxResponse(
        sections, snap.Enrichments, snap.LastRefreshedAt,
        config.Current.Inbox.ShowHiddenScopeFooter, snap.CiProbeComplete));
});
```

- [ ] **Step 4: Run the test to verify it passes + the rest of the endpoint suite is green**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~InboxEndpoints"`
Expected: PASS (all InboxEndpoints tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git -C D:/src/PRism-285-inbox-unread-bar add PRism.Web/Endpoints/InboxEndpoints.cs tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs
git -C D:/src/PRism-285-inbox-unread-bar commit -m "feat(#285): overlay live viewed-state on GET /api/inbox so the unread bar resets on view"
```

---

## Task 3: Real-backend e2e — bar clears after viewing a PR

**Files:**
- Create: `frontend/e2e/inbox-unread-reset.spec.ts`

This is a **real-backend** spec (`PRISM_E2E_FAKE_REVIEW=1`), not a mock-route one — the fix is backend, so a mocked `/api/inbox` would prove nothing. `FakePrDiscovery` surfaces the canonical scenario PR (`acme/api/123`, head = `store.CurrentHeadSha`, `LastViewedHeadSha: null`) in a "Review requested" section, so the inbox renders a clickable unread row. The row button carries `data-unread` (`InboxRow.tsx:94`). Helpers live in `frontend/e2e/helpers/s4-setup.ts`.

- [ ] **Step 1: Write the spec**

Create `frontend/e2e/inbox-unread-reset.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// #285 — the inbox row's left "new changes" bar must clear after the user opens the PR
// and returns to the inbox, without a manual reload. Real backend (FakePrDiscovery serves
// the scenario PR acme/api/123 in "Review requested" with lastViewedHeadSha=null → unread).
test.describe('inbox unread bar resets on view (#285)', () => {
  test.beforeEach(async ({ request }) => {
    await resetBackendState(request);
  });

  test('opening the PR and returning clears the row unread bar', async ({ page }) => {
    await setupAndOpenScenarioPr(page); // auths, lands on '/' (inbox)

    const row = page.getByRole('button', { name: /Calc utilities/i });
    await expect(row).toHaveAttribute('data-unread', 'true'); // never-viewed → unread (intended baseline)

    // Open the PR. usePrDetail fires the real POST mark-viewed stamping the current head.
    // Wait for that write to persist before returning, so the inbox refetch sees the stamp.
    const markViewed = page.waitForResponse(
      (r) => /\/api\/pr\/acme\/api\/123\/mark-viewed$/.test(r.url()) && r.request().method() === 'POST',
    );
    await row.click();
    await page.waitForURL('**/pr/acme/api/123**');
    await markViewed;

    // Return to the inbox via SPA history nav (unmount → remount → GET /api/inbox overlay).
    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/');

    // The overlay re-projects the fresh stamp → row is no longer unread.
    await expect(page.getByRole('button', { name: /Calc utilities/i }))
      .toHaveAttribute('data-unread', 'false');
  });
});
```

- [ ] **Step 2: Confirm the spec reproduces the bug (red), then passes (green)**

First confirm reproduction against the un-fixed endpoint: temporarily comment out the two overlay lines in `InboxEndpoints.cs` (the `var state = ...` + `var snap = InboxViewedState.ApplyViewedState(...)`) and restore `var snap = orch.Current!;`, then run the spec:
Run: `cd frontend && npx playwright test e2e/inbox-unread-reset.spec.ts`
Expected: FAIL at the final assertion — `data-unread` stays `"true"` (the frozen snapshot is served). This proves the test exercises the real bug.
Then **restore** the overlay lines and re-run:
Run: `cd frontend && npx playwright test e2e/inbox-unread-reset.spec.ts`
Expected: PASS.

(If editing the endpoint to force red is impractical in your harness, run once green and record in the PR that the divergence is independently guarded by `Get_inbox_overlays_live_viewed_state_without_a_refresh`, which is red without the overlay.)

- [ ] **Step 3: Commit**

```bash
git -C D:/src/PRism-285-inbox-unread-bar add frontend/e2e/inbox-unread-reset.spec.ts
git -C D:/src/PRism-285-inbox-unread-bar commit -m "test(#285): real-backend e2e — inbox unread bar clears after viewing a PR"
```

---

## Task 4: Full verification + documentation

**Files:**
- Possibly modify: a feature/README doc if one describes the inbox unread bar (scan per `.ai/docs/documentation-maintenance.md`).

- [ ] **Step 1: Backend full suite**

Run: `dotnet test`
Expected: all green, 0 warnings.

- [ ] **Step 2: Frontend typecheck + unit (no source change, but confirm nothing broke)**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: typecheck clean; vitest green (the existing `InboxRow` tests stay green unchanged — never-viewed → unread, viewed-matches → not unread).

- [ ] **Step 3: Prettier (raw — rtk masks the exit code)**

Run: `cd frontend && npx prettier --check .`
Expected: clean. If it reports the new spec, run `npx prettier --write e2e/inbox-unread-reset.spec.ts` and re-check.

- [ ] **Step 4: Documentation-maintenance scan**

Scan per `.ai/docs/documentation-maintenance.md` for any doc that describes inbox unread/"new changes" behavior. If one exists, add a line noting: unviewed open-category PRs read unread (fresh-install baseline; reverses #285's original AC#2 — intended), and the bar clears on view via the GET overlay. If none exists, no doc edit; record that in the PR `## Proof`.

- [ ] **Step 5: Confirm no visual-baseline drift**

The init render is unchanged, so the `inbox` visual baselines should not move. If a later CI e2e run reports a baseline diff on an inbox screenshot, do **not** blindly regenerate — investigate (it would signal init behavior changed unintentionally).

- [ ] **Step 6: Commit any doc change**

```bash
git -C D:/src/PRism-285-inbox-unread-bar add -A
git -C D:/src/PRism-285-inbox-unread-bar commit -m "docs(#285): note inbox unread-bar reset-on-view + intended fresh-install baseline"
```

(Skip this commit if Step 4 found no doc to update.)

---

## Acceptance criteria (from spec)

- [ ] After viewing a PR and returning to the inbox, that row's left bar clears without a manual reload (Task 2 endpoint guard + Task 3 e2e).
- [ ] On a fresh install, unviewed open-category PRs read unread; merged/closed never flagged (unchanged head-sha model; `ApplyViewedState` leaves unviewed items `null`).
- [ ] The bar tracks per-PR: clears on open, re-flags on a post-view head move (the projection compares the live stamp to the current head).
- [ ] Covered by backend (`InboxViewedState` unit + endpoint divergence) and e2e (reset-on-view); existing frontend `InboxRow` tests remain green unchanged.

## Notes for the PR

- Record the **AC#2 reversal** on the PR: "unviewed reads unread on a fresh install" is intended (owner decision), reversing the issue's original second symptom. So the bar appearing on every open PR on a fresh machine is **not** the bug returning.
- Gated (UI-visual): post the B1 proof (a short clip / before-after of a row's bar clearing after viewing) and **do not merge without owner B1 sign-off**.
