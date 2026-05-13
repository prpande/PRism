namespace PRism.Core.Storage;

/// <summary>
/// Temp-file-write-then-atomic-rename with Windows Defender / Search-Indexer retry. Used by
/// every PRism on-disk store that takes the temp-write-then-rename pattern
/// (<see cref="PRism.Core.State.AppStateStore"/>, <see cref="PRism.Core.Config.ConfigStore"/>).
/// Token cache stays out of scope because MSAL owns its own persistence wrap.
/// </summary>
/// <remarks>
/// On Windows, a previous File.Move can leave a transient handle on the destination
/// (Defender real-time scanner, Search Indexer, FileSystemWatcher) that races a follow-up
/// File.Move and causes UnauthorizedAccessException or a sharing-/lock-violation IOException.
/// Retry only those two transient classes with exponential backoff capped near 200ms; total
/// budget ~1.1s across 9 retries before the exception propagates on attempt 10. On final
/// exhaustion the temp file is best-effort-deleted so it does not orphan in the data directory.
/// The Windows AV/indexer race does not exist on Linux/macOS, so the first attempt typically
/// succeeds there with no measurable overhead.
/// </remarks>
public static class AtomicFileMove
{
    public static async Task MoveAsync(string source, string destination, CancellationToken ct)
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
            // On success this is a no-op (File.Move consumed the source); on exhaustion or any
            // non-retried exception, best-effort cleanup of the orphaned temp.
            try { if (File.Exists(source)) File.Delete(source); }
#pragma warning disable CA1031 // best-effort cleanup; the original move-failure exception is what matters.
            catch { }
#pragma warning restore CA1031
        }
    }

    // ERROR_SHARING_VIOLATION = 0x80070020 and ERROR_LOCK_VIOLATION = 0x80070021 are the two
    // HRESULTs that signal "another handle has the file" — exactly the AV/indexer race we want
    // to retry. UnauthorizedAccessException covers the related ACCESS_DENIED case that File
    // .Move's overwrite path raises when DELETE access on the destination is briefly held.
    // Other IOException subtypes (DirectoryNotFoundException, PathTooLongException,
    // FileNotFoundException, DriveNotFoundException) are not transient and propagate immediately.
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
}
