using System.Globalization;
using System.Net;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceIssueCommentsTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    private static GitHubReviewSubmitter NewService(HttpMessageHandler handler)
        => GitHubReviewServiceFactory.CreateSubmitter(handler);

    // --- happy-path ---

    [Fact]
    public async Task CreateIssueCommentAsync_OnSuccess_ReturnsIdAndCreatedAt()
    {
        const string responseJson = """
            {
              "id": 987654321,
              "created_at": "2026-06-02T10:30:00Z",
              "body": "Hello from PRism"
            }
            """;
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.Created, responseJson);
        var svc = NewService(handler);

        var result = await svc.CreateIssueCommentAsync(Ref, "Hello from PRism", CancellationToken.None);

        result.Id.Should().Be(987654321L);
        result.CreatedAt.Should().Be(DateTimeOffset.Parse("2026-06-02T10:30:00Z", CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task CreateIssueCommentAsync_PostsToCorrectUrl_WithBodyField()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.Created,
            """{"id":1,"created_at":"2026-06-02T00:00:00Z"}""");
        var svc = NewService(handler);

        await svc.CreateIssueCommentAsync(Ref, "test body", CancellationToken.None);

        handler.RequestCount.Should().Be(1);
        handler.RequestMethods[0].Should().Be(HttpMethod.Post);
        // Path: /repos/owner/repo/issues/42/comments
        handler.RequestPaths[0].Should().Be("/repos/owner/repo/issues/42/comments");

        using var doc = JsonDocument.Parse(handler.RequestBodies[0]!);
        doc.RootElement.GetProperty("body").GetString().Should().Be("test body");
    }

    [Fact]
    public async Task CreateIssueCommentAsync_SendsBearerToken_AndGitHubApiVersionHeader()
    {
        // Use FakeHttpMessageHandler so we can inspect the outgoing request directly.
        HttpRequestMessage? captured = null;
        var handler = new FakeHttpMessageHandler(req =>
        {
            captured = req;
            return new HttpResponseMessage(HttpStatusCode.Created)
            {
                Content = new System.Net.Http.StringContent(
                    """{"id":1,"created_at":"2026-06-02T00:00:00Z"}""",
                    System.Text.Encoding.UTF8,
                    "application/json"),
            };
        });
        var svc = NewService(handler);

        await svc.CreateIssueCommentAsync(Ref, "body", CancellationToken.None);

        captured.Should().NotBeNull();
        captured!.Headers.Authorization?.Scheme.Should().Be("Bearer");
        captured.Headers.Authorization?.Parameter.Should().Be("ghp_test");
        captured.Headers.Contains("X-GitHub-Api-Version").Should().BeTrue();
    }

    // --- non-2xx throws HttpRequestException ---

    [Fact]
    public async Task CreateIssueCommentAsync_On403_ThrowsHttpRequestException_WithStatusCode()
    {
        var handler = new FakeHttpMessageHandler(_ =>
            new HttpResponseMessage(HttpStatusCode.Forbidden)
            {
                Content = new System.Net.Http.StringContent(
                    """{"message":"Resource not accessible by integration"}""",
                    System.Text.Encoding.UTF8,
                    "application/json"),
            });
        var svc = NewService(handler);

        Func<Task> act = () => svc.CreateIssueCommentAsync(Ref, "body", CancellationToken.None);
        var ex = await act.Should().ThrowAsync<HttpRequestException>();
        ex.Which.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task CreateIssueCommentAsync_On404_ThrowsHttpRequestException_WithStatusCode()
    {
        var handler = new FakeHttpMessageHandler(_ =>
            new HttpResponseMessage(HttpStatusCode.NotFound)
            {
                Content = new System.Net.Http.StringContent(
                    """{"message":"Not Found"}""",
                    System.Text.Encoding.UTF8,
                    "application/json"),
            });
        var svc = NewService(handler);

        Func<Task> act = () => svc.CreateIssueCommentAsync(Ref, "body", CancellationToken.None);
        var ex = await act.Should().ThrowAsync<HttpRequestException>();
        ex.Which.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // --- argument guards ---

    [Fact]
    public async Task CreateIssueCommentAsync_NullReference_ThrowsArgumentNullException()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.Created));
        var svc = NewService(handler);

        Func<Task> act = () => svc.CreateIssueCommentAsync(null!, "body", CancellationToken.None);
        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    // --- malformed-2xx throws GitHubRestContractException (not HttpRequestException) ---

    [Fact]
    public async Task CreateIssueCommentAsync_On2xx_MissingId_ThrowsContractException()
    {
        // 201 Created but body has no "id" → contract violation, NOT a transport error.
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.Created, """{"created_at":"2026-06-02T10:30:00Z"}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateIssueCommentAsync(Ref, "hi", CancellationToken.None);

        await act.Should().ThrowAsync<GitHubRestContractException>();
    }

    [Fact]
    public async Task CreateIssueCommentAsync_On2xx_MissingCreatedAt_ThrowsContractException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.Created, """{"id":123}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateIssueCommentAsync(Ref, "hi", CancellationToken.None);

        await act.Should().ThrowAsync<GitHubRestContractException>();
    }
}
