using System.Net;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using PRism.Web.Endpoints;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// #466 — GitHubErrorMapper previously flattened an upstream 404 (e.g. posting a comment
// against a deleted file/thread) into the network-error default, showing "Couldn't reach
// GitHub. Try again." for a resource that is definitively gone. These tests pin the
// explicit not-found arm plus the pre-existing arms it must not disturb; the frontend
// branches on `code` and surfaces `message` verbatim, so both are contract.
public class GitHubErrorMapperTests
{
    private static HttpRequestException Http(HttpStatusCode status) => new("boom", null, status);

    [Fact]
    public void Maps_404_to_github_not_found_with_definitive_copy()
    {
        var dto = GitHubErrorMapper.Map(Http(HttpStatusCode.NotFound));

        dto.Code.Should().Be("github-not-found");
        dto.Message.Should().Be("The resource was not found on GitHub.");
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden, "github-forbidden")]
    [InlineData(HttpStatusCode.Unauthorized, "github-unauthorized")]
    [InlineData(HttpStatusCode.UnprocessableEntity, "github-validation-error")]
    public void Existing_explicit_arms_are_undisturbed(HttpStatusCode status, string expectedCode)
    {
        GitHubErrorMapper.Map(Http(status)).Code.Should().Be(expectedCode);
    }

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.BadGateway)]
    public void Other_http_statuses_still_fall_to_the_network_error_default(HttpStatusCode status)
    {
        var dto = GitHubErrorMapper.Map(Http(status));

        dto.Code.Should().Be("github-network-error");
        dto.Message.Should().Be("Couldn't reach GitHub. Try again.");
    }

    [Fact]
    public void Non_http_exceptions_fall_to_the_network_error_default()
    {
        GitHubErrorMapper.Map(new InvalidOperationException("x")).Code.Should().Be("github-network-error");
    }

    // Mirrors #605 item E (401/403 carry their real statuses): a definitive upstream 404
    // reported as 502 reads as a transient blip and invites futile retries; 404 tells the
    // client the target is gone. Frontend callers branch on `code`, never the literal
    // status, so the status change is wire-safe.
    [Theory]
    [InlineData(HttpStatusCode.NotFound, StatusCodes.Status404NotFound)]
    [InlineData(HttpStatusCode.Unauthorized, StatusCodes.Status401Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden, StatusCodes.Status403Forbidden)]
    [InlineData(HttpStatusCode.BadGateway, StatusCodes.Status502BadGateway)]
    public void ToResult_carries_the_truthful_http_status(HttpStatusCode upstream, int expectedStatus)
    {
        var result = GitHubErrorMapper.ToResult(Http(upstream));

        result.Should().BeOfType<JsonHttpResult<SubmitErrorDto>>()
            .Which.StatusCode.Should().Be(expectedStatus);
    }
}
