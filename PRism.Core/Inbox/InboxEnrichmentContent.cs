using System.Security.Cryptography;
using System.Text;

namespace PRism.Core.Inbox;

/// Stable content token over a PR's enrichment inputs (title + description). The enricher
/// stamps each result with the token it was computed from; the orchestrator recomputes it
/// from the live snapshot item and applies the result only on a match — so a slow batch for
/// a now-edited PR cannot overwrite a fresher category (#410).
public static class InboxEnrichmentContent
{
    public static string Token(string title, string? description)
    {
        // U+0000 separator + a null/empty sentinel so ("T", null) != ("T", "").
        var material = $"{title} {(description is null ? "null" : description)}";
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        return Convert.ToHexString(bytes);
    }
}
