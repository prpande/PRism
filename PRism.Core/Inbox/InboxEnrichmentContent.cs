using System.Security.Cryptography;
using System.Text;
using System;

namespace PRism.Core.Inbox;

/// Stable content token over a PR's enrichment inputs (title + description). The enricher
/// stamps each result with the token it was computed from; the orchestrator recomputes it
/// from the live snapshot item and applies the result only on a match — so a slow batch for
/// a now-edited PR cannot overwrite a fresher category (#410).
public static class InboxEnrichmentContent
{
    public static string Token(string title, string? description)
    {
        ArgumentNullException.ThrowIfNull(title);

        // Length-prefixed, space-separated fields so boundaries are unambiguous: no choice of
        // (title, description) can collide with another, and a null description is distinct
        // from every string value (including "" and the literal "null"). (#410 content guard.)
        var material = description is null
            ? $"{title.Length} {title} null"
            : $"{title.Length} {title} {description.Length} {description}";
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        return Convert.ToHexString(bytes);
    }
}
