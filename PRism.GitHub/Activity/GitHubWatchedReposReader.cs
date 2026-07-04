using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using PRism.Core.Activity;

namespace PRism.GitHub.Activity;

// Fault-isolated watched-repos reader. Mirrors GitHubNotificationsReader:
// degrade-don't-throw on ANY non-success / transport failure.
public sealed class GitHubWatchedReposReader : IWatchedReposReader
{
    private const int PerPage = 100;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly ILogger<GitHubWatchedReposReader>? _logger;

    public GitHubWatchedReposReader(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken,
        ILogger<GitHubWatchedReposReader>? logger = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _logger = logger;
    }

    public async Task<WatchedReposResult> ReadAsync(CancellationToken ct)
    {
        var url = $"user/subscriptions?per_page={PerPage}";
        var (items, degraded) = await GitHubArrayReader
            .ReadAsync(_httpFactory, _readToken, url, Parse, ct, _logger, "user/subscriptions").ConfigureAwait(false);
        return new WatchedReposResult(items, degraded);
    }

    // Drops entries with a missing or empty full_name (returns null → GitHubArrayReader skips it).
    private static string? Parse(JsonElement el) =>
        el.TryGetProperty("full_name", out var fn) && fn.GetString() is { Length: > 0 } name ? name : null;
}
