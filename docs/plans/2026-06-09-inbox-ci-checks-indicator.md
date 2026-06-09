# Inbox CI Checks Indicator (#264) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `CiStatus.Passing` state and render all four inbox CI states (passing / failing / pending / none) with GitHub-parity octicons in the inbox row.

**Architecture:** Widen the `CiStatus` wire enum with `Passing`; teach `GitHubCiFailingDetector` to emit it (count check-run *entries* not pages; map `success`+registered-statuses to Passing; precedence `Failing > Pending > Passing > None`; keep Passing degraded-not-cached). On the frontend, replace the CSS-drawn dot/ring with three inline Primer octicons (✓ / ✗ / ●) at 14px, carrying CI state in the existing row `aria-label`.

**Tech Stack:** .NET 10 (xUnit + FluentAssertions), React + Vite + TypeScript (Vitest + Testing Library), Playwright (B1 visual proof).

**Spec:** `docs/specs/2026-06-09-inbox-ci-checks-indicator-design.md`

---

## File Structure

**Backend (modify):**
- `PRism.Core.Contracts/CiStatus.cs` — add `Passing` member.
- `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs` — `FetchChecksAsync` (anyRun), `FetchCombinedStatusAsync` (success→Passing), `ProbeAsync` (precedence).

**Backend (test):**
- `tests/PRism.Core.Tests/Contracts/CiStatusSerializationTests.cs` — **create**; kebab/lower wire round-trip.
- `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs` — extend; new fixtures + tests, flip `All_passing_marks_none`.

**Frontend (modify):**
- `frontend/src/api/types.ts` — add `'passing'` to the `CiStatus` union.
- `frontend/src/components/Inbox/InboxRow.tsx` — octicon rendering + aria/title.
- `frontend/src/components/Inbox/InboxRow.module.css` — add `.ci*` rules; delete `.dot*`; reserve slot width.

**Frontend (test):**
- `frontend/src/components/Inbox/InboxRow.test.tsx` — update CI tests, add passing.

**B1 proof (no production code):**
- A Playwright route-mock script that renders all four states in light + dark for the PR screenshots.

---

## Notes for the implementer

- **Run one build/test at a time, foreground, timeout ≥ 300000ms.** Never parallelize `dotnet test` / `dotnet build`.
- **All commands run in the worktree** `D:\src\PRism-264-ci-indicator`. The tool cwd resets to the main checkout each call — prefix with `cd /d/src/PRism-264-ci-indicator &&`.
- **Octicon paths** below are Primer octicons v19, 16-unit viewBox. They are embedded verbatim — copy exactly. Any path error is caught at the B1 visual gate.
- **Backend dotnet test filter:** `dotnet test --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"` (and `~CiStatusSerializationTests`).
- **Frontend single-file test:** `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`.
- Adding `Passing` to the enum is source-compatible — no exhaustive C# `switch` over `CiStatus` exists that would fail to compile (verified: `ProbeAsync`/`Fetch*` use if-chains / `_ =>` fallthrough; `InboxRefreshOrchestrator` only equality-compares against `Failing`). A PR that reclassifies `None`→`Passing` once will emit a single "updated" event on that tick — a one-time, acceptable blip (same class as the #286 note), not a defect.

---

## Task 1: Add `Passing` to the `CiStatus` enum + wire-serialization test

**Files:**
- Modify: `PRism.Core.Contracts/CiStatus.cs`
- Test (create): `tests/PRism.Core.Tests/Contracts/CiStatusSerializationTests.cs`

- [ ] **Step 1: Write the failing serialization test**

Create `tests/PRism.Core.Tests/Contracts/CiStatusSerializationTests.cs`:

```csharp
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Json;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class CiStatusSerializationTests
{
    [Theory]
    [InlineData(CiStatus.None, "\"none\"")]
    [InlineData(CiStatus.Pending, "\"pending\"")]
    [InlineData(CiStatus.Failing, "\"failing\"")]
    [InlineData(CiStatus.Passing, "\"passing\"")]
    public void CiStatus_serializes_kebab_case(CiStatus s, string expected)
    {
        // The frontend union mirror (frontend/src/api/types.ts) depends on these
        // exact lowercase wire strings — 'passing' must match the React literal.
        var json = JsonSerializer.Serialize(s, JsonSerializerOptionsFactory.Api);
        json.Should().Be(expected);
    }
}
```

- [ ] **Step 2: Run it to verify it fails (does not compile — `Passing` undefined)**

Run: `cd /d/src/PRism-264-ci-indicator && dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~CiStatusSerializationTests"`
Expected: BUILD FAIL — `'CiStatus' does not contain a definition for 'Passing'`.

- [ ] **Step 3: Add the `Passing` member**

Edit `PRism.Core.Contracts/CiStatus.cs` to:

```csharp
namespace PRism.Core.Contracts;

public enum CiStatus
{
    None,
    Pending,
    Failing,
    Passing,
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /d/src/PRism-264-ci-indicator && dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~CiStatusSerializationTests"`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
cd /d/src/PRism-264-ci-indicator && git add PRism.Core.Contracts/CiStatus.cs tests/PRism.Core.Tests/Contracts/CiStatusSerializationTests.cs && git commit -m "feat(#264): add CiStatus.Passing wire enum member

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Detector emits `Passing` for all-green check-runs (FetchChecksAsync + ProbeAsync)

This is the core backend behavior. The test goes through the public `DetectAsync`, so it exercises `FetchChecksAsync` (must count run *entries*) and `ProbeAsync` (must have a Passing precedence branch) together.

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs:86-164` (`FetchChecksAsync`) and `:61-78` (`ProbeAsync` precedence). Line numbers below are approximate — anchor on the quoted code snippets, which match the file verbatim.
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`

- [ ] **Step 1: Flip the existing all-passing test to expect Passing**

In `GitHubCiFailingDetectorTests.cs`, replace the `All_passing_marks_none` test with:

```csharp
    [Fact]
    public async Task All_passing_marks_passing()
    {
        // All check-runs completed successfully and the combined status is success
        // with no registered legacy statuses → (Passing, None) → Passing (#264).
        var handler = RouterHandler(AllPassingCheckRuns, AllPassingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Passing);
    }
```

- [ ] **Step 2: Add the empty-array guard test (the ce-doc-review C1 catch)**

Add this test right after `All_passing_marks_passing`:

```csharp
    [Fact]
    public async Task Empty_check_runs_with_no_statuses_marks_none()
    {
        // An EMPTY check_runs array is "no checks", NOT "all checks passed". The
        // detector must count check-run *entries*, not the array's presence —
        // otherwise a no-CI PR shows a false green tick (the passing-side analogue
        // of the #286 false-amber bug). AllPassingStatus is success+empty-statuses
        // → None, so both sources are None → None.
        var handler = RouterHandler(EmptyCheckRuns, AllPassingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.None);
    }
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd /d/src/PRism-264-ci-indicator && dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests.All_passing_marks_passing|FullyQualifiedName~GitHubCiFailingDetectorTests.Empty_check_runs_with_no_statuses_marks_none"`
Expected: `All_passing_marks_passing` FAILS (got `None`, expected `Passing`); `Empty_check_runs_with_no_statuses_marks_none` PASSES already (current code returns None for both). The failing one drives the implementation.

- [ ] **Step 4: Add `anyRun` entry-counting to `FetchChecksAsync`**

In `GitHubCiFailingDetector.cs`, in `FetchChecksAsync`, add an `anyRun` flag alongside `anyFailing`/`anyPending` and set it inside the entry loop. The current header (around line 86-90) is:

```csharp
        var anyFailing = false;
        var anyPending = false;
        var anyPage = false;
```

Change to:

```csharp
        var anyFailing = false;
        var anyPending = false;
        var anyPage = false;
        var anyRun = false; // at least one check-run ENTRY seen (not just the array). #264
```

Then in the per-entry loop (currently around line 151-157):

```csharp
            foreach (var r in runs.EnumerateArray())
            {
                var status = r.GetProperty("status").GetString();
                var conclusion = r.TryGetProperty("conclusion", out var cn) ? cn.GetString() : null;
                if (status != "completed") { anyPending = true; continue; }
                if (conclusion is "failure" or "timed_out" or "cancelled") anyFailing = true;
            }
```

add `anyRun = true;` as the first statement inside the loop body:

```csharp
            foreach (var r in runs.EnumerateArray())
            {
                anyRun = true; // a check-run entry exists → eligible for Passing. #264
                var status = r.GetProperty("status").GetString();
                var conclusion = r.TryGetProperty("conclusion", out var cn) ? cn.GetString() : null;
                if (status != "completed") { anyPending = true; continue; }
                if (conclusion is "failure" or "timed_out" or "cancelled") anyFailing = true;
            }
```

Finally, change the method's return (currently the last line, around line 163):

```csharp
        return (anyFailing ? CiStatus.Failing : (anyPending ? CiStatus.Pending : CiStatus.None), false);
```

to:

```csharp
        // anyRun (≥1 entry) + nothing failing/pending → Passing; no entries → None. #264
        return (anyFailing
            ? CiStatus.Failing
            : anyPending
                ? CiStatus.Pending
                : anyRun ? CiStatus.Passing : CiStatus.None, false);
```

Also update the mid-method degraded early-return (the `if (!resp.IsSuccessStatusCode)` block, around line 134-138) — it currently returns `None` when nothing is failing/pending; with a partially-read page that already saw passing runs we cannot claim Passing (a later page might fail), so leave it returning the degraded `None`. **No change needed there** — degraded reads must not assert Passing.

- [ ] **Step 5: Add the `Passing` precedence branch to `ProbeAsync`**

In `ProbeAsync` (around line 75-77), the current tail is:

```csharp
        if (checks == CiStatus.Failing || statuses == CiStatus.Failing) return (CiStatus.Failing, false);
        if (checks == CiStatus.Pending || statuses == CiStatus.Pending) return (CiStatus.Pending, degraded);
        return (CiStatus.None, degraded);
```

Insert a Passing branch between Pending and None:

```csharp
        if (checks == CiStatus.Failing || statuses == CiStatus.Failing) return (CiStatus.Failing, false);
        if (checks == CiStatus.Pending || statuses == CiStatus.Pending) return (CiStatus.Pending, degraded);
        // Passing is degraded-flagged like Pending/None: a Passing read from one source
        // while the OTHER source returned a non-2xx could mask a hidden Failing, so it
        // must NOT be cached — only a definitively-observed Failing is cacheable. (#264/#213)
        if (checks == CiStatus.Passing || statuses == CiStatus.Passing) return (CiStatus.Passing, degraded);
        return (CiStatus.None, degraded);
```

- [ ] **Step 6: Run the two tests to verify they pass**

Run: `cd /d/src/PRism-264-ci-indicator && dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests.All_passing_marks_passing|FullyQualifiedName~GitHubCiFailingDetectorTests.Empty_check_runs_with_no_statuses_marks_none"`
Expected: PASS (2).

- [ ] **Step 7: Run the full detector suite to confirm no regression**

Run: `cd /d/src/PRism-264-ci-indicator && dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"`
Expected: PASS (all). Note: `Failure_status_marks_failing`, `Cache_hit_skips_http`, and `Cache_invalidates_on_head_sha_change` still pass — they assert Failing or request counts, and a non-degraded Passing is still cached.

- [ ] **Step 8: Commit**

```bash
cd /d/src/PRism-264-ci-indicator && git add PRism.GitHub/Inbox/GitHubCiFailingDetector.cs tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs && git commit -m "feat(#264): detector emits Passing for all-green check-runs

Count check-run entries (anyRun), not array presence, so an empty
check_runs array stays None. Add Failing>Pending>Passing>None precedence.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Detector emits `Passing` from a registered success combined-status

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs:223-228` (`FetchCombinedStatusAsync` switch)
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`

- [ ] **Step 1: Add a success-with-registered-statuses fixture**

In `GitHubCiFailingDetectorTests.cs`, add next to the other status fixtures (after `PendingStatusNoTotalCount`):

```csharp
    // A registered legacy commit status that has SUCCEEDED (total_count > 0, success).
    // Distinct from AllPassingStatus, whose empty statuses array means "no legacy
    // statuses registered" → None under #286 semantics.
    private const string SuccessRegisteredStatus = """
        { "state": "success", "total_count": 1, "statuses": [ { "context": "ci/legacy", "state": "success" } ] }
        """;
```

- [ ] **Step 2: Write the two combined-status success tests**

Add after `Combined_status_pending_with_statuses_but_no_total_count_marks_pending`:

```csharp
    [Fact]
    public async Task Combined_status_success_with_registered_statuses_marks_passing()
    {
        // A registered legacy status that succeeded is a positive signal. With empty
        // check-runs, (None, Passing) → Passing (#264).
        var handler = RouterHandler(EmptyCheckRuns, SuccessRegisteredStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Passing);
    }

    [Fact]
    public async Task Combined_status_success_with_no_registered_statuses_marks_none()
    {
        // #286 reinforcement on the success branch: state="success" with NO registered
        // statuses (empty statuses, no total_count) is "no legacy CI configured", not a
        // positive signal. With empty check-runs too → None (no false green tick).
        var handler = RouterHandler(EmptyCheckRuns, AllPassingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.None);
    }
```

- [ ] **Step 3: Run them to verify the first fails**

Run: `cd /d/src/PRism-264-ci-indicator && dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests.Combined_status_success_with_registered_statuses_marks_passing|FullyQualifiedName~GitHubCiFailingDetectorTests.Combined_status_success_with_no_registered_statuses_marks_none"`
Expected: `..._with_registered_statuses_marks_passing` FAILS (got `None`); `..._with_no_registered_statuses_marks_none` PASSES (current `_ => None` already yields None).

- [ ] **Step 4: Map registered `success` to Passing in `FetchCombinedStatusAsync`**

In `GitHubCiFailingDetector.cs`, the current switch (around line 223-228) is:

```csharp
        var status = state switch
        {
            "failure" or "error" => CiStatus.Failing,
            "pending" when HasRegisteredStatuses(doc.RootElement) => CiStatus.Pending,
            _ => CiStatus.None,
        };
```

Add a `success` arm gated on the same `HasRegisteredStatuses` helper:

```csharp
        var status = state switch
        {
            "failure" or "error" => CiStatus.Failing,
            "pending" when HasRegisteredStatuses(doc.RootElement) => CiStatus.Pending,
            // A registered success is a positive signal → Passing. Success with no
            // registered statuses stays None (the #286 "no legacy CI" case). (#264)
            "success" when HasRegisteredStatuses(doc.RootElement) => CiStatus.Passing,
            _ => CiStatus.None,
        };
```

- [ ] **Step 5: Run the two tests to verify they pass**

Run: `cd /d/src/PRism-264-ci-indicator && dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests.Combined_status_success_with_registered_statuses_marks_passing|FullyQualifiedName~GitHubCiFailingDetectorTests.Combined_status_success_with_no_registered_statuses_marks_none"`
Expected: PASS (2).

- [ ] **Step 6: Commit**

```bash
cd /d/src/PRism-264-ci-indicator && git add PRism.GitHub/Inbox/GitHubCiFailingDetector.cs tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs && git commit -m "feat(#264): map registered success combined-status to Passing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Precedence + degraded-not-cached for Passing (edge cases)

**Files:**
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs` (no production change — these lock the behavior implemented in Task 2/3)

- [ ] **Step 1: Write the precedence + degraded tests**

Add after the tests from Task 3:

```csharp
    [Fact]
    public async Task Passing_checks_with_pending_status_marks_pending()
    {
        // Precedence: Pending outranks Passing. Green check-runs + a genuinely
        // in-progress legacy status → (Passing, Pending) → Pending (#264).
        var handler = RouterHandler(AllPassingCheckRuns, RegisteredPendingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items[0].Ci.Should().Be(CiStatus.Pending);
    }

    [Fact]
    public async Task Passing_while_other_source_degraded_is_not_cached()
    {
        // #264/#213: a Passing observed while the OTHER source 5xx'd must NOT be cached —
        // the unread source could hide a Failing. The next tick must re-probe and reflect
        // the recovered status (here the combined-status endpoint recovers to failure).
        var recovered = false;
        var handler = new FakeHttpMessageHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
            // /status: degraded (503) first tick, then recovers to a failure status.
            return recovered
                ? Respond(HttpStatusCode.OK, FailureStatus)
                : Respond(HttpStatusCode.ServiceUnavailable, "{}");
        });
        var sut = BuildSut(handler);

        var first = await sut.DetectAsync([Raw(1)], default);
        first.Items[0].Ci.Should().Be(CiStatus.Passing,
            "checks are green and the degraded status source contributes nothing this tick");

        recovered = true;
        var second = await sut.DetectAsync([Raw(1)], default);
        second.Items[0].Ci.Should().Be(CiStatus.Failing,
            "the degraded Passing must not have been cached — the recovered tick re-probes and sees the failure");
    }
```

- [ ] **Step 2: Run them to verify they pass (behavior already implemented in Task 2/3)**

Run: `cd /d/src/PRism-264-ci-indicator && dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests.Passing_checks_with_pending_status_marks_pending|FullyQualifiedName~GitHubCiFailingDetectorTests.Passing_while_other_source_degraded_is_not_cached"`
Expected: PASS (2). If `Passing_while_other_source_degraded_is_not_cached` fails on the second assertion, the `ProbeAsync` Passing branch is returning a non-degraded flag — re-check Step 5 of Task 2 (it must return `(CiStatus.Passing, degraded)`, not `(..., false)`).

- [ ] **Step 3: Run the full GitHub test project**

Run: `cd /d/src/PRism-264-ci-indicator && dotnet test tests/PRism.GitHub.Tests`
Expected: PASS (all).

- [ ] **Step 4: Commit**

```bash
cd /d/src/PRism-264-ci-indicator && git add tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs && git commit -m "test(#264): lock Passing precedence and degraded-not-cached behavior

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add `'passing'` to the frontend `CiStatus` union

**Files:**
- Modify: `frontend/src/api/types.ts:81`

- [ ] **Step 1: Widen the union**

Change `frontend/src/api/types.ts:81` from:

```typescript
export type CiStatus = 'none' | 'pending' | 'failing';
```

to:

```typescript
export type CiStatus = 'none' | 'pending' | 'failing' | 'passing';
```

- [ ] **Step 2: Typecheck the frontend (catches exhaustiveness gaps)**

Run: `cd /d/src/PRism-264-ci-indicator/frontend && npm run build`
Expected: PASS. `tsc -b` runs as part of the build (`--noEmit` is vacuous in this project-references setup). It will compile cleanly: in `frontend/src/components/Inbox/filters/FilterBar.tsx`, `CI_VALUES: CiStatus[] = ['failing', 'pending']` is a valid subset of the widened union and does not error.

- [ ] **Step 3: Commit**

```bash
cd /d/src/PRism-264-ci-indicator && git add frontend/src/api/types.ts && git commit -m "feat(#264): add 'passing' to frontend CiStatus union

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Render octicons for all four states in `InboxRow`

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

- [ ] **Step 1: Update the existing CI tests + add the passing test**

In `InboxRow.test.tsx`, replace the entire `describe('InboxRow CI dot', ...)` block (lines 113-147) with:

```tsx
describe('InboxRow CI glyph', () => {
  it('renders a passing check glyph and names it in the aria-label for open PRs', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'passing' });
    expect(container.querySelector('[data-ci="passing"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI passing');
  });

  it('renders a failing x glyph and names it in the aria-label for open PRs', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'failing' });
    expect(container.querySelector('[data-ci="failing"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI failing');
  });

  it('renders a pending dot glyph and names it in the aria-label for open PRs', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'pending' });
    expect(container.querySelector('[data-ci="pending"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI pending');
  });

  it('shows no CI glyph and no CI suffix when ci is none', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'none' });
    expect(container.querySelector('[data-ci]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('CI ');
    // the status slot is still present (width-reserving placeholder), so the
    // title column doesn't reflow when CI state changes
    expect(container.querySelector('[class*="status"]')!.children).toHaveLength(1);
  });

  it('never shows a CI glyph or CI suffix on a done (merged) PR even when ci=failing', () => {
    const { container } = renderInboxRow({
      ...PR,
      ci: 'failing',
      mergedAt: new Date().toISOString(),
    });
    expect(container.querySelector('[data-ci]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('CI ');
  });

  it('still shows a passing glyph when ci is passing on an open PR', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'passing' });
    const glyph = container.querySelector('[data-ci="passing"]')!;
    expect(glyph.tagName.toLowerCase()).toBe('svg');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /d/src/PRism-264-ci-indicator/frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: FAIL — `[data-ci="passing"]` not found, etc. (current markup uses `dotFailing`/`dotPending` classes and no passing branch).

- [ ] **Step 3: Add the octicon constants at module level**

In `InboxRow.tsx`, add these module-level constants just above the `interface Props` declaration (top of file, after the imports). `VisibleCi` is the three glyph-bearing states; typing the records by it (not `keyof typeof styles`, which `vite/client` widens to `string | number`) keeps the lookups exhaustive and clean:

```tsx
// The three CI states that render a glyph (`none` renders only a placeholder).
type VisibleCi = 'passing' | 'failing' | 'pending';

// Primer octicons (v19), 16-unit viewBox. Filled circle variants — distinguished
// by their interior mark (✓ / ✗ / plain dot). See spec Decision 1.
const CI_GLYPH_PATH: Record<VisibleCi, string> = {
  passing:
    'M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.94 5.28 8.47a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z',
  failing:
    'M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z',
  pending: 'M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
};

const CI_GLYPH_CLASS: Record<VisibleCi, string> = {
  passing: 'ciPassing',
  failing: 'ciFailing',
  pending: 'ciPending',
};

// Single source of truth for the CI label — used for BOTH the aria-label suffix
// and the sighted-only <title> hover tooltip (DRY).
const CI_GLYPH_LABEL: Record<VisibleCi, string> = {
  passing: 'CI passing',
  failing: 'CI failing',
  pending: 'CI pending',
};
```

> The glyphs render **uncoloured** between this task and Task 7 (the `.ciPassing`/etc. colour classes don't exist yet — `vite/client` types CSS modules loosely so `styles.ciPassing` is just `undefined` until then). That is expected mid-implementation; Task 7 adds the colour.

- [ ] **Step 4: Replace the `ciSuffix` derivation and the status-slot JSX**

In `InboxRow.tsx`, replace the `ciSuffix` block (currently lines 44-50):

```tsx
  const ciSuffix =
    !isDone && pr.ci === 'failing'
      ? ' · CI failing'
      : !isDone && pr.ci === 'pending'
        ? ' · CI pending'
        : '';
```

with (the `pr.ci !== 'none'` guard narrows `pr.ci` to `VisibleCi`, so the `CI_GLYPH_LABEL` index typechecks):

```tsx
  // CI state rides the row aria-label (the glyph is aria-hidden). `none` and done
  // rows contribute nothing. Reuses CI_GLYPH_LABEL so suffix + tooltip never drift.
  const ciSuffix = !isDone && pr.ci !== 'none' ? ` · ${CI_GLYPH_LABEL[pr.ci]}` : '';
```

Then replace the entire status-slot JSX (currently lines 65-82, the `<span className={styles.status}>...</span>` block) with:

```tsx
      <span className={styles.status}>
        {!isDone && pr.ci !== 'none' ? (
          <svg
            className={`${styles.ci} ${styles[CI_GLYPH_CLASS[pr.ci]]}`}
            data-ci={pr.ci}
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="currentColor"
            aria-hidden="true"
          >
            {/* aria-hidden: AT reads CI state from the row aria-label. The <title>
                child is a sighted-only hover tooltip. */}
            <title>{CI_GLYPH_LABEL[pr.ci]}</title>
            <path d={CI_GLYPH_PATH[pr.ci]} />
          </svg>
        ) : (
          <span className={styles.ciPlaceholder} aria-hidden="true" />
        )}
      </span>
```

> Note: `pr.ci !== 'none'` narrows `pr.ci` to `'passing' | 'failing' | 'pending'`, so the `CI_GLYPH_*` record lookups typecheck without a cast.

- [ ] **Step 5: Run the InboxRow tests to verify they pass**

Run: `cd /d/src/PRism-264-ci-indicator/frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS (all CI-glyph tests + the untouched click/avatar/title/meta/tail/chip tests).

- [ ] **Step 6: Commit**

```bash
cd /d/src/PRism-264-ci-indicator && git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.test.tsx && git commit -m "feat(#264): render GitHub-parity CI octicons in InboxRow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Style the octicons; remove the old dot CSS; reserve slot width

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.module.css:42-69`

- [ ] **Step 1: Replace the `.dot*` rules with `.ci*` rules**

In `InboxRow.module.css`, the current block (lines 42-69) is:

```css
.status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dotFailing {
  background: var(--danger-fg);
}

/* Hollow ring — shape distinguishes pending from failing without relying on
   hue, so CI state reads in greyscale / for colour-blind users / against any
   user-chosen accent. Explicit border-box (not just the global reset) keeps the
   1.5px border inside the 8×8 dot rather than expanding it to ~11px. */
.dotPending {
  box-sizing: border-box;
  background: transparent;
  border: 1.5px solid var(--warning-fg);
}
```

Replace it with:

```css
.status {
  /* The column width is reserved by the grid TRACK on .row
     (grid-template-columns: 16px ...), not by this element — so no width here.
     The 14px glyph (or the .ciPlaceholder) sits centred in that 16px track. */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

/* Shared octicon sizing. Hue carries semantic meaning (green/red/amber); the
   interior mark (✓ / ✗ / dot) carries it independently of hue for greyscale and
   colour-blind readers. See spec Decision 1 + the B1 greyscale-legibility check.
   14px in the 16px track leaves a ~1px optical margin each side. */
.ci {
  display: block;
  width: 14px;
  height: 14px;
}

.ciPassing {
  color: var(--success-fg);
}

.ciFailing {
  color: var(--danger-fg);
}

.ciPending {
  color: var(--warning-fg);
}

/* `none`: an empty, width-only placeholder so the slot never collapses. */
.ciPlaceholder {
  display: block;
  width: 14px;
  height: 14px;
}
```

- [ ] **Step 2: Verify no other selector references the removed classes**

Run: `cd /d/src/PRism-264-ci-indicator && grep -rn "dotFailing\|dotPending" frontend/src` (Grep tool equivalent)
Expected: **no matches.** (`styles.dot` in `AccentSwatches`, `WindowControls`, `PrTabStrip` are their own CSS modules — unaffected. The InboxRow `.dot` placeholder JSX was removed in Task 6.)

- [ ] **Step 3: Build + run the full frontend test suite**

Run: `cd /d/src/PRism-264-ci-indicator/frontend && npm run build && npx vitest run`
Expected: build PASS (typecheck clean); vitest all green.

- [ ] **Step 4: Commit**

```bash
cd /d/src/PRism-264-ci-indicator && git add frontend/src/components/Inbox/InboxRow.module.css && git commit -m "feat(#264): style CI octicons, drop dot/ring CSS, reserve slot width

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: B1 visual proof — all four states, light + dark

This is the owner sign-off gate. It produces screenshots for the PR; it is not a merge-blocking automated test. The `FakePrDiscovery` seam only emits `CiStatus.None`, so the four states are forced by mocking the `/api/inbox` payload in a Playwright route (the #272/#273 approach).

**Files:**
- Create (throwaway, not committed to the app): a Playwright script under the worktree, e.g. `tmp/b1-264.spec.ts`, OR reuse the existing e2e harness with a route mock.

- [ ] **Step 1: Launch the app for B1**

Run: `cd /d/src/PRism-264-ci-indicator && ./run.ps1 -Port 5180 -Reset None --no-browser` (use the detached launcher `serve-detached.ps1` if a long-lived server is needed; `-Port` MUST precede `--no-browser`).

- [ ] **Step 2: Mock the inbox payload with one PR per CI state**

Use a Playwright route that fulfils `**/api/inbox` (and the auth/state endpoints, per the #272/#273 mock) with a section containing four open PRs whose `ci` values are `passing`, `failing`, `pending`, `none` respectively (each open: `mergedAt: null, closedAt: null`, distinct `headSha`/`lastViewedHeadSha` so they're not flagged unread, valid `additions`/`deletions`/`commentCount`). Reuse the `PrInboxItem` shape from `frontend/src/api/types.ts`.

- [ ] **Step 3: Capture light + dark screenshots**

Capture the inbox in both themes (toggle via the theme control or the `data-theme` attribute / settings). Save four images: `b1-264-light.png`, `b1-264-dark.png`, plus a desaturated copy of each (`-grey.png`) for the greyscale-legibility check (CSS `filter: grayscale(1)` on the inbox, or post-process the PNG).

- [ ] **Step 4: Greyscale + contrast self-check**

Inspect the desaturated shots: confirm `passing` (✓) and `failing` (✗) remain distinguishable at 14px. If they collapse, apply the spec Decision 1 fallback (keep `pending` as a hollow ring and/or bump glyph size) and re-capture. Confirm each coloured glyph meets AA against the row surface in both themes.

- [ ] **Step 5: Post the screenshots to the PR for owner sign-off**

Host the PNGs on a throwaway `review-assets/pr-264` branch and embed via raw URLs in a PR comment (the house B1 convention). **Do not merge** until the owner approves the visual.

---

## Definition of Done

- [ ] All backend tests green: `cd /d/src/PRism-264-ci-indicator && dotnet test` (one run, foreground).
- [ ] All frontend tests green + build clean: `cd /d/src/PRism-264-ci-indicator/frontend && npm run build && npx vitest run`.
- [ ] Lint/format clean — run prettier **directly** (rtk masks it): `cd /d/src/PRism-264-ci-indicator/frontend && node ./node_modules/prettier/bin/prettier.cjs --check . && npm run lint`.
- [ ] Full pre-push checklist in `.ai/docs/development-process.md` executed.
- [ ] Sync `origin/main` into the branch before pushing.
- [ ] B1 screenshots posted; **owner visual sign-off obtained before merge** (this issue is gated).
- [ ] PR opened via `pr-autopilot`; `@claude review` + Copilot addressed.

---

## Spec → task coverage check

| Spec section | Task |
|---|---|
| Backend enum `Passing` + wire `"passing"` | Task 1 |
| FetchChecksAsync `anyRun` (empty array → None) | Task 2 |
| ProbeAsync `Failing > Pending > Passing > None` | Task 2 |
| FetchCombinedStatusAsync registered `success` → Passing | Task 3 |
| Degraded-not-cached for Passing | Task 4 |
| FE union `'passing'` | Task 5 |
| Octicons (14px) + aria suffix + `<title>` hover, non-interactive `<span>` | Task 6 |
| `none` width-reserving placeholder; delete `.dot*` CSS | Task 6 (JSX) + Task 7 (CSS) |
| Existing semantic tokens (`--success-fg`/`--danger-fg`/`--warning-fg`) | Task 7 |
| FilterBar `CI_VALUES` unchanged (no regression) | Task 5 Step 2 (typecheck confirms) |
| B1: all four states, light+dark, via `/api/inbox` mock; greyscale + contrast checks | Task 8 |
