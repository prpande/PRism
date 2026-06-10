using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.GitHub.Activity;

// Batched GraphQL enrichment for the activity rail. ONE aliased query fetches the most-recent
// timeline item (comment / review / commit) for many PRs at once — GitHub bills this ~1 point
// because each connection is `last:1`. Fault-isolated (degrade-don't-throw, mirroring
// GitHubNotificationsReader): any non-2xx / transport / parse failure yields an empty map and a
// PR with no resolvable actor is simply absent, so callers fall back to actorless rows.
public sealed class GitHubPrTimelineReader : IPrTimelineReader
{
    private const int MaxBatch = 100;   // safety cap on aliases per query
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<string> _readHost;   // late-bound: GraphQL endpoint follows a live host change

    public GitHubPrTimelineReader(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<string> readHost)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readHost = readHost;
    }

    public async Task<IReadOnlyDictionary<(string Repo, int PrNumber), TimelineActor>> ReadLatestAsync(
        IReadOnlyCollection<(string Repo, int PrNumber)> pullRequests, CancellationToken ct)
    {
        var result = new Dictionary<(string Repo, int PrNumber), TimelineActor>();
        if (pullRequests is null || pullRequests.Count == 0) return result;

        var targets = pullRequests
            .Where(p => !string.IsNullOrEmpty(p.Repo) && p.Repo.Contains('/', StringComparison.Ordinal) && p.PrNumber > 0)
            .Distinct()
            .Take(MaxBatch)
            .Select((p, i) => (Alias: $"a{i}", p.Repo, p.PrNumber))
            .ToList();
        if (targets.Count == 0) return result;

        try
        {
            var token = await _readToken().ConfigureAwait(false);
            using var http = _httpFactory.CreateClient("github");
            // Absolute GraphQL endpoint — the named client's BaseAddress is the REST root
            // (`<host>/api/v3/` on GHES), which would 404 for GraphQL.
            var endpoint = HostUrlResolver.GraphQlEndpoint(_readHost());
            var payload = JsonSerializer.Serialize(new { query = BuildQuery(targets) });
            using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            };
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.UserAgent.ParseAdd("PRism/0.1");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");

            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return result;            // degrade, don't throw

            using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            // GraphQL returns HTTP 200 with a partial `data` object even when some aliases error
            // (e.g. a repo you can't access) — read whichever aliases resolved, ignore the rest.
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
                return result;

            foreach (var (alias, repo, pr) in targets)
            {
                if (!data.TryGetProperty(alias, out var repoNode) || repoNode.ValueKind != JsonValueKind.Object)
                    continue;
                if (ParseLatestActor(repoNode) is { } actor)
                    result[(repo, pr)] = actor;
            }

            return result;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            return result;   // best-effort: enrichment failure leaves rows actorless
        }
    }

    private static string BuildQuery(IReadOnlyList<(string Alias, string Repo, int PrNumber)> targets)
    {
        var sb = new StringBuilder("query{");
        foreach (var (alias, repo, pr) in targets)
        {
            var slash = repo.IndexOf('/', StringComparison.Ordinal);
            var owner = repo[..slash];
            var name = repo[(slash + 1)..];
            sb.Append(alias).Append(": repository(owner:")
              .Append(JsonSerializer.Serialize(owner)).Append(", name:")
              .Append(JsonSerializer.Serialize(name)).Append("){ pullRequest(number:")
              .Append(pr.ToString(CultureInfo.InvariantCulture))
              .Append("){ timelineItems(last:1, itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,PULL_REQUEST_COMMIT]){ nodes{ __typename ")
              .Append("... on IssueComment{ author{ login avatarUrl __typename } } ")
              .Append("... on PullRequestReview{ author{ login avatarUrl __typename } state } ")
              .Append("... on PullRequestCommit{ commit{ author{ user{ login avatarUrl __typename } } } } ")
              .Append("} } } } ");
        }
        sb.Append('}');
        return sb.ToString();
    }

    private static TimelineActor? ParseLatestActor(JsonElement repoNode)
    {
        if (!repoNode.TryGetProperty("pullRequest", out var pr) || pr.ValueKind != JsonValueKind.Object)
            return null;
        if (!pr.TryGetProperty("timelineItems", out var ti)
            || !ti.TryGetProperty("nodes", out var nodes)
            || nodes.ValueKind != JsonValueKind.Array
            || nodes.GetArrayLength() == 0)
            return null;

        var node = nodes[0];
        var typename = node.TryGetProperty("__typename", out var tn) ? tn.GetString() : null;
        switch (typename)
        {
            case "IssueComment":
                return ActorFrom(node, ActivityVerb.Commented);
            case "PullRequestReview":
                var state = node.TryGetProperty("state", out var st) ? st.GetString() : null;
                var verb = state switch
                {
                    "APPROVED" => ActivityVerb.Approved,
                    "CHANGES_REQUESTED" => ActivityVerb.ChangesRequested,
                    _ => ActivityVerb.Reviewed,
                };
                return ActorFrom(node, verb);
            case "PullRequestCommit":
                if (node.TryGetProperty("commit", out var commit)
                    && commit.TryGetProperty("author", out var ca)
                    && ca.TryGetProperty("user", out var user)
                    && user.ValueKind == JsonValueKind.Object)
                    return ActorFromElement(user, ActivityVerb.Pushed);
                return null;
            default:
                return null;
        }
    }

    private static TimelineActor? ActorFrom(JsonElement node, ActivityVerb verb)
        => node.TryGetProperty("author", out var a) && a.ValueKind == JsonValueKind.Object
            ? ActorFromElement(a, verb)
            : null;

    private static TimelineActor? ActorFromElement(JsonElement actor, ActivityVerb verb)
    {
        var login = actor.TryGetProperty("login", out var l) ? l.GetString() : null;
        if (string.IsNullOrEmpty(login)) return null;            // ghost / deleted user → leave actorless
        var avatar = actor.TryGetProperty("avatarUrl", out var av) ? av.GetString() : null;
        var isBot = actor.TryGetProperty("__typename", out var tn)
            && string.Equals(tn.GetString(), "Bot", StringComparison.Ordinal);
        return new TimelineActor(login, avatar, isBot, verb);
    }
}
