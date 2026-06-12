using System.Text;
using PRism.Core.Contracts;

namespace PRism.Web.Ai;

/// <summary>Renders a <see cref="DiffDto"/> to the unified-diff-ish text the summarizer sends the LLM —
/// file paths + synthesized @@ headers + hunk bodies. A pure static function so the actual LLM input is
/// unit-asserted (not deferred to manual). Never uses <c>FileChange.ToString()</c> (it emits the record's
/// type-name string). <see cref="DiffHunk"/> has no Header field; the @@ line is synthesized from the
/// numeric <c>OldStart / OldLines / NewStart / NewLines</c> fields.</summary>
internal static class PrDiffText
{
    internal static string Render(DiffDto diff)
    {
        ArgumentNullException.ThrowIfNull(diff);
        var sb = new StringBuilder();
        foreach (var f in diff.Files)
        {
            sb.Append("--- ").AppendLine(f.Path);
            foreach (var h in f.Hunks)
            {
                // Synthesize the @@ header from the numeric fields (DiffHunk has no Header property).
                sb.Append("@@ -").Append(h.OldStart).Append(',').Append(h.OldLines)
                  .Append(" +").Append(h.NewStart).Append(',').Append(h.NewLines).AppendLine(" @@");
                sb.AppendLine(h.Body);
            }
        }
        if (diff.Truncated) sb.AppendLine("[diff truncated]");
        return sb.ToString();
    }
}
