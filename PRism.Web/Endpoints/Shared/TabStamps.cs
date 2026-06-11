using PRism.Core.State;

namespace PRism.Web.Endpoints;

internal static class TabStamps
{
    internal const string TabIdHeader = "X-PRism-Tab-Id";
    internal const int MaxTabStamps = 8;

    /// <summary>Returns a new stamp dictionary (the input is not mutated) with tabId set to
    /// (headSha, nowUtc), evicting the oldest <see cref="TabStamp.StampedAtUtc"/> entries while
    /// over the <see cref="MaxTabStamps"/> cap.</summary>
    internal static Dictionary<string, TabStamp> Write(
        IReadOnlyDictionary<string, TabStamp> existing, string tabId, string headSha, DateTime nowUtc)
    {
        var stamps = existing.ToDictionary(kv => kv.Key, kv => kv.Value);
        stamps[tabId] = new TabStamp(headSha, nowUtc);
        while (stamps.Count > MaxTabStamps)
        {
            var oldest = stamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
            stamps.Remove(oldest);
        }
        return stamps;
    }
}
