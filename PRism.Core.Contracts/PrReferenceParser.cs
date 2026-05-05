using System.Text.RegularExpressions;

namespace PRism.Core.Contracts;

public static partial class PrReferenceParser
{
    [GeneratedRegex(@"^(?<owner>[A-Za-z0-9_.\-]+)/(?<repo>[A-Za-z0-9_.\-]+)/(?<number>[1-9][0-9]*)$")]
    private static partial Regex Pattern();

    public static bool TryParse(string? input, out PrReference? result)
    {
        result = null;
        if (string.IsNullOrEmpty(input)) return false;

        var m = Pattern().Match(input);
        if (!m.Success) return false;

        if (!int.TryParse(m.Groups["number"].Value, out var n)) return false;

        result = new PrReference(m.Groups["owner"].Value, m.Groups["repo"].Value, n);
        return true;
    }
}
