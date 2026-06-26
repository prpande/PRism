using System.Net;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubPrLifecycleWriterTests
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

    // Uses FakeHttpClientFactory (disposeHandler: false) so multi-hop GraphQL tests get a fresh
    // non-disposed wrapper on each CreateClient call, while sharing the same StubHandler.
    private static IHttpClientFactory FactoryFor(StubHandler handler) =>
        new FakeHttpClientFactory(handler, new Uri("https://api.github.com/api/v3/"));

    private static GitHubPrLifecycleWriter MakeWriter(StubHandler handler) =>
        new(FactoryFor(handler), () => Task.FromResult<string?>("ghp_token"), "https://api.github.com", NullLogger<GitHubPrLifecycleWriter>.Instance);

    private static HttpResponseMessage Resp(HttpStatusCode code, string body = "{}") =>
        new(code) { Content = new StringContent(body) };

    [Fact]
    public async Task CloseAsync_issues_PATCH_state_closed_and_returns_Ok()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK));
        var writer = MakeWriter(handler);

        var result = await writer.CloseAsync(Pr, CancellationToken.None);

        result.Should().Be(PrLifecycleResult.Ok);
        handler.Requests.Should().ContainSingle();
        handler.Requests[0].Method.Should().Be(HttpMethod.Patch);
        handler.Requests[0].Url.Should().EndWith("/repos/o/r/pulls/1");
        handler.Requests[0].Body.Should().Contain("\"state\":\"closed\"");
    }

    [Fact]
    public async Task ReopenAsync_issues_PATCH_state_open()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK));
        var result = await MakeWriter(handler).ReopenAsync(Pr, CancellationToken.None);
        result.Success.Should().BeTrue();
        handler.Requests[0].Body.Should().Contain("\"state\":\"open\"");
    }

    [Fact]
    public async Task CloseAsync_403_resource_not_accessible_maps_to_TokenCannotWrite()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Forbidden,
            "{\"message\":\"Resource not accessible by personal access token\"}"));
        var result = await MakeWriter(handler).CloseAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.TokenCannotWrite);
    }

    [Fact]
    public async Task CloseAsync_403_protected_branch_maps_to_RepoRuleBlocked()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Forbidden,
            "{\"message\":\"Protected branch update failed\"}"));
        var result = await MakeWriter(handler).CloseAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.RepoRuleBlocked);
    }

    [Fact]
    public async Task ReopenAsync_422_maps_to_ReopenNotPossible()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.UnprocessableEntity,
            "{\"message\":\"Validation Failed\",\"errors\":[{\"resource\":\"PullRequest\",\"field\":\"base\"}]}"));
        var result = await MakeWriter(handler).ReopenAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.ReopenNotPossible);
    }

    [Fact]
    public async Task MarkReadyForReviewAsync_resolves_node_id_then_runs_mutation()
    {
        var handler = new StubHandler(
            Resp(HttpStatusCode.OK, "{\"data\":{\"repository\":{\"pullRequest\":{\"id\":\"PR_node1\"}}}}"),
            Resp(HttpStatusCode.OK, "{\"data\":{\"markPullRequestReadyForReview\":{\"pullRequest\":{\"isDraft\":false}}}}"));
        var result = await MakeWriter(handler).MarkReadyForReviewAsync(Pr, CancellationToken.None);
        result.Success.Should().BeTrue();
        handler.Requests.Should().HaveCount(2); // resolve + mutate
        handler.Requests[1].Body.Should().Contain("markPullRequestReadyForReview");
        handler.Requests[1].Body.Should().Contain("PR_node1");
    }

    [Fact]
    public async Task ConvertToDraftAsync_already_draft_is_benign_noop_Ok()
    {
        var handler = new StubHandler(
            Resp(HttpStatusCode.OK, "{\"data\":{\"repository\":{\"pullRequest\":{\"id\":\"PR_node1\"}}}}"),
            Resp(HttpStatusCode.OK, "{\"errors\":[{\"message\":\"Pull request is already a draft\"}]}"));
        var result = await MakeWriter(handler).ConvertToDraftAsync(Pr, CancellationToken.None);
        result.Should().Be(PrLifecycleResult.Ok);
        // Plan ce-doc-review round 2 (scope): pin the mutation body too — the spec requires
        // "each of the four actions issues the correct GraphQL call", not just the Ok outcome.
        handler.Requests.Should().HaveCount(2); // resolve + mutate
        handler.Requests[1].Body.Should().Contain("convertPullRequestToDraft");
        handler.Requests[1].Body.Should().Contain("PR_node1");
    }

    // Symmetric to ConvertToDraftAsync_already_draft_is_benign_noop_Ok (claude[bot] review #649):
    // "not a draft" / "already ready" is a benign no-op for mark-ready → FirstGraphQLErrorCode
    // returns the None sentinel → Ok. Pins the mutation body too, like its convert-to-draft twin.
    [Fact]
    public async Task MarkReadyForReviewAsync_already_ready_is_benign_noop_Ok()
    {
        var handler = new StubHandler(
            Resp(HttpStatusCode.OK, "{\"data\":{\"repository\":{\"pullRequest\":{\"id\":\"PR_node1\"}}}}"),
            Resp(HttpStatusCode.OK, "{\"errors\":[{\"message\":\"Pull request is not a draft\"}]}"));
        var result = await MakeWriter(handler).MarkReadyForReviewAsync(Pr, CancellationToken.None);
        result.Should().Be(PrLifecycleResult.Ok);
        handler.Requests.Should().HaveCount(2); // resolve + mutate
        handler.Requests[1].Body.Should().Contain("markPullRequestReadyForReview");
        handler.Requests[1].Body.Should().Contain("PR_node1");
    }

    [Fact]
    public async Task ConvertToDraftAsync_plan_unsupported_maps_to_PlanUnsupportedDrafts()
    {
        var handler = new StubHandler(
            Resp(HttpStatusCode.OK, "{\"data\":{\"repository\":{\"pullRequest\":{\"id\":\"PR_node1\"}}}}"),
            Resp(HttpStatusCode.OK, "{\"errors\":[{\"message\":\"Draft pull requests are not supported in this repository\"}]}"));
        var result = await MakeWriter(handler).ConvertToDraftAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.PlanUnsupportedDrafts);
    }

    [Fact]
    public async Task CloseAsync_429_maps_to_RateLimited()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.TooManyRequests, "{\"message\":\"rate limited\"}"));
        var result = await MakeWriter(handler).CloseAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.RateLimited);
    }

    // Plan ce-doc-review (adversarial): a 403 PRIMARY rate-limit body has neither "secondary"
    // nor "abuse" — it must still map to RateLimited, not TokenCannotWrite.
    [Fact]
    public async Task CloseAsync_403_primary_rate_limit_maps_to_RateLimited()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Forbidden,
            "{\"message\":\"API rate limit exceeded for user ID 1.\"}"));
        var result = await MakeWriter(handler).CloseAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.RateLimited);
    }

    // Plan ce-doc-review (feasibility + adversarial): the GraphQL mutation throws on non-2xx;
    // a 401 on the mutation hop must map to TokenCannotWrite, NOT escape as an unhandled 500.
    [Fact]
    public async Task MarkReadyForReviewAsync_mutation_401_maps_to_TokenCannotWrite()
    {
        var handler = new StubHandler(
            Resp(HttpStatusCode.OK, "{\"data\":{\"repository\":{\"pullRequest\":{\"id\":\"PR_node1\"}}}}"),
            Resp(HttpStatusCode.Unauthorized, "{\"message\":\"Bad credentials\"}"));
        var result = await MakeWriter(handler).MarkReadyForReviewAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.TokenCannotWrite);
    }

    // A 429 on the node-id RESOLVE hop keeps its RateLimited meaning (not blanket Generic).
    [Fact]
    public async Task ConvertToDraftAsync_resolve_429_maps_to_RateLimited()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.TooManyRequests, "{\"message\":\"rate limited\"}"));
        var result = await MakeWriter(handler).ConvertToDraftAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.RateLimited);
    }

    // Plan ce-doc-review round 2 (scope): the spec requires asserting the classified failure is
    // LOGGED server-side (truncated body) BEFORE the sanitized DTO returns — the other tests wire
    // NullLogger and never check this half. This is the only test that captures the log.
    [Fact]
    public async Task A_classified_failure_logs_the_github_body_server_side()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Forbidden,
            "{\"message\":\"Resource not accessible by personal access token\"}"));
        var log = new CapturingLogger<GitHubPrLifecycleWriter>();
        var writer = new GitHubPrLifecycleWriter(
            FactoryFor(handler), () => Task.FromResult<string?>("ghp_token"), "https://api.github.com", log);

        var result = await writer.CloseAsync(Pr, CancellationToken.None);

        result.ErrorCode.Should().Be(PrLifecycleErrorCode.TokenCannotWrite);
        log.Entries.Should().ContainSingle()
            .Which.Message.Should().Contain("Resource not accessible"); // the raw GitHub body reaches the LOG, not the DTO
    }
}
