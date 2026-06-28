using System.Text.Json;
using System.Text.Json.Serialization;

namespace PRism.Core.Json;

public static class JsonSerializerOptionsFactory
{
    // For state.json / config.json file persistence — kebab-case property names per spec.
    public static JsonSerializerOptions Storage { get; } = BuildStorage();

    // For API wire — camelCase property names (frontend convention), kebab-case enums.
    public static JsonSerializerOptions Api { get; } = BuildApi();

    // For PARTIAL/SPARSE SSE update frames where an ABSENT field means "unchanged/unknown"
    // (the frontend's snapshot() keeps its fallback), NOT "cleared". Use this instead of Api
    // when the event record carries intentional nulls only because it was constructed with a
    // sparse subset of fields — an explicit null in a sparse frame would clobber full-load
    // values via snapshot(). The normal fanout path stays on Api (its nulls are real clears).
    public static JsonSerializerOptions ApiSparse { get; } = BuildApi(omitNulls: true);

    // Backwards-compat alias.
    public static JsonSerializerOptions Default => Storage;

    private static JsonSerializerOptions BuildStorage()
    {
        var policy = new KebabCaseJsonNamingPolicy();
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = policy,
            // Intentionally NOT setting DictionaryKeyPolicy: dictionary keys are user data
            // (file paths, repo identifiers) that must round-trip identically. Kebab-casing
            // them mangles paths containing uppercase characters such as "src/Foo.cs".
            WriteIndented = false,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
            PropertyNameCaseInsensitive = false,
        };
        options.Converters.Add(new JsonStringEnumConverter(new KebabCaseJsonNamingPolicy()));
        return options;
    }

    private static JsonSerializerOptions BuildApi(bool omitNulls = false)
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
            PropertyNameCaseInsensitive = false,
        };
        if (omitNulls)
        {
            // Sparse SSE frames: omit null members so the frontend's snapshot() keeps its fallback
            // instead of treating an explicit null as an authoritative clear. See ApiSparse above.
            options.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        }
        options.Converters.Add(new JsonStringEnumConverter(new KebabCaseJsonNamingPolicy()));
        return options;
    }
}
