namespace PRism.GitHub;

// #320 — single RFC-8288 `Link` header parser. Returns the ABSOLUTE URL GitHub put in
// the header for a given rel ("next" | "last" | ...). Replaces three divergent parsers
// (page-number / relative-path / absolute-Uri). Callers adapt the absolute URL to what
// they need (parse &page=, or `new Uri(...)`). Standardizes on quoted-or-unquoted rel
// (GitHub always quotes; the unquoted branch matches the most-tolerant prior parser).
// (#322 added a `TryGetNext`-shaped variant for the reviews/CI walks; this PR folds it
// into the general `TryGetRel("next", ...)` so there is exactly one Link parser.)
internal static class GitHubLinkHeader
{
    internal static bool TryGetRel(HttpResponseMessage resp, string rel, out string url)
    {
        url = string.Empty;
        if (!resp.Headers.TryGetValues("Link", out var values)) return false;

        var quoted = $"rel=\"{rel}\"";
        var unquoted = $"rel={rel}";
        foreach (var header in values)
        {
            foreach (var part in header.Split(','))
            {
                var segments = part.Split(';');
                if (segments.Length < 2) continue;
                var urlSegment = segments[0].Trim();
                if (!urlSegment.StartsWith('<') || !urlSegment.EndsWith('>')) continue;

                var matched = false;
                for (var i = 1; i < segments.Length && !matched; i++)
                {
                    var attr = segments[i].Trim();
                    if (attr.Equals(quoted, StringComparison.Ordinal)
                        || attr.Equals(unquoted, StringComparison.Ordinal))
                        matched = true;
                }
                if (!matched) continue;

                // Only surface a well-formed ABSOLUTE URL. Callers either send it (a malformed
                // value handed to `new HttpRequestMessage` would throw UriFormatException out of
                // the caller — e.g. aborting the whole inbox tick, violating the CI detector's
                // "never block the inbox" contract) or parse its query. Mirrors the per-parser
                // Uri.TryCreate guard the prior parsers had, so a malformed Link value is a clean
                // miss (pagination stops), not a throw.
                var candidate = urlSegment[1..^1];
                if (!Uri.TryCreate(candidate, UriKind.Absolute, out _)) continue;
                url = candidate;
                return true;
            }
        }
        return false;
    }
}
