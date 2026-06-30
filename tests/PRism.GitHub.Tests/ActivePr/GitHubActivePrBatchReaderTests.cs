using System.Net;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub.ActivePr;
using PRism.GitHub.Tests.TestHelpers;   // FakeHttpClientFactory, FakeHttpMessageHandler
using Xunit;

namespace PRism.GitHub.Tests.ActivePr;

public sealed class GitHubActivePrBatchReaderTests
{
    // Construct a reader whose every GraphQL POST returns `body` with HTTP 200.
    private static GitHubActivePrBatchReader NewReaderReturning(string body)
    {
        var handler = new FakeHttpMessageHandler(_ =>
        {
            var resp = new HttpResponseMessage(HttpStatusCode.OK);
            resp.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
            return resp;
        });
        return new GitHubActivePrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            () => "https://github.com");
    }

    // #665 byte-identity characterization: pins the EXACT posted GraphQL query so the shared
    // dispatch/envelope extraction (RunAliasedBatchAsync) cannot silently change the wire output.
    // Golden captured from the pre-refactor BuildQuery output.
    [Fact]
    public async Task Posts_byte_identical_aliased_query()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """{"data":{}}""");
        var reader = new GitHubActivePrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        await reader.PollBatchAsync(new[] { new PrReference("o", "r", 1) }, CancellationToken.None);

        GraphQlRequest.QueryOf(handler.LastRequestBody).Should().Be(
            """query{a0: repository(owner:"o", name:"r"){ pullRequest(number:1){ headRefOid baseRefOid state isDraft mergeable mergeStateStatus reviewDecision reviewThreads(first:100){ nodes{ comments{ totalCount } } } reviews{ totalCount } latestReviews(first:20){ nodes{ author{ login avatarUrl } state } } reviewRequests(first:20){ nodes{ requestedReviewer{ ... on User{ login avatarUrl } ... on Team{ name } } } } } } rateLimit{ cost remaining } }""");
    }

    // #665 byte-identity: a JSON-escapable owner/repo must serialize through the shared envelope
    // exactly as today. The plain-owner test above pins the full envelope byte-for-byte; this one
    // pins that owner/name still route through JsonSerializer.Serialize (STJ escapes " and \), so
    // the extraction can't quietly swap the escaping. Built from JsonSerializer to avoid a
    // hand-encoded \u literal while staying a true equality check on the serialized owner/name.
    [Fact]
    public async Task Posts_query_escaping_owner_and_name_via_json_serializer()
    {
        const string owner = "o\"q\\b";
        const string repo = "re\"po";
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """{"data":{}}""");
        var reader = new GitHubActivePrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        await reader.PollBatchAsync(new[] { new PrReference(owner, repo, 9) }, CancellationToken.None);

        var ser = System.Text.Json.JsonSerializer.Serialize(owner);
        var serName = System.Text.Json.JsonSerializer.Serialize(repo);
        GraphQlRequest.QueryOf(handler.LastRequestBody).Should().StartWith(
            $"query{{a0: repository(owner:{ser}, name:{serName}){{ pullRequest(number:9){{ headRefOid");
    }

    // #667: this reader requests the SAME compute-forcing merge-readiness fields as the inbox reader
    // (mergeable / mergeStateStatus / reviewDecision / latestReviews / reviewRequests), so it must
    // share the inbox reader's 50-alias cap. It had drifted at 100 after #593 lowered the inbox reader
    // to 50 — a >75-PR keep-alive tick (#161) batches every subscribed PR into ONE query and would push
    // it past GitHub's ~11s GraphQL execution limit (→502), aborting the whole tick for every open PR
    // at once. Pin the chunk boundary at exactly 50: the 50th alias fits one POST; the 51st forces a 2nd.
    [Fact]
    public async Task Chunks_merge_readiness_query_at_fifty_aliases_not_one_hundred()
    {
        static PrReference[] Refs(int n) => Enumerable.Range(1, n).Select(i => new PrReference("o", "r", i)).ToArray();
        static (GitHubActivePrBatchReader Reader, RecordingHttpMessageHandler Handler) NewRecording()
        {
            var handler = new RecordingHttpMessageHandler(
                Enumerable.Repeat((HttpStatusCode.OK, """{"data":{}}"""), 8));
            var reader = new GitHubActivePrBatchReader(
                new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
                () => Task.FromResult<string?>("token"), () => "https://github.com");
            return (reader, handler);
        }

        var (atCap, h50) = NewRecording();
        await atCap.PollBatchAsync(Refs(50), CancellationToken.None);
        h50.RequestCount.Should().Be(1, "50 aliases fit a single chunk");

        var (overCap, h51) = NewRecording();
        await overCap.PollBatchAsync(Refs(51), CancellationToken.None);
        h51.RequestCount.Should().Be(2, "the 51st alias forces a second chunk — the cap is 50, not 100");
    }

    [Fact]
    public async Task Batches_all_refs_and_derives_readiness_per_alias()
    {
        const string body = """
        { "data": {
            "a0": { "pullRequest": { "headRefOid": "h1", "baseRefOid": "b1",
                "state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE",
                "mergeStateStatus": "DIRTY", "reviewDecision": null,
                "reviewThreads": { "nodes": [ { "comments": { "totalCount": 2 } } ] },
                "reviews": { "totalCount": 3 }, "latestReviews": { "nodes": [] } } },
            "a1": { "pullRequest": { "headRefOid": "h2", "baseRefOid": "b2",
                "state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE",
                "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED",
                "reviewThreads": { "nodes": [] }, "reviews": { "totalCount": 1 },
                "latestReviews": { "nodes": [ { "author": { "login": "a" }, "state": "APPROVED" } ] } } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var reader = NewReaderReturning(body);
        var refs = new[] { new PrReference("o", "r", 1), new PrReference("o", "r", 2) };

        var map = await reader.PollBatchAsync(refs, CancellationToken.None);

        map[refs[0]].MergeReadiness.Should().Be(MergeReadiness.Conflicts);
        map[refs[0]].CommentCount.Should().Be(2);
        map[refs[1]].MergeReadiness.Should().Be(MergeReadiness.Ready);
        map[refs[1]].Approvals.Should().Be(1);
    }

    [Fact]
    public async Task Comment_count_counts_comments_not_threads()
    {
        // REST pulls/{n}/comments returns one entry PER inline comment. Two threads — one with 3
        // replies, one with 1 — must yield CommentCount=4 (per-comment), NOT 2 (per-thread).
        const string body = """
        { "data": { "a0": { "pullRequest": { "headRefOid": "h", "baseRefOid": "b",
            "state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "reviewDecision": "APPROVED",
            "reviewThreads": { "nodes": [ { "comments": { "totalCount": 3 } }, { "comments": { "totalCount": 1 } } ] },
            "reviews": { "totalCount": 2 }, "latestReviews": { "nodes": [] } } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var reader = NewReaderReturning(body);
        var map = await reader.PollBatchAsync(new[] { new PrReference("o", "r", 1) }, CancellationToken.None);
        map.Values.Single().CommentCount.Should().Be(4); // 3 + 1, not the 2-thread count
    }

    [Fact]
    public async Task Per_alias_null_node_drops_only_that_pr()
    {
        const string body = """
        { "data": { "a0": { "pullRequest": null },
            "a1": { "pullRequest": { "headRefOid": "h2", "baseRefOid": "b2", "state": "OPEN",
                "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "reviewDecision": "APPROVED", "reviewThreads": { "nodes": [] },
                "reviews": { "totalCount": 0 }, "latestReviews": { "nodes": [] } } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var reader = NewReaderReturning(body);
        var refs = new[] { new PrReference("o", "r", 1), new PrReference("o", "r", 2) };
        var map = await reader.PollBatchAsync(refs, CancellationToken.None);
        map.Should().NotContainKey(refs[0]);
        map.Should().ContainKey(refs[1]);
    }

    [Fact]
    public async Task Detects_merge_close_transition_via_state_field()
    {
        // GraphQL `state` returns MERGED/CLOSED directly; PrStates.FromGitHub matches "merged"
        // case-insensitively regardless of the `merged` bool, so a PR that merged mid-subscription
        // resolves to PrState.Merged (the poller then publishes IsMerged=true). Guards the live
        // "this PR was merged" banner against a regression if `state` is ever dropped from the query.
        const string body = """
        { "data": {
            "a0": { "pullRequest": { "headRefOid": "h", "baseRefOid": "b", "state": "MERGED",
                "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "reviewDecision": "APPROVED", "reviewThreads": { "nodes": [] },
                "reviews": { "totalCount": 1 }, "latestReviews": { "nodes": [] } } },
            "a1": { "pullRequest": { "headRefOid": "h2", "baseRefOid": "b2", "state": "CLOSED",
                "isDraft": false, "mergeable": "UNKNOWN", "mergeStateStatus": "UNKNOWN",
                "reviewDecision": null, "reviewThreads": { "nodes": [] },
                "reviews": { "totalCount": 0 }, "latestReviews": { "nodes": [] } } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var reader = NewReaderReturning(body);
        var refs = new[] { new PrReference("o", "r", 1), new PrReference("o", "r", 2) };
        var map = await reader.PollBatchAsync(refs, CancellationToken.None);
        map[refs[0]].PrState.Should().Be(PrState.Merged);
        map[refs[0]].MergeReadiness.Should().Be(MergeReadiness.Merged); // terminal — FE renders no badge
        map[refs[1]].PrState.Should().Be(PrState.Closed);
    }

    [Fact]
    public async Task Rate_limited_200_body_throws()
    {
        const string body = """{ "errors": [ { "type": "RATE_LIMITED" } ] }""";
        var reader = NewReaderReturning(body);
        var act = () => reader.PollBatchAsync(new[] { new PrReference("o", "r", 1) }, CancellationToken.None);
        await act.Should().ThrowAsync<RateLimitExceededException>();
    }

    [Fact]
    public async Task PollBatch_surfaces_isDraft_from_graphql()
    {
        // Arrange: a GraphQL response node with isDraft:true — the field is already parsed by
        // TryParse at line 90; this test guards that it is forwarded to ActivePrPollSnapshot.
        const string body = """
        { "data": { "a0": { "pullRequest": { "headRefOid": "hd", "baseRefOid": "bd",
            "state": "OPEN", "isDraft": true, "mergeable": "UNKNOWN", "mergeStateStatus": "DRAFT",
            "reviewDecision": null, "reviewThreads": { "nodes": [] },
            "reviews": { "totalCount": 0 }, "latestReviews": { "nodes": [] } } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var reader = NewReaderReturning(body);
        var pr = new PrReference("o", "r", 7);

        var map = await reader.PollBatchAsync(new[] { pr }, CancellationToken.None);

        map[pr].IsDraft.Should().BeTrue();
    }
}
