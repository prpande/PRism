using System.Net.Http.Json;

namespace PRism.Web.Tests.TestHelpers;

internal static class HttpClientHeaderExtensions
{
    public static async Task<HttpResponseMessage> PostAsJsonWithHeadersAsync<T>(
        this HttpClient client,
        string requestUri,
        T body,
        IDictionary<string, string>? headers = null,
        CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, requestUri)
        {
            Content = JsonContent.Create(body),
        };
        if (headers is not null)
            foreach (var (k, v) in headers)
                req.Headers.TryAddWithoutValidation(k, v);
        return await client.SendAsync(req, ct).ConfigureAwait(false);
    }

    public static async Task<HttpResponseMessage> PatchAsJsonWithHeadersAsync<T>(
        this HttpClient client,
        string requestUri,
        T body,
        IDictionary<string, string>? headers = null,
        CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Patch, requestUri)
        {
            Content = JsonContent.Create(body),
        };
        if (headers is not null)
            foreach (var (k, v) in headers)
                req.Headers.TryAddWithoutValidation(k, v);
        return await client.SendAsync(req, ct).ConfigureAwait(false);
    }
}
