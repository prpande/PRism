using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.GitHub.Activity;

// Fault-isolated watched-repos reader. Mirrors GitHubNotificationsReader:
// degrade-don't-throw on ANY non-success / transport failure.
public sealed class GitHubWatchedReposReader : IWatchedReposReader
{
    private const int PerPage = 100;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;

    public GitHubWatchedReposReader(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<WatchedReposResult> ReadAsync(CancellationToken ct)
    {
        try
        {
            var token = await _readToken().ConfigureAwait(false);
            using var http = _httpFactory.CreateClient("github");
            var url = $"user/subscriptions?per_page={PerPage}";
            using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return new WatchedReposResult([], Degraded: true);

            using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return new WatchedReposResult([], Degraded: true);

            var list = new List<string>(doc.RootElement.GetArrayLength());
            foreach (var el in doc.RootElement.EnumerateArray())
                if (el.TryGetProperty("full_name", out var fn) && fn.GetString() is { Length: > 0 } name)
                    list.Add(name);
            return new WatchedReposResult(list, Degraded: false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        { return new WatchedReposResult([], Degraded: true); }
    }
}
