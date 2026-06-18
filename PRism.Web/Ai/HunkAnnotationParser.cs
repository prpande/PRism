using System.Text.Json;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.Web.Ai;

/// <summary>Pure structured-output harness for the hunk-annotation seam (spec §5). Parses the first
/// top-level JSON array of {path, hunkIndex, body, tone}, validates against the flagged-file set
/// (unknown paths / out-of-range hunk indices / unknown tones dropped — never invented), strips
/// control + Unicode bidi/directional-formatting characters from the body, dedups last-wins on
/// (path, hunkIndex, body), and enforces the cap as a DEFENSIVE BACKSTOP (D414-5: the prompt makes N
/// the contract, so a well-behaved model never exceeds it — if one does, keep the first `cap` valid
/// entries in the model's emitted order). No I/O.</summary>
internal static class HunkAnnotationParser
{
    /// <summary>Max characters of a single annotation body. An over-length body is DROPPED (not truncated)
    /// — a runaway body is more likely garbage than a real note, and dropping bounds what an injected
    /// payload can render (spec §5/§12).</summary>
    internal const int BodyCap = 600;

    /// <summary>Parse + validate + strip + dedup + cap. Returns false only when no top-level JSON array
    /// can be extracted (caller then retries / treats as parse failure). A valid-but-all-invalid array
    /// returns true with an empty list.</summary>
    internal static bool TryParse(
        string text, IReadOnlyList<FileChange> flaggedFiles, int cap, out IReadOnlyList<HunkAnnotation> entries)
    {
        entries = Array.Empty<HunkAnnotation>();
        var json = JsonArrayExtractor.ExtractFirstArray(text);
        if (json is null) return false;

        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return false;
            root = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return false;
        }

        // path → hunk count, for range validation (the parser has only the diff FileChanges — no focus level).
        var hunkCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var f in flaggedFiles) hunkCounts[f.Path] = f.Hunks.Count;

        // Preserve emitted order; dedup last-wins on (path, hunkIndex, body) by replacing in place.
        var ordered = new List<HunkAnnotation>();
        var slotByKey = new Dictionary<(string Path, int Index, string Body), int>();

        foreach (var el in root.EnumerateArray())
        {
            if (el.ValueKind != JsonValueKind.Object) continue;

            if (!el.TryGetProperty("path", out var pathEl) || pathEl.ValueKind != JsonValueKind.String) continue;
            var path = pathEl.GetString()!;
            if (!hunkCounts.TryGetValue(path, out var hunkCount)) continue;           // unknown path → drop

            if (!el.TryGetProperty("hunkIndex", out var idxEl) || idxEl.ValueKind != JsonValueKind.Number) continue;
            if (!idxEl.TryGetInt32(out var hunkIndex)) continue;
            if (hunkIndex < 0 || hunkIndex >= hunkCount) continue;                    // out-of-range → drop

            if (!el.TryGetProperty("tone", out var toneEl) || toneEl.ValueKind != JsonValueKind.String) continue;
            if (!TryTone(toneEl.GetString(), out var tone)) continue;                 // unknown tone → drop

            var rawBody = el.TryGetProperty("body", out var bodyEl) && bodyEl.ValueKind == JsonValueKind.String
                ? bodyEl.GetString() : null;
            var body = AiTextSanitizer.StripDangerous(rawBody).Trim();
            if (body.Length == 0 || body.Length > BodyCap) continue;                  // empty / over-length → drop

            // Dedup key INCLUDES body: only an exact (path, hunkIndex, body) repeat is a duplicate
            // (last-wins on tone). Two DIFFERENT bodies for the same hunk index both survive by design —
            // that is rare model behavior, and the cap backstop bounds the total either way.
            var key = (path, hunkIndex, body);
            var ann = new HunkAnnotation(path, hunkIndex, body, tone);
            if (slotByKey.TryGetValue(key, out var slot))
                ordered[slot] = ann;                                                  // last-wins (tone)
            else
            {
                slotByKey[key] = ordered.Count;
                ordered.Add(ann);
            }
        }

        // Defensive cap: keep the first `cap` valid entries in emitted order (D414-5). Response order is
        // the model's own ranking, so the backstop preserves rather than re-decides it.
        if (cap > 0 && ordered.Count > cap)
            ordered = ordered.GetRange(0, cap);

        entries = ordered;
        return true;
    }

    private static bool TryTone(string? raw, out AnnotationTone tone)
    {
        tone = AnnotationTone.Calm;
        if (raw is null) return false;
        var s = raw.Trim();
        if (string.Equals(s, "calm", StringComparison.OrdinalIgnoreCase)) { tone = AnnotationTone.Calm; return true; }
        if (string.Equals(s, "heads-up", StringComparison.OrdinalIgnoreCase)) { tone = AnnotationTone.HeadsUp; return true; }
        if (string.Equals(s, "concern", StringComparison.OrdinalIgnoreCase)) { tone = AnnotationTone.Concern; return true; }
        return false;
    }
}
