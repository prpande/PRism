using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace PRism.Web.Endpoints;

internal enum JsonReadError { None, InvalidJson, NotObject, WrongContentType }

internal readonly record struct JsonObjectReadResult(JsonDocument? Document, JsonReadError Error);

/// <summary>Outcome of a typed body read. On success <see cref="Value"/> holds the deserialized
/// payload (which may itself be null for a literal <c>null</c> body) and <see cref="Error"/> is
/// <see cref="JsonReadError.None"/>. On failure <see cref="Value"/> is default and <see cref="Error"/>
/// is <see cref="JsonReadError.WrongContentType"/> or <see cref="JsonReadError.InvalidJson"/>.</summary>
internal readonly record struct JsonReadResult<T>(T? Value, JsonReadError Error);

internal static class HttpJson
{
    /// <summary>Reads the request body as a JSON object. On success Document is non-null and
    /// the caller owns disposal. On failure Document is null and Error says why; the caller maps
    /// Error to its own error DTO so existing envelopes are preserved.</summary>
    internal static async Task<JsonObjectReadResult> TryReadJsonObjectAsync(HttpContext ctx, CancellationToken ct)
    {
        JsonDocument doc;
        try
        {
            doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return new JsonObjectReadResult(null, JsonReadError.InvalidJson);
        }
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
        {
            doc.Dispose();
            return new JsonObjectReadResult(null, JsonReadError.NotObject);
        }
        return new JsonObjectReadResult(doc, JsonReadError.None);
    }

    /// <summary>Reads and deserializes the request body as <typeparamref name="T"/>, single-sourcing
    /// the documented trap that <see cref="HttpRequestJsonExtensions.ReadFromJsonAsync{T}"/> throws
    /// <see cref="InvalidOperationException"/> (→ unhandled 500), NOT <see cref="JsonException"/>, when
    /// the request lacks a JSON Content-Type. Pre-checks the content type, then catches JSON parse
    /// errors. Returns the deserialized value with <see cref="JsonReadError.None"/> on success, or a
    /// default value with <see cref="JsonReadError.WrongContentType"/> / <see cref="JsonReadError.InvalidJson"/>
    /// so the caller maps the error to its own envelope (existing shapes preserved).</summary>
    internal static async Task<JsonReadResult<T>> TryReadJsonAsync<T>(HttpRequest request, CancellationToken ct)
    {
        if (!request.HasJsonContentType())
            return new JsonReadResult<T>(default, JsonReadError.WrongContentType);
        try
        {
            var value = await request.ReadFromJsonAsync<T>(ct).ConfigureAwait(false);
            return new JsonReadResult<T>(value, JsonReadError.None);
        }
        catch (JsonException)
        {
            return new JsonReadResult<T>(default, JsonReadError.InvalidJson);
        }
    }
}
