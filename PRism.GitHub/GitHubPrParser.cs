using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.GitHub;

// Pure JSON→DTO parsers for the GraphQL `pullRequest` payload, relocated verbatim from
// GitHubReviewService (#321 PR1). `internal static` (not `private`) because the read path on
// GitHubReviewService calls these across the class boundary; `internal` is test-visible via the
// csproj InternalsVisibleTo.
internal static class GitHubPrParser
{
    internal static List<ClusteringCommit> ParseTimelineCommits(JsonElement pull)
    {
        var result = new List<ClusteringCommit>();
        if (!pull.TryGetProperty("timelineItems", out var ti) ||
            !ti.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            if (!IsTypeName(node, "PullRequestCommit")) continue;
            if (!node.TryGetProperty("commit", out var c)) continue;
            var sha = c.TryGetProperty("oid", out var o) ? o.GetString() ?? "" : "";
            var date = c.TryGetProperty("committedDate", out var d) ? d.GetDateTimeOffset() : default;
            var message = c.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
            var add = c.TryGetProperty("additions", out var a) ? a.GetInt32() : 0;
            var del = c.TryGetProperty("deletions", out var dl) ? dl.GetInt32() : 0;
            // ChangedFiles is filled in later by the per-commit REST fan-out (or stays null
            // when fan-out is skipped above the commit-count cap or after a 4xx degrade).
            result.Add(new ClusteringCommit(sha, date, message, add, del, ChangedFiles: null));
        }
        return result;
    }

    internal static List<ClusteringForcePush> ParseForcePushes(JsonElement pull)
    {
        var result = new List<ClusteringForcePush>();
        if (!pull.TryGetProperty("timelineItems", out var ti) ||
            !ti.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            if (!IsTypeName(node, "HeadRefForcePushedEvent")) continue;
            string? before = null;
            if (node.TryGetProperty("beforeCommit", out var b) && b.ValueKind == JsonValueKind.Object)
                before = b.TryGetProperty("oid", out var bo) ? bo.GetString() : null;
            string? after = null;
            if (node.TryGetProperty("afterCommit", out var aft) && aft.ValueKind == JsonValueKind.Object)
                after = aft.TryGetProperty("oid", out var ao) ? ao.GetString() : null;
            var occurred = node.TryGetProperty("createdAt", out var ca) ? ca.GetDateTimeOffset() : default;
            result.Add(new ClusteringForcePush(before, after, occurred));
        }
        return result;
    }

    internal static List<ClusteringReviewEvent> ParseReviewEvents(JsonElement pull)
    {
        var result = new List<ClusteringReviewEvent>();
        if (!pull.TryGetProperty("timelineItems", out var ti) ||
            !ti.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            if (!IsTypeName(node, "PullRequestReview")) continue;
            // PENDING reviews (the viewer's own OR a hand-created one via the GitHub web UI / gh)
            // appear in this timelineItems connection with submittedAt = null — they have not been
            // submitted yet, by definition. Calling GetDateTimeOffset() on a Null-kind JsonElement
            // throws InvalidOperationException → unhandled → HTTP 500 on the PR detail load. The
            // clustering signal needs a real submission moment to be useful (it's a "reviewer
            // activity" timestamp), so a pending review carries no signal and is skipped entirely
            // rather than included with default(DateTimeOffset) (= 0001-01-01) which would pollute
            // clustering with an event from year 1.
            if (!node.TryGetProperty("submittedAt", out var s) || s.ValueKind != JsonValueKind.String)
                continue;
            result.Add(new ClusteringReviewEvent(s.GetDateTimeOffset()));
        }
        return result;
    }

    internal static List<ClusteringAuthorComment> ParseAuthorComments(JsonElement pull)
    {
        var result = new List<ClusteringAuthorComment>();
        if (!pull.TryGetProperty("comments", out var comments) ||
            !comments.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            // The clustering signal cares about *author* comments, not all PR-root comments.
            // Identifying the PR author requires a separate `author { login }` field on the
            // PR. PoC is fine with all root comments treated as candidates — clustering
            // doesn't differentiate; the signal is "PR-side conversation activity."
            var ts = node.TryGetProperty("createdAt", out var c) ? c.GetDateTimeOffset() : default;
            result.Add(new ClusteringAuthorComment(ts));
        }
        return result;
    }

    internal static Pr ParsePr(JsonElement pull, PrReference reference)
    {
        string GetStr(string name) =>
            pull.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String
                ? el.GetString() ?? "" : "";
        DateTimeOffset GetDate(string name) =>
            pull.TryGetProperty(name, out var el) && el.ValueKind != JsonValueKind.Null
                ? el.GetDateTimeOffset() : default;
        var (author, avatarUrl) = ReadActor(pull);
        string? HtmlUrl()
        {
            var url = GetStr("url");
            return string.IsNullOrEmpty(url) ? null : url;
        }

        // GitHub returns "MERGEABLE" | "CONFLICTING" | "UNKNOWN" — pass through as-is.
        // mergeStateStatus is a finer-grained signal ("BEHIND", "DIRTY", etc.); we collapse
        // both into a single `Mergeability` field for the Pr record. Spec § 6.1.
        var mergeability = GetStr("mergeable");
        var ciSummary = "";   // computed by PrDetailLoader (or by an upstream enrichment); placeholder here.

        var state = GetStr("state");
        // DateTimeOffset? (nullable) — unlike GetDate, which returns default for absent/null.
        DateTimeOffset? mergedAt = pull.TryGetProperty("mergedAt", out var mAt) && mAt.ValueKind != JsonValueKind.Null
            ? mAt.GetDateTimeOffset() : null;
        DateTimeOffset? closedAt = pull.TryGetProperty("closedAt", out var cAt) && cAt.ValueKind != JsonValueKind.Null
            ? cAt.GetDateTimeOffset() : null;
        var isMerged = string.Equals(state, "MERGED", StringComparison.Ordinal) || mergedAt.HasValue;
        // IsClosed means "closed without merging" — a separate state from merged.
        // Consumers that want "no longer open" should spell `IsMerged || IsClosed`.
        // Treating MERGED as IsClosed=true forced the inverse spelling on every
        // consumer and was a footgun (PR #19 review).
        var isClosed = string.Equals(state, "CLOSED", StringComparison.Ordinal) && !isMerged;

        return new Pr(
            reference,
            Title: GetStr("title"),
            Body: GetStr("body"),
            Author: author,
            State: state,
            HeadSha: GetStr("headRefOid"),
            BaseSha: GetStr("baseRefOid"),
            HeadBranch: GetStr("headRefName"),
            BaseBranch: GetStr("baseRefName"),
            Mergeability: mergeability,
            CiSummary: ciSummary,
            IsMerged: isMerged,
            IsClosed: isClosed,
            OpenedAt: GetDate("createdAt"),
            MergedAt: mergedAt,
            ClosedAt: closedAt,
            AvatarUrl: avatarUrl,
            HtmlUrl: HtmlUrl());
    }

    internal static List<IssueCommentDto> ParseRootComments(JsonElement pull)
    {
        var result = new List<IssueCommentDto>();
        if (!pull.TryGetProperty("comments", out var c) ||
            !c.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            var id = node.TryGetProperty("databaseId", out var db) ? db.GetInt64() : 0L;
            var (author, avatar) = ReadActor(node);
            var ts = node.TryGetProperty("createdAt", out var ca) ? ca.GetDateTimeOffset() : default;
            var body = node.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";
            result.Add(new IssueCommentDto(id, author, ts, body, avatar));
        }
        return result;
    }

    internal static List<ReviewThreadDto> ParseReviewThreads(JsonElement pull)
    {
        var result = new List<ReviewThreadDto>();
        if (!pull.TryGetProperty("reviewThreads", out var rt) ||
            !rt.TryGetProperty("nodes", out var threadNodes) ||
            threadNodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var t in threadNodes.EnumerateArray())
        {
            var threadId = t.TryGetProperty("id", out var ti) ? ti.GetString() ?? "" : "";
            var path = t.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "";
            var line = t.TryGetProperty("line", out var ln) && ln.ValueKind == JsonValueKind.Number ? ln.GetInt32() : 0;
            var resolved = t.TryGetProperty("isResolved", out var ir) && ir.ValueKind == JsonValueKind.True;
            var comments = new List<ReviewCommentDto>();
            if (t.TryGetProperty("comments", out var cs) &&
                cs.TryGetProperty("nodes", out var cnodes) &&
                cnodes.ValueKind == JsonValueKind.Array)
            {
                foreach (var cn in cnodes.EnumerateArray())
                {
                    var cid = cn.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "";
                    long? cDatabaseId = cn.TryGetProperty("databaseId", out var dbEl) && dbEl.ValueKind == JsonValueKind.Number
                        ? dbEl.GetInt64() : null;
                    var (cauthor, cavatar) = ReadActor(cn);
                    var cts = cn.TryGetProperty("createdAt", out var cca) ? cca.GetDateTimeOffset() : default;
                    var cbody = cn.TryGetProperty("body", out var cb) ? cb.GetString() ?? "" : "";
                    DateTimeOffset? edited = null;
                    if (cn.TryGetProperty("lastEditedAt", out var le) && le.ValueKind != JsonValueKind.Null)
                        edited = le.GetDateTimeOffset();
                    comments.Add(new ReviewCommentDto(cid, cauthor, cts, cbody, edited, cavatar, cDatabaseId));
                }
            }
            // AnchorSha is intentionally empty here. The reviewThreads GraphQL connection
            // doesn't return the per-thread anchor SHA in the current query shape (the SHA
            // a thread was originally posted against lives on `comments.nodes[0].originalCommit.oid`,
            // which we don't fetch yet). PrDetailLoader (Task 4) is responsible for resolving
            // the anchor against the PR diff and stamping a real SHA onto each thread before
            // the DTO ships to the frontend. Defaulting to HeadSha here would be misleading —
            // a thread anchored to an older iteration's snapshot would falsely report it
            // applies to the current head.
            result.Add(new ReviewThreadDto(threadId, path, line, AnchorSha: "", IsResolved: resolved, Comments: comments));
        }
        return result;
    }

    private static bool IsTypeName(JsonElement node, string expected)
    {
        if (!node.TryGetProperty("__typename", out var tn)) return false;
        return string.Equals(tn.GetString(), expected, StringComparison.Ordinal);
    }

    // #320 — (login, avatarUrl) from an `author{login avatarUrl}` node; ("", null) when the
    // author is absent/non-object. Matches the prior inline extractions exactly: login is read
    // without a ValueKind check (GitHub always returns a string), avatar only when it's a string.
    private static (string Login, string? AvatarUrl) ReadActor(JsonElement node)
    {
        if (!node.TryGetProperty("author", out var a) || a.ValueKind != JsonValueKind.Object)
            return ("", null);
        var login = a.TryGetProperty("login", out var l) ? l.GetString() ?? "" : "";
        var avatar = a.TryGetProperty("avatarUrl", out var av) && av.ValueKind == JsonValueKind.String
            ? av.GetString() : null;
        return (login, avatar);
    }
}
