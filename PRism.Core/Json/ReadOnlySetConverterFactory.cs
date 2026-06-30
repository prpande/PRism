using System.Text.Json;
using System.Text.Json.Serialization;

namespace PRism.Core.Json;

/// <summary>
/// Teaches System.Text.Json to read and write <see cref="IReadOnlySet{T}"/>. STJ does not have
/// built-in support for that interface (unlike IReadOnlyList/IReadOnlyDictionary), so without this
/// factory deserialization throws NotSupportedException. Reads produce a <see cref="HashSet{T}"/>,
/// which satisfies the interface; the default equality comparer is used (ordinal for strings).
/// </summary>
internal sealed class ReadOnlySetConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) =>
        typeToConvert.IsGenericType &&
        typeToConvert.GetGenericTypeDefinition() == typeof(IReadOnlySet<>);

    public override JsonConverter CreateConverter(Type typeToConvert, JsonSerializerOptions options)
    {
        var elementType = typeToConvert.GetGenericArguments()[0];
        var converterType = typeof(ReadOnlySetConverter<>).MakeGenericType(elementType);
        return (JsonConverter)Activator.CreateInstance(converterType)!;
    }
}

internal sealed class ReadOnlySetConverter<T> : JsonConverter<IReadOnlySet<T>>
{
    public override IReadOnlySet<T>? Read(
        ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        JsonSerializer.Deserialize<HashSet<T>>(ref reader, options);

    public override void Write(
        Utf8JsonWriter writer, IReadOnlySet<T> value, JsonSerializerOptions options)
    {
        // Write directly to avoid re-invoking this converter via IReadOnlySet<T>.
        writer.WriteStartArray();
        foreach (var item in value)
            JsonSerializer.Serialize(writer, item, options);
        writer.WriteEndArray();
    }
}
