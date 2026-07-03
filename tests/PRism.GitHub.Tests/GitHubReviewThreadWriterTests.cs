using System.Net;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

// #571 — GitHubReviewThreadWriter (resolveReviewThread / unresolveReviewThread GraphQL mutations).
// Test-double shapes mirror GitHubPrLifecycleWriterTests.cs exactly (StubHandler + FakeHttpClientFactory
// + Resp helper). Error-body fixtures are the REAL captured bodies from the live-validation gate
// (.superpowers/sdd/live-validation-task2.md) — NOT the plan's assumed (and wrong) substrings.
public class GitHubReviewThreadWriterTests
{
    private static readonly PrReference Pr = new("o", "r", 1);

    // A stub HttpMessageHandler that returns queued responses and records requests.
    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Queue<HttpResponseMessage> _responses;
        public List<(HttpMethod Method, string Url, string? Body)> Requests { get; } = new();
        public StubHandler(params HttpResponseMessage[] responses) => _responses = new(responses);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            Requests.Add((request.Method, request.RequestUri!.ToString(), body));
            return _responses.Dequeue();
        }
    }

    private static IHttpClientFactory FactoryFor(StubHandler handler) =>
        new FakeHttpClientFactory(handler, new Uri("https://api.github.com/api/v3/"));

    private static GitHubReviewThreadWriter MakeWriter(StubHandler handler) =>
        new(FactoryFor(handler), () => Task.FromResult<string?>("ghp_token"), "https://api.github.com",
            NullLogger<GitHubReviewThreadWriter>.Instance);

    private static HttpResponseMessage Resp(HttpStatusCode code, string body = "{}") =>
        new(code) { Content = new StringContent(body) };

    [Fact]
    public async Task ResolveAsync_success_returns_ok()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":true}}}}"""));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.Should().Be(ReviewThreadResult.Ok);
    }

    [Fact]
    public async Task ResolveAsync_issues_mutation_with_threadId_verbatim()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":true}}}}"""));

        await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        handler.Requests.Should().ContainSingle();
        handler.Requests[0].Body.Should().Contain("resolveReviewThread");
        handler.Requests[0].Body.Should().Contain("PRRT_1");
    }

    [Fact]
    public async Task UnresolveAsync_success_returns_ok()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"data":{"unresolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":false}}}}"""));

        var result = await MakeWriter(handler).UnresolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.Should().Be(ReviewThreadResult.Ok);
    }

    [Fact]
    public async Task UnresolveAsync_issues_mutation_with_threadId_verbatim_no_node_id_resolution()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"data":{"unresolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":false}}}}"""));

        await MakeWriter(handler).UnresolveAsync(Pr, "PRRT_1", CancellationToken.None);

        // Exactly one request — unlike GitHubPrLifecycleWriter's draft toggles, there is no
        // separate node-id resolve hop; threadId is passed through as-is.
        handler.Requests.Should().ContainSingle();
        handler.Requests[0].Body.Should().Contain("unresolveReviewThread");
        handler.Requests[0].Body.Should().Contain("PRRT_1");
    }

    // ---- Classification: HTTP-200 + errors[] path (real captured bodies, live-validation gate) ----

    [Fact]
    public async Task ResolveAsync_FORBIDDEN_type_maps_to_TokenCannotWrite()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"errors":[{"type":"FORBIDDEN","message":"prpande does not have the correct permissions to execute `ResolveReviewThread`"}]}"""));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.Success.Should().BeFalse();
        result.ErrorCode.Should().Be(ReviewThreadErrorCode.TokenCannotWrite);
    }

    [Fact]
    public async Task UnresolveAsync_NOT_FOUND_type_maps_to_ThreadNotFound()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a node with the global id of 'PRRT_x'"}]}"""));

        var result = await MakeWriter(handler).UnresolveAsync(Pr, "PRRT_x", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.ThreadNotFound);
    }

    [Fact]
    public async Task ResolveAsync_RATE_LIMITED_type_maps_to_RateLimited()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}"""));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.RateLimited);
    }

    // ---- Classification: message-only fallback (no `type` field) ----

    [Fact]
    public async Task ResolveAsync_message_fallback_correct_permissions_maps_to_TokenCannotWrite()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"errors":[{"message":"prpande does not have the correct permissions to execute `ResolveReviewThread`"}]}"""));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.TokenCannotWrite);
    }

    [Fact]
    public async Task ResolveAsync_message_fallback_resource_not_accessible_maps_to_TokenCannotWrite()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"errors":[{"message":"Resource not accessible by personal access token"}]}"""));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.TokenCannotWrite);
    }

    [Fact]
    public async Task ResolveAsync_message_fallback_could_not_resolve_node_maps_to_ThreadNotFound()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"errors":[{"message":"Could not resolve to a node with the global id of 'PRRT_x'"}]}"""));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_x", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.ThreadNotFound);
    }

    [Fact]
    public async Task ResolveAsync_unrecognized_error_maps_to_Generic()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"errors":[{"type":"INTERNAL","message":"Something went sideways"}]}"""));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.Generic);
    }

    // ---- Classification: thrown HttpRequestException path (PostAsync throws on non-2xx) ----

    [Fact]
    public async Task ResolveAsync_thrown_403_maps_to_TokenCannotWrite()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Forbidden, "{\"message\":\"Forbidden\"}"));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.TokenCannotWrite);
    }

    [Fact]
    public async Task ResolveAsync_thrown_401_maps_to_TokenCannotWrite()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Unauthorized, "{\"message\":\"Bad credentials\"}"));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.TokenCannotWrite);
    }

    [Fact]
    public async Task ResolveAsync_thrown_429_maps_to_RateLimited()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.TooManyRequests, "{\"message\":\"rate limited\"}"));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.RateLimited);
    }

    [Fact]
    public async Task ResolveAsync_thrown_500_maps_to_Generic()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.InternalServerError, "{\"message\":\"oops\"}"));

        var result = await MakeWriter(handler).ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.Generic);
    }

    // Mirrors GitHubPrLifecycleWriterTests.A_classified_failure_logs_the_github_body_server_side:
    // proves the raw GitHub body reaches the server-side log, not just the sanitized DTO.
    [Fact]
    public async Task A_classified_failure_logs_the_github_body_server_side()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK,
            """{"errors":[{"type":"FORBIDDEN","message":"prpande does not have the correct permissions to execute `ResolveReviewThread`"}]}"""));
        var log = new CapturingLogger<GitHubReviewThreadWriter>();
        var writer = new GitHubReviewThreadWriter(
            FactoryFor(handler), () => Task.FromResult<string?>("ghp_token"), "https://api.github.com", log);

        var result = await writer.ResolveAsync(Pr, "PRRT_1", CancellationToken.None);

        result.ErrorCode.Should().Be(ReviewThreadErrorCode.TokenCannotWrite);
        // Two entries land here: GitHubGraphQL.PostAsync's universal errors[] observability log
        // (fires for every GraphQL caller), plus this writer's own classified-failure log. Assert
        // on the writer's own entry specifically — the raw GitHub body must reach the LOG, not the DTO.
        log.Entries.Should().Contain(e =>
            e.Message.StartsWith("Review-thread write failed:", StringComparison.Ordinal)
            && e.Message.Contains("correct permissions"));
    }
}
