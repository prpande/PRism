namespace PRism.Core.State;

internal static class MonotonicCommentId
{
    internal static string? Max(string? current, string? incoming)
    {
        if (!long.TryParse(incoming, out var inc)) return current;
        if (!long.TryParse(current, out var cur)) return incoming;
        return inc > cur ? incoming : current;
    }
}
