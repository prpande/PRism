using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

// Direct tests for the shared aliased-GraphQL-batch dispatcher (issue #665, sub-task 1).
// The two batch readers' byte-identity is pinned by their own characterization tests; these pin
// the dispatcher's own contract: envelope shape, the two rate-limit translations, and the
// returned-document happy path.
public sealed class GitHubGraphQLRunAliasedBatchTests
{
    private static (System.Net.Http.HttpClient Http, RecordingHttpMessageHandler Handler) Client(
        HttpStatusCode code, string body)
    {
        var handler = new RecordingHttpMessageHandler(code, body);
        return (new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")).CreateClient("github"), handler);
    }

    [Fact]
    public async Task Builds_aliased_envelope_for_each_ref_with_trailing_ratelimit()
    {
        var (http, handler) = Client(HttpStatusCode.OK, """{"data":{}}""");
        var aliased = new[]
        {
            ("a0", new PrReference("o", "r", 1)),
            ("a1", new PrReference("o2", "r2", 2)),
        };

        using var doc = await GitHubGraphQL.RunAliasedBatchAsync(
            http, "token", "https://github.com", NullLogger.Instance,
            aliased, r => r, "FIELDS", "test context", CancellationToken.None);

        GraphQlRequest.QueryOf(handler.LastRequestBody).Should().Be(
            """query{a0: repository(owner:"o", name:"r"){ pullRequest(number:1){ FIELDS } } a1: repository(owner:"o2", name:"r2"){ pullRequest(number:2){ FIELDS } } rateLimit{ cost remaining } }""");
    }

    [Fact]
    public async Task Http_429_translates_to_RateLimitExceeded_tagged_with_context()
    {
        var (http, _) = Client((HttpStatusCode)429, """{"message":"rate limited"}""");
        var aliased = new[] { ("a0", new PrReference("o", "r", 1)) };

        var act = () => GitHubGraphQL.RunAliasedBatchAsync(
            http, "token", "https://github.com", NullLogger.Instance,
            aliased, r => r, "FIELDS", "my-batch-context", CancellationToken.None);

        var ex = (await act.Should().ThrowAsync<RateLimitExceededException>()).Which;
        ex.Message.Should().Contain("my-batch-context").And.Contain("HTTP 429");
        ex.RetryAfter.Should().BeNull();   // PostAsync's 429 carries no Retry-After → poller normal cadence
    }

    [Fact]
    public async Task Body_200_with_RATE_LIMITED_translates_to_RateLimitExceeded_tagged_with_context()
    {
        var (http, _) = Client(HttpStatusCode.OK, """{"errors":[{"type":"RATE_LIMITED"}]}""");
        var aliased = new[] { ("a0", new PrReference("o", "r", 1)) };

        var act = () => GitHubGraphQL.RunAliasedBatchAsync(
            http, "token", "https://github.com", NullLogger.Instance,
            aliased, r => r, "FIELDS", "my-batch-context", CancellationToken.None);

        var ex = (await act.Should().ThrowAsync<RateLimitExceededException>()).Which;
        ex.Message.Should().Contain("my-batch-context");
        ex.RetryAfter.Should().BeNull();
    }

    [Fact]
    public async Task Happy_200_returns_parsed_document_with_aliased_data()
    {
        var (http, _) = Client(HttpStatusCode.OK, """{"data":{"a0":{"pullRequest":{"headRefOid":"h"}}}}""");
        var aliased = new[] { ("a0", new PrReference("o", "r", 1)) };

        using var doc = await GitHubGraphQL.RunAliasedBatchAsync(
            http, "token", "https://github.com", NullLogger.Instance,
            aliased, r => r, "headRefOid", "test context", CancellationToken.None);

        doc.RootElement.GetProperty("data").TryGetProperty("a0", out var a0).Should().BeTrue();
        a0.GetProperty("pullRequest").GetProperty("headRefOid").GetString().Should().Be("h");
    }
}
