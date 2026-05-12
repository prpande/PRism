using System.Diagnostics;

namespace PRism.Web.Tests.TestHelpers;

internal static class TestPoll
{
    // Polls `condition` every 25ms until it returns true or `timeout` elapses. Used to wait on a
    // fire-and-forget submit pipeline whose effects (FinalizeCalled, published bus events) land
    // asynchronously after the 200 "started" response. Throws TimeoutException if it never holds.
    // Uses Stopwatch (monotonic) for the elapsed-time bound so an NTP/CI clock adjustment can't
    // make the wait end early or hang.
    public static async Task UntilAsync(Func<bool> condition, TimeSpan timeout, string? because = null)
    {
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed < timeout)
        {
            if (condition()) return;
            await Task.Delay(25).ConfigureAwait(false);
        }
        if (condition()) return;
        throw new TimeoutException($"Condition not met within {timeout}{(because is null ? "" : $": {because}")}");
    }
}
