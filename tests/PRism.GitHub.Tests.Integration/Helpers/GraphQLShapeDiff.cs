using System.Text.Json;

namespace PRism.GitHub.Tests.Integration.Helpers;

public static class GraphQLShapeDiff
{
    /// <summary>
    /// Structural diff over two JsonElement trees. Returns a list of human-readable diff lines:
    ///   + /pointer (kind)              — present in actual, missing in expected
    ///   - /pointer                     — present in expected, missing in actual
    ///   ~ /pointer (kindA → kindB)     — same pointer, different JsonValueKind
    /// Arrays diff positionally by index. The differ asserts STRUCTURE (presence + kind), not value
    /// equality on primitives — value drift in PR-data is caught by other tests; this differ
    /// targets shape drift in GitHub's GraphQL schema.
    /// </summary>
    public static IReadOnlyList<string> Diff(JsonElement expected, JsonElement actual)
    {
        var results = new List<string>();
        Walk("", expected, actual, results);
        return results;
    }

    private static void Walk(string pointer, JsonElement expected, JsonElement actual, List<string> diffs)
    {
        if (expected.ValueKind != actual.ValueKind)
        {
            diffs.Add($"~ {Pointer(pointer)} ({expected.ValueKind} → {actual.ValueKind})");
            return;
        }

        switch (expected.ValueKind)
        {
            case JsonValueKind.Object:
                WalkObject(pointer, expected, actual, diffs);
                break;
            case JsonValueKind.Array:
                WalkArray(pointer, expected, actual, diffs);
                break;
            // Primitives: same ValueKind is sufficient for shape; value-level diff is out of scope.
            default:
                break;
        }
    }

    private static void WalkObject(string pointer, JsonElement expected, JsonElement actual, List<string> diffs)
    {
        var expectedNames = new HashSet<string>();
        foreach (var prop in expected.EnumerateObject())
        {
            expectedNames.Add(prop.Name);
            if (actual.TryGetProperty(prop.Name, out var actualChild))
                Walk(Combine(pointer, prop.Name), prop.Value, actualChild, diffs);
            else
                diffs.Add($"- {Pointer(Combine(pointer, prop.Name))}");
        }
        foreach (var prop in actual.EnumerateObject())
        {
            if (!expectedNames.Contains(prop.Name))
                diffs.Add($"+ {Pointer(Combine(pointer, prop.Name))} ({prop.Value.ValueKind})");
        }
    }

    private static void WalkArray(string pointer, JsonElement expected, JsonElement actual, List<string> diffs)
    {
        var expectedLen = expected.GetArrayLength();
        var actualLen = actual.GetArrayLength();
        var shared = Math.Min(expectedLen, actualLen);
        for (var i = 0; i < shared; i++)
            Walk(Combine(pointer, i.ToString(System.Globalization.CultureInfo.InvariantCulture)), expected[i], actual[i], diffs);
        for (var i = shared; i < expectedLen; i++)
            diffs.Add($"- {Pointer(Combine(pointer, i.ToString(System.Globalization.CultureInfo.InvariantCulture)))}");
        for (var i = shared; i < actualLen; i++)
            diffs.Add($"+ {Pointer(Combine(pointer, i.ToString(System.Globalization.CultureInfo.InvariantCulture)))} ({actual[i].ValueKind})");
    }

    private static string Combine(string parent, string child) =>
        parent.Length == 0 ? "/" + Escape(child) : parent + "/" + Escape(child);

    // RFC 6901 token escaping for the two reserved characters.
    private static string Escape(string token) =>
        token.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);

    private static string Pointer(string pointer) => pointer.Length == 0 ? "/" : pointer;
}
