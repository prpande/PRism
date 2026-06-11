using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace PRism.Web.Endpoints;

internal enum JsonReadError { None, InvalidJson, NotObject }

internal readonly record struct JsonObjectReadResult(JsonDocument? Document, JsonReadError Error);

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
}
