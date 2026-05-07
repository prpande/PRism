# AppStateStore Windows rename retry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AppStateStore.SaveCoreAsync` resilient to the Windows AV/indexer race that intermittently makes `File.Move(temp, _path, overwrite: true)` throw `UnauthorizedAccessException`, fixing both the locally-flaky `SaveAsync_serializes_concurrent_writes` test and the corresponding production reliability hole.

**Architecture:** Extract the bare `File.Move` call at the tail of `SaveCoreAsync` into a private static `MoveWithRetryAsync` helper that retries on `UnauthorizedAccessException` and `IOException` with exponential backoff (10ms → 200ms cap, 9 retries, ~1.1s total budget) before letting the exception propagate. No new tests; the existing flaky test becomes the regression test.

**Tech Stack:** .NET 10, C#, xUnit, FluentAssertions.

**Spec:** `docs/superpowers/specs/2026-05-07-appstatestore-windows-rename-retry-design.md`

---

## File Structure

- **Modify:** `PRism.Core/State/AppStateStore.cs` — replace the bare `File.Move(temp, _path, overwrite: true)` in `SaveCoreAsync` with a call to a new private static `MoveWithRetryAsync(source, destination, ct)` method added to the same class.

No new files. No test changes.

---

## Task 1: Add retry to AppStateStore.SaveCoreAsync

**Files:**
- Modify: `PRism.Core/State/AppStateStore.cs`

This task follows red → green: the existing `SaveAsync_serializes_concurrent_writes` test fails on `main` (locally on Windows) — it is the failing test for TDD purposes. The production change makes it pass.

### Step 1.1: Confirm the test is currently red

Establish the baseline before making any production change.

- [ ] **Step 1.1: Confirm test fails on at least one of several runs**

Run from the repo root:

```
for i in 1 2 3 4 5; do dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SaveAsync_serializes_concurrent_writes" --nologo -v quiet 2>&1 | grep -E "Passed!|Failed!" | tail -1; done
```

Expected on Windows: at least one of the five runs reports `Failed!  - Failed: 1, Passed: 0` with `System.UnauthorizedAccessException : Access to the path is denied.` traced to `AppStateStore.cs:line 85`.

If all five runs pass, the AV race didn't fire on this machine — the test is still flaky in principle, but you can't verify the fix locally. Continue anyway; CI will be your verification gate.

If the failure stack trace is anything other than `UnauthorizedAccessException` or `IOException` from `File.Move`, **STOP** and report — the production cause is different from what the spec assumes.

### Step 1.2: Apply the retry change

Open `PRism.Core/State/AppStateStore.cs`. Find `SaveCoreAsync` at line 80. The current method:

```csharp
private async Task SaveCoreAsync(AppState state, CancellationToken ct)
{
    var temp = $"{_path}.tmp-{Guid.NewGuid():N}";
    var json = JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Storage);
    await File.WriteAllTextAsync(temp, json, ct).ConfigureAwait(false);
    File.Move(temp, _path, overwrite: true);
}
```

- [ ] **Step 1.2: Replace the bare File.Move with MoveWithRetryAsync, and add the helper method**

Replace `SaveCoreAsync` with:

```csharp
private async Task SaveCoreAsync(AppState state, CancellationToken ct)
{
    var temp = $"{_path}.tmp-{Guid.NewGuid():N}";
    var json = JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Storage);
    await File.WriteAllTextAsync(temp, json, ct).ConfigureAwait(false);
    await MoveWithRetryAsync(temp, _path, ct).ConfigureAwait(false);
}

// On Windows, a previous File.Move can leave a transient handle on the destination
// (Defender real-time scanner, Search Indexer, FileSystemWatcher) that races a
// follow-up File.Move and causes UnauthorizedAccessException or a sharing-/lock-
// violation IOException. Retry only those two transient classes with exponential
// backoff capped near 200ms; total budget ~1.1s across 9 retries before the
// exception propagates on attempt 10. On final exhaustion the temp file is
// best-effort-deleted so it does not orphan in the data directory. The Windows
// AV/indexer race does not exist on Linux/macOS, so the first attempt typically
// succeeds there with no measurable overhead.
private static async Task MoveWithRetryAsync(string source, string destination, CancellationToken ct)
{
    const int maxAttempts = 10;
    var delay = TimeSpan.FromMilliseconds(10);
    try
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                File.Move(source, destination, overwrite: true);
                return;
            }
            catch (Exception ex) when (IsTransientMoveError(ex) && attempt < maxAttempts)
            {
                await Task.Delay(delay, ct).ConfigureAwait(false);
                delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 200));
            }
        }
    }
    finally
    {
        // On success this is a no-op (File.Move consumed the source); on exhaustion
        // or any non-retried exception, best-effort cleanup of the orphaned temp.
        try { if (File.Exists(source)) File.Delete(source); }
#pragma warning disable CA1031 // best-effort cleanup; the original move-failure exception is what matters.
        catch { }
#pragma warning restore CA1031
    }
}

// ERROR_SHARING_VIOLATION = 0x80070020 and ERROR_LOCK_VIOLATION = 0x80070021 are the
// two HRESULTs that signal "another handle has the file" — exactly the AV/indexer race
// we want to retry. UnauthorizedAccessException covers the related ACCESS_DENIED case
// that File.Move's overwrite path raises when DELETE access on the destination is
// briefly held. Other IOException subtypes (DirectoryNotFoundException,
// PathTooLongException, FileNotFoundException, DriveNotFoundException) are not
// transient and propagate immediately.
private static bool IsTransientMoveError(Exception ex)
{
    if (ex is UnauthorizedAccessException) return true;
    if (ex is IOException
        && ex is not DirectoryNotFoundException
        && ex is not PathTooLongException
        && ex is not FileNotFoundException
        && ex is not DriveNotFoundException)
    {
        var hr = ex.HResult & 0xFFFF;
        return hr == 0x20 || hr == 0x21;
    }
    return false;
}
```

Notes for the implementer:
- Place `MoveWithRetryAsync` and `IsTransientMoveError` directly below `SaveCoreAsync` in the class.
- Do not add `using` directives — `System.IO`, `System.Threading`, and `System.Threading.Tasks` are already in scope (the file uses `File`, `JsonSerializer`, `CancellationToken`, etc.).
- Do not change `_gate`, `LoadAsync`, or any other method.
- Do not modify the test file `tests/PRism.Core.Tests/State/AppStateStoreTests.cs`.

### Step 1.3: Run the targeted test 10 times to confirm green

- [ ] **Step 1.3: Run the test 10× and verify 10/10 pass**

```
for i in 1 2 3 4 5 6 7 8 9 10; do dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SaveAsync_serializes_concurrent_writes" --nologo -v quiet 2>&1 | grep -E "Passed!|Failed!" | tail -1; done
```

Expected: all 10 runs report `Passed! - Failed: 0, Passed: 1`.

If any run still fails:
- If failure is `UnauthorizedAccessException` from `File.Move` after the retry: the budget may be too short for this machine. Report back as DONE_WITH_CONCERNS — do not silently bump the budget.
- If failure is something else (e.g., `JsonException`, `OperationCanceledException`): the retry isn't the issue; report back as BLOCKED with the trace.

### Step 1.4: Run the full PRism.Core.Tests project to check for regressions

- [ ] **Step 1.4: Run full PRism.Core.Tests project**

```
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --nologo -v quiet
```

Expected: `Passed! - Failed: 0, Passed: 82, Skipped: 0, Total: 82`.

If any test that previously passed now fails, the change is the suspect — investigate before committing.

### Step 1.5: Run PRism.Web.Tests and PRism.GitHub.Tests to confirm no cross-project regressions

The other two test projects don't depend on `AppStateStore`'s rename behavior, but `PRism.Web.Tests` does construct `AppStateStore` instances via DI (`Program.cs` line 30). Run them to be sure.

- [ ] **Step 1.5: Run the other two test projects**

```
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --nologo -v quiet
```

Then:

```
dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --nologo -v quiet
```

Expected:
- `PRism.Web.Tests`: 28 passed / 0 failed.
- `PRism.GitHub.Tests`: 17 passed / 0 failed.

### Step 1.6: Commit

- [ ] **Step 1.6: Commit**

The working tree currently has `M frontend/package-lock.json` and an untracked `.claude/` directory. **Do not stage these.** Stage only `PRism.Core/State/AppStateStore.cs`.

```
git add PRism.Core/State/AppStateStore.cs
git commit -m "$(cat <<'EOF'
fix(state): retry File.Move on Windows AV/indexer race in AppStateStore

SaveCoreAsync's File.Move(temp, _path, overwrite: true) intermittently throws
UnauthorizedAccessException on Windows when Defender, Search Indexer, or a
FileSystemWatcher briefly holds a handle on _path between successive saves.
Wrap the move in MoveWithRetryAsync: exponential backoff (10ms doubling, capped
at 200ms) for up to 9 retries (~1.1s total budget) on UnauthorizedAccessException
and IOException, then propagate. No-op on Linux/macOS.

Fixes the local flakiness of AppStateStoreTests.SaveAsync_serializes_concurrent_writes
(which now serves as the regression test) and closes a real production state-loss
hole for Windows users with AV active.

Spec: docs/superpowers/specs/2026-05-07-appstatestore-windows-rename-retry-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

1. **Spec coverage:**
   - Spec's "Change" section (the `MoveWithRetryAsync` body, retry schedule, exception filter, cancellation) → Step 1.2 reproduces the code verbatim.
   - Spec's "Why not add a unit test" decision → Plan adds no new tests; the existing test in Step 1.3 is the regression test.
   - Spec's "Verification" section (10× targeted, full Core suite, Web + GitHub for regressions) → Steps 1.3, 1.4, 1.5.
   - Spec's "Out of scope" items (LoadAsync quarantine, logging, `_gate`, test changes) → none touched in any step.
2. **Placeholders:** none.
3. **Type consistency:** `MoveWithRetryAsync(string source, string destination, CancellationToken ct)` is referenced once (Step 1.2) and called once (Step 1.2 inside `SaveCoreAsync`). Names match.
