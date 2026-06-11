namespace PRism.GitHub;

/// <summary>
/// Parses a GitHub <c>Link</c> response header and returns the absolute URL whose
/// attributes include <c>rel="next"</c>, or null if none. Format:
/// <c>&lt;url1&gt;; rel="next", &lt;url2&gt;; rel="last"</c>. Node IDs / URLs are opaque —
/// the absolute URL is handed straight back to HttpClient. (#322; extracted from
/// GitHubCiFailingDetector so the reviews walk can share it.)
/// </summary>
internal static class GitHubLinkHeader
{
    public static Uri? TryGetNext(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("Link", out var values)) return null;
        foreach (var header in values)
        {
            foreach (var part in header.Split(','))
            {
                var segments = part.Split(';');
                if (segments.Length < 2) continue;
                var urlSegment = segments[0].Trim();
                if (!urlSegment.StartsWith('<') || !urlSegment.EndsWith('>')) continue;
                var hasNext = false;
                for (var i = 1; i < segments.Length; i++)
                {
                    var attr = segments[i].Trim();
                    if (attr.Equals("rel=\"next\"", StringComparison.Ordinal)
                        || attr.Equals("rel=next", StringComparison.Ordinal))
                    {
                        hasNext = true;
                        break;
                    }
                }
                if (!hasNext) continue;
                var url = urlSegment[1..^1];
                if (Uri.TryCreate(url, UriKind.Absolute, out var uri)) return uri;
            }
        }
        return null;
    }
}
