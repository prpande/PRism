# AppStateStore Windows rename retry — design

**Date:** 2026-05-07
**Scope:** `PRism.Core/State/AppStateStore.cs`
**Out of scope:** Test changes, `LoadAsync`, `_gate` semantics, logging.

## Problem

`PRism.Core.Tests.State.AppStateStoreTests.SaveAsync_serializes_concurrent_writes` is flaky locally on Windows (~80% failure rate observed) and green in CI. The failure is not a flaky-test problem — it's a flaky-production-code problem the test exposes:

```
System.UnauthorizedAccessException : Access to the path is denied.
   at System.IO.FileSystem.MoveFile(String, String, Boolean)
   at PRism.Core.State.AppStateStore.SaveCoreAsync(...) AppStateStore.cs:line 85
```

Line 85 is `File.Move(temp, _path, overwrite: true);`. The `SemaphoreSlim _gate` correctly serializes saves within the process — only one `File.Move` runs at a time. The race is between `File.Move` calls and **out-of-process** Windows components (Defender real-time scanner, Search Indexer, `FileSystemWatcher` notifications) that briefly hold a handle on `_path` after a previous `File.Move` completes.

Sequence:
1. Save N's `File.Move(temp, _path, overwrite=true)` completes; `_path` released.
2. Defender / Indexer / watcher opens `_path` for a sub-millisecond inspection.
3. Save N+1's `File.Move` begins; can't acquire `DELETE` access on the destination → `UnauthorizedAccessException`.

CI passes because `windows-latest` runners exclude the agent workspace from Defender. Local Windows dev boxes don't, so the race fires.

This is a real production bug: end users on Windows with AV active will hit `UnauthorizedAccessException` during state saves at low (but non-zero) rates and lose state. The test's 50-saves-in-a-row pattern just exposes it more reliably.

## Approach

**Retry the rename** with exponential backoff on `UnauthorizedAccessException` and `IOException`. Standard pattern (used by MSBuild, NuGet, etc.) for the Windows AV/indexer race. Production becomes reliable; the existing flaky test stops flaking as a side effect and serves as the regression test.

Two alternatives were considered and rejected:
- **Test-only mitigation** (reduce concurrency / add jitter): hides the production fragility. Rejected.
- **Open the destination with `FileShare.Delete` and use `RENAME_INFO_EX`**: lower-level, requires P/Invoke, and doesn't help when the *other* process holds the handle. Rejected.

## Change

In `PRism.Core/State/AppStateStore.cs`, replace the bare `File.Move` at the tail of `SaveCoreAsync` with a call to a new private static `MoveWithRetryAsync`, plus a `IsTransientMoveError` predicate that narrows the catch:

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

**Retry schedule** (worst case, all attempts but the last fail): waits of 10, 20, 40, 80, 160, 200, 200, 200, 200 ms = ~1.1s total across 9 retries, then attempt 10's exception propagates.

**Cancellation:** `Task.Delay(delay, ct)` honors the caller's `CancellationToken`.

**Exception filter:** only `UnauthorizedAccessException` and `IOException` whose `HResult & 0xFFFF` equals `0x20` (`ERROR_SHARING_VIOLATION`) or `0x21` (`ERROR_LOCK_VIOLATION`) are retried. Other `IOException` subtypes (`DirectoryNotFoundException`, `PathTooLongException`, `FileNotFoundException`, `DriveNotFoundException`) and unrelated exception types propagate immediately on the first attempt — there's no point burning the retry budget on conditions that won't clear.

**Temp-file cleanup:** the retry loop is wrapped in `try/finally`. On success the `finally` is a no-op (`File.Move` consumed the source). On exhaustion or any non-retried exception, the temp file is best-effort-deleted so it doesn't orphan in the data directory.

## Why not add a unit test for the retry?

A direct test would need a fake file system or `IFileSystem` abstraction injected into `AppStateStore` — meaningful infrastructure for a one-method change. The existing `SaveAsync_serializes_concurrent_writes` test already exercises the failure mode reliably on Windows; if the retry is ever removed or weakened, the test starts flaking again with the same `UnauthorizedAccessException` signature. That coverage is sufficient for now. If `IFileSystem` is added later for other reasons, add a direct retry test then.

## Verification

After the change:
- Run `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SaveAsync_serializes_concurrent_writes"` 10 times — expect 10/10 pass.
- Run the full `PRism.Core.Tests` suite — expect all tests to pass.
- Run `PRism.Web.Tests` and `PRism.GitHub.Tests` — expect no regressions (neither depends on `AppStateStore`'s rename behavior).

## Out of scope

- **`LoadAsync` quarantine path.** It uses `File.Move(overwrite: false)` with a unique-suffixed destination (`state.json.corrupt-<timestamp>`); destination doesn't pre-exist, so the AV race doesn't apply the same way. Separate concern if it ever flakes.
- **Logging retries.** `AppStateStore` has no `ILogger` today. Plumbing one in is scope creep. Production telemetry can be added separately if state-save reliability becomes a concern.
- **`_gate` semantics.** Already correct.
- **Test changes.** The existing flaky test becomes the regression test.
