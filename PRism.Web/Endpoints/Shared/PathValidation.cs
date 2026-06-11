using System.Text;

namespace PRism.Web.Endpoints;

internal static class PathValidation
{
    /// <summary>
    /// Canonicalizes a repo-relative file path. Returns the NFC-normalized path, or null
    /// if invalid. Rejects a superset of the prior draft-side validator: 4096-byte length cap,
    /// segment-split (bare <c>..</c> and empty segments), control chars, backslash, NFC bypass guard.
    /// </summary>
    /// <remarks>
    /// The /viewed route enforces its own pre-check of <c>Encoding.UTF8.GetByteCount(path) &gt; 4096</c>
    /// before calling <c>PrDetailEndpoints.CanonicalizePath</c>. The draft side had its length
    /// cap INSIDE the validator. This shared helper inlines the byte-count cap here so no
    /// call site can accidentally omit it — the cap is load-bearing for AppState DoS prevention.
    /// DO NOT remove the byte-count guard.
    /// </remarks>
    internal static string? Canonicalize(string path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        if (Encoding.UTF8.GetByteCount(path) > 4096) return null; // length cap — DO NOT DROP
        if (path.StartsWith('/') || path.EndsWith('/')) return null;
        if (path.Contains('\\', StringComparison.Ordinal)) return null;
        foreach (var c in path)
        {
            if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) return null;
        }
        var segments = path.Split('/');
        foreach (var s in segments)
        {
            if (s.Length == 0 || s == ".." || s == ".") return null;
        }
        var nfc = path.Normalize(NormalizationForm.FormC);
        if (Encoding.UTF8.GetByteCount(nfc) != Encoding.UTF8.GetByteCount(path)) return null;
        return nfc;
    }
}
