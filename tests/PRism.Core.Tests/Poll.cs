using System.Diagnostics;

namespace PRism.Core.Tests;

// Monotonic poll-until helper for async BackgroundService integration tests.
// Polls every 25ms; throws TimeoutException if the condition never holds.
// Mirrors TestPoll in PRism.Web.Tests but lives here so PRism.Core.Tests
// can use it without a cross-project reference.
internal static class Poll
{
    public static async Task Until(Func<bool> condition, TimeSpan timeout, string? because = null)
    {
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed < timeout)
        {
            if (condition()) return;
            await Task.Delay(25).ConfigureAwait(false);
        }
        if (condition()) return;
        throw new TimeoutException(
            $"Condition not met within {timeout}" +
            (because is null ? "" : $": {because}"));
    }
}
