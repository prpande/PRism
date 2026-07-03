using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

internal static partial class TabStamps
{
    internal const string TabIdHeader = "X-PRism-Tab-Id";
    internal const int MaxTabStamps = 8;

    // Spec § 3 — X-PRism-Tab-Id allowlist: 1-64 chars from [a-zA-Z0-9_-]. The single source of
    // truth for the CSRF custom-header gate shared by mark-viewed, reload, submit, the lifecycle
    // routes, and the /test mark-pr-viewed hook. Each caller keeps its own bespoke rejection
    // envelope (the frontend discriminators must stay distinct — #666), but the load-bearing
    // check — is this tab id present and well-formed — is decided here so the next mutating
    // endpoint can't copy a neighbour and silently drop half the gate.
    [GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
    private static partial Regex TabIdAllowlistRegex();

    /// <summary>True when <paramref name="tabId"/> is present and passes the § 3 allowlist. Use
    /// this for the value-in-hand case (e.g. a tab id arriving in a request body); prefer
    /// <see cref="TryValidateTabId"/> when reading it off the request header.</summary>
    internal static bool IsValidTabId(string? tabId) =>
        !string.IsNullOrEmpty(tabId) && TabIdAllowlistRegex().IsMatch(tabId);

    /// <summary>Reads <see cref="TabIdHeader"/> off the request and validates it against the § 3
    /// allowlist. Returns true and sets <paramref name="tabId"/> to the exact header value on
    /// success; returns false (with <paramref name="tabId"/> = <see cref="string.Empty"/>) on a
    /// missing or out-of-allowlist value, so the caller can return its own 4xx envelope.</summary>
    internal static bool TryValidateTabId(HttpRequest request, out string tabId)
    {
        var candidate = request.Headers[TabIdHeader].FirstOrDefault();
        if (IsValidTabId(candidate))
        {
            tabId = candidate!;
            return true;
        }
        // Never hand back an unvalidated value: tabId is string.Empty on every failure (missing
        // OR out-of-allowlist), so a caller can't accidentally use a poisoned tab id after false.
        tabId = string.Empty;
        return false;
    }

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
