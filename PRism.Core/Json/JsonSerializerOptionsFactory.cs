using System.Text.Json;
using System.Text.Json.Serialization;

namespace PRism.Core.Json;

public static class JsonSerializerOptionsFactory
{
    // For state.json / config.json file persistence — kebab-case property names per spec.
    public static JsonSerializerOptions Storage { get; } = BuildStorage();

    // For API wire — camelCase property names (frontend convention), kebab-case enums.
    public static JsonSerializerOptions Api { get; } = BuildApi();

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

    private static JsonSerializerOptions BuildApi()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
            PropertyNameCaseInsensitive = false,
        };
        options.Converters.Add(new JsonStringEnumConverter(new KebabCaseJsonNamingPolicy()));
        return options;
    }
}
