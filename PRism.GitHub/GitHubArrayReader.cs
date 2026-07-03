using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace PRism.GitHub;

// Shared degrade-don't-throw GitHub JSON-array fetch (issue #665, sub-task 2).
// Extracted from the three sibling Activity readers (received-events / notifications /
// watched-repos), which had each hand-copied this skeleton. ANY non-success status,
// transport fault, malformed body, or non-array root → (empty, Degraded: true);
// genuine cancellation propagates. This is the single home of that contract.
internal static partial class GitHubArrayReader
{
    internal const int DefaultMaxPages = 10;

    // Fetches `url` as a GitHub JSON array and projects each element via `parse`.
    //
    // CONTRACT: `parse` runs INSIDE the guarded region, so it must never throw outside
    // the catch filter below (HttpRequestException / JsonException / TaskCanceledException).
    // Anything else (e.g. OverflowException) propagates and breaks degrade-don't-throw —
    // this is why the Notifications delegate uses int.TryParse, not int.Parse. `parse`
    // returns null to skip an element.
    public static async Task<(IReadOnlyList<T> Items, bool Degraded)> ReadAsync<T>(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string url,
        Func<JsonElement, T?> parse,
        CancellationToken ct,
        ILogger? logger = null,
        string? resource = null,
        int maxPages = DefaultMaxPages) where T : class
    {
        var list = new List<T>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            var token = await readToken().ConfigureAwait(false);
            using var http = httpFactory.CreateClient("github");
            var currentUrl = url;
            var page = 0;
            while (true)
            {
                page++;
                using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, currentUrl, token, ct).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode) return (list, list.Count == 0);

                using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
                if (doc.RootElement.ValueKind != JsonValueKind.Array) return (list, list.Count == 0);

                foreach (var el in doc.RootElement.EnumerateArray())
                    if (parse(el) is { } item) list.Add(item);

                // The next URL is GitHub's ABSOLUTE Link header value, passed to SendAsync as-is.
                // NEVER strip/re-derive it to a relative path: a relative URL always resolves
                // against the trusted BaseAddress, so the ApplyHeaders absolute-URI egress guard
                // would never run — a re-derivation bug could silently reopen an off-host PAT leak.
                if (!GitHubLinkHeader.TryGetRel(resp, "next", out var next)) break;
                if (!visited.Add(next)) break; // repeated next URL: exhausted, NEVER a cap (check before budget)
                if (page >= maxPages)
                {
                    if (logger is not null) Log.ActivityPaginationCapHit(logger, resource ?? "", maxPages);
                    break;
                }
                currentUrl = next;
            }
            return (list, false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        { return (list, list.Count == 0); }
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, EventId = 628, EventName = "ActivityPaginationCapHit",
            Message = "GitHub list read for {Resource} hit the {MaxPages}-page pagination budget; results may be truncated (some items were not loaded).")]
        internal static partial void ActivityPaginationCapHit(ILogger logger, string resource, int maxPages);
    }
}
