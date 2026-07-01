using System.Globalization;
using System.Text;
using System.Text.Json;
using PRism.Core.Activity;
using PRism.Core.Contracts;

namespace PRism.GitHub.Activity;

/// <summary>
/// Reads one PR's full activity timeline, newest-first, one backward-paged page at a time.
/// Distinct from <see cref="GitHubPrTimelineReader"/> (batched, last:1, inbox enrichment):
/// this issues a single-PR <c>timelineItems(last:N, before:$cursor)</c> query with a pageInfo cursor
/// and timestamps every node. Degrades to an empty page on any transport/parse failure.
/// </summary>
public sealed class GitHubPrTimelineFeedReader : IPrTimelineFeedReader
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<string> _readHost;

    public GitHubPrTimelineFeedReader(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<string> readHost)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readHost = readHost;
    }

    public async Task<TimelinePage> ReadPageAsync(PrReference prRef, string? cursor, int pageSize, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(prRef);

        // Degraded: a transport/parse failure returns an empty page FLAGGED (Degraded:true) so the
        // endpoint (Task 3) can surface a real error to the SPA instead of a false-empty "No activity
        // yet". A genuinely empty PR returns Degraded:false via the normal path below.
        var empty = new TimelinePage(Array.Empty<TimelineEvent>(), OlderCursor: null, HasOlder: false, Degraded: true);

        try
        {
            var token = await _readToken().ConfigureAwait(false);
            using var http = _httpFactory.CreateClient("github");
            var endpoint = HostUrlResolver.GraphQlEndpoint(_readHost());
            var payload = JsonSerializer.Serialize(new { query = BuildQuery(prRef, cursor, pageSize) });
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var resp = await GitHubHttp.SendAsync(
                http, HttpMethod.Post, endpoint.ToString(), token, ct, content: content, apiVersion: false).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return empty;

            using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            if (!doc.RootElement.TryGetProperty("data", out var data)) return empty;
            if (!TryGetPath(data, out var pr, "repository", "pullRequest")) return empty;
            if (!TryGetPath(pr, out var items, "timelineItems")) return empty;

            var hasOlder = items.TryGetProperty("pageInfo", out var pi)
                && pi.TryGetProperty("hasPreviousPage", out var hp) && hp.GetBoolean();
            string? olderCursor = null;
            if (items.TryGetProperty("pageInfo", out var pi2)
                && pi2.TryGetProperty("startCursor", out var sc) && sc.ValueKind == JsonValueKind.String)
                olderCursor = sc.GetString();

            var parsed = new List<TimelineEvent>();
            if (items.TryGetProperty("nodes", out var nodes) && nodes.ValueKind == JsonValueKind.Array)
            {
                foreach (var node in nodes.EnumerateArray())
                {
                    var evt = ParseNode(node);
                    if (evt is not null) parsed.Add(evt);
                }
            }
            // GraphQL returns oldest→newest; the feed is newest-first. Order by a stable secondary key so
            // same-timestamp ties (e.g. a squash-push and a comment landing in the same second) resolve
            // deterministically across reloads (spec decision #4). LINQ OrderBy is a stable sort; List.Sort
            // is not — do NOT swap this for parsed.Sort(...).
            parsed = parsed
                .OrderByDescending(e => e.Timestamp)
                .ThenByDescending(e => e.Id, StringComparer.Ordinal)
                .ToList();

            if (!hasOlder)
            {
                var opened = SynthesizeOpened(pr);
                if (opened is not null) parsed.Add(opened);   // oldest element
            }

            return new TimelinePage(parsed, olderCursor, hasOlder);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            return empty;   // degrade, don't throw — mirrors GitHubPrTimelineReader
        }
    }

    private static string BuildQuery(PrReference pr, string? cursor, int pageSize)
    {
        var before = cursor is null
            ? string.Empty
            : $", before:{JsonSerializer.Serialize(cursor)}";
        var sb = new StringBuilder();
        sb.Append("query{ repository(owner:")
          .Append(JsonSerializer.Serialize(pr.Owner)).Append(", name:")
          .Append(JsonSerializer.Serialize(pr.Repo)).Append("){ pullRequest(number:")
          .Append(pr.Number.ToString(CultureInfo.InvariantCulture))
          .Append("){ createdAt author{ login avatarUrl __typename } timelineItems(last:")
          .Append(pageSize.ToString(CultureInfo.InvariantCulture))
          .Append(before)
          .Append(", itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,PULL_REQUEST_COMMIT,REVIEW_REQUESTED_EVENT,READY_FOR_REVIEW_EVENT,REOPENED_EVENT,CLOSED_EVENT,MERGED_EVENT]){ pageInfo{ hasPreviousPage startCursor } nodes{ __typename ... on IssueComment{ databaseId createdAt body author{ login avatarUrl __typename } } ... on PullRequestReview{ submittedAt state body author{ login avatarUrl __typename } } ... on PullRequestCommit{ commit{ oid committedDate author{ user{ login avatarUrl __typename } } } } ... on ReviewRequestedEvent{ createdAt actor{ login avatarUrl __typename } requestedReviewer{ ... on User{ login } ... on Team{ name } } } ... on ReadyForReviewEvent{ createdAt actor{ login avatarUrl __typename } } ... on ReopenedEvent{ createdAt actor{ login avatarUrl __typename } } ... on ClosedEvent{ createdAt actor{ login avatarUrl __typename } } ... on MergedEvent{ createdAt actor{ login avatarUrl __typename } } } } } } }");
        return sb.ToString();
    }

    private static TimelineEvent? ParseNode(JsonElement node)
    {
        if (!node.TryGetProperty("__typename", out var tn) || tn.ValueKind != JsonValueKind.String) return null;
        return tn.GetString() switch
        {
            "IssueComment" => Event(node, "databaseId", "createdAt", ActivityVerb.Commented, bodyProp: "body"),
            "PullRequestReview" => Review(node),
            "PullRequestCommit" => Commit(node),
            "ReviewRequestedEvent" => Requested(node),
            "ReadyForReviewEvent" => Simple(node, ActivityVerb.Reviewed),   // ReadyForReview → see Risks: verb mapping
            "ReopenedEvent" => Simple(node, ActivityVerb.Reopened),
            "ClosedEvent" => Simple(node, ActivityVerb.Closed),
            "MergedEvent" => Simple(node, ActivityVerb.Merged),
            _ => null,
        };
    }

    private static TimelineEvent Review(JsonElement node)
    {
        var state = node.TryGetProperty("state", out var s) ? s.GetString() : null;
        var verb = state switch
        {
            "APPROVED" => ActivityVerb.Approved,
            "CHANGES_REQUESTED" => ActivityVerb.ChangesRequested,
            _ => ActivityVerb.Reviewed,
        };
        var body = node.TryGetProperty("body", out var b) ? b.GetString() : null;
        var actor = ParseActor(node, "author");
        var ts = ParseTs(node, "submittedAt");
        return new TimelineEvent(Id(actor, ts, "review"), verb, actor, ts,
            Body: string.IsNullOrEmpty(body) ? null : body, CommitCount: null, Subject: null);
    }

    private static TimelineEvent? Commit(JsonElement node)
    {
        if (!node.TryGetProperty("commit", out var commit)) return null;
        var oid = commit.TryGetProperty("oid", out var o) ? o.GetString() ?? "" : "";
        var ts = ParseTs(commit, "committedDate");
        var user = commit.TryGetProperty("author", out var a) && a.TryGetProperty("user", out var u) ? u : default;
        var actor = user.ValueKind == JsonValueKind.Object ? ActorOf(user) : new TimelineActorRef(null, null, false);
        return new TimelineEvent(oid, ActivityVerb.Pushed, actor, ts, Body: null, CommitCount: 1, Subject: null);
    }

    private static TimelineEvent Requested(JsonElement node)
    {
        var actor = ParseActor(node, "actor");
        var ts = ParseTs(node, "createdAt");
        string? subject = null;
        if (node.TryGetProperty("requestedReviewer", out var rr) && rr.ValueKind == JsonValueKind.Object)
            subject = rr.TryGetProperty("login", out var l) ? l.GetString()
                    : rr.TryGetProperty("name", out var n) ? n.GetString() : null;
        return new TimelineEvent(Id(actor, ts, "req"), ActivityVerb.ReviewRequested, actor, ts, null, null, subject);
    }

    private static TimelineEvent Simple(JsonElement node, ActivityVerb verb)
    {
        var actor = ParseActor(node, "actor");
        var ts = ParseTs(node, "createdAt");
        return new TimelineEvent(Id(actor, ts, verb.ToString()), verb, actor, ts, null, null, null);
    }

    private static TimelineEvent Event(JsonElement node, string idProp, string tsProp, ActivityVerb verb, string bodyProp)
    {
        var actor = ParseActor(node, "author");
        var ts = ParseTs(node, tsProp);
        var id = node.TryGetProperty(idProp, out var idEl) && idEl.ValueKind == JsonValueKind.Number
            ? idEl.GetInt64().ToString(CultureInfo.InvariantCulture) : Id(actor, ts, verb.ToString());
        var body = node.TryGetProperty(bodyProp, out var b) ? b.GetString() : null;
        return new TimelineEvent(id, verb, actor, ts, string.IsNullOrEmpty(body) ? null : body, null, null);
    }

    private static TimelineEvent? SynthesizeOpened(JsonElement pr)
    {
        var ts = ParseTs(pr, "createdAt");
        var actor = pr.TryGetProperty("author", out var a) && a.ValueKind == JsonValueKind.Object
            ? ActorOf(a) : new TimelineActorRef(null, null, false);
        return new TimelineEvent($"opened:{actor.Login}", ActivityVerb.Opened, actor, ts, null, null, null);
    }

    private static TimelineActorRef ParseActor(JsonElement node, string prop)
        => node.TryGetProperty(prop, out var a) && a.ValueKind == JsonValueKind.Object
            ? ActorOf(a) : new TimelineActorRef(null, null, false);

    private static TimelineActorRef ActorOf(JsonElement a)
    {
        var login = a.TryGetProperty("login", out var l) ? l.GetString() : null;
        var avatar = a.TryGetProperty("avatarUrl", out var av) ? av.GetString() : null;
        var isBot = a.TryGetProperty("__typename", out var tn) && tn.GetString() == "Bot";
        return new TimelineActorRef(login, avatar, isBot);
    }

    private static DateTimeOffset ParseTs(JsonElement node, string prop)
        => node.TryGetProperty(prop, out var t) && t.ValueKind == JsonValueKind.String
           && DateTimeOffset.TryParse(t.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var v)
            ? v : DateTimeOffset.UnixEpoch;

    private static string Id(TimelineActorRef actor, DateTimeOffset ts, string kind)
        => $"{kind}:{actor.Login}:{ts.ToUnixTimeMilliseconds()}";

    private static bool TryGetPath(JsonElement root, out JsonElement leaf, params string[] path)
    {
        leaf = root;
        foreach (var seg in path)
        {
            if (leaf.ValueKind != JsonValueKind.Object || !leaf.TryGetProperty(seg, out leaf))
            {
                leaf = default;
                return false;
            }
        }
        return true;
    }
}
