using FluentAssertions;

namespace PRism.GitHub.Tests;

// Unit tests for the GitHubGraphQLException.FormatErrorsMessage helper introduced
// after PR #55's debugging surfaced that the user-facing toast was "GitHub
// GraphQL request returned 1 error(s)." with the actual reason discarded.
// Each test pins one shape of the GitHub errors array to the user-visible
// string; a regression that drops the [CODE] or (path: ...) decoration ships
// only after these break.
public class GitHubGraphQLExceptionTests
{
    [Fact]
    public void FormatErrorsMessage_ParsesFirstErrorWithCode_PathAndMessage()
    {
        const string errors = """
            [{
              "message": "Resource not accessible by integration",
              "extensions": { "code": "FORBIDDEN" },
              "path": ["addPullRequestReview"]
            }]
            """;

        GitHubGraphQLException.FormatErrorsMessage(errors).Should()
            .Be("GitHub GraphQL: [FORBIDDEN] Resource not accessible by integration (path: addPullRequestReview)");
    }

    [Fact]
    public void FormatErrorsMessage_AppendsCountSuffix_WhenMultipleErrors()
    {
        const string errors = """
            [
              { "message": "first", "extensions": { "code": "FIRST" } },
              { "message": "second" },
              { "message": "third" }
            ]
            """;

        GitHubGraphQLException.FormatErrorsMessage(errors).Should()
            .Be("GitHub GraphQL: [FIRST] first (+ 2 more)");
    }

    [Fact]
    public void FormatErrorsMessage_OmitsCode_WhenExtensionsAbsent()
    {
        const string errors = """[{"message": "bare message"}]""";

        GitHubGraphQLException.FormatErrorsMessage(errors).Should()
            .Be("GitHub GraphQL: bare message");
    }

    [Fact]
    public void FormatErrorsMessage_OmitsPath_WhenPathArrayEmpty()
    {
        const string errors = """[{"message": "msg", "path": []}]""";

        GitHubGraphQLException.FormatErrorsMessage(errors).Should()
            .Be("GitHub GraphQL: msg");
    }

    [Fact]
    public void FormatErrorsMessage_RendersMultiSegmentPath_JoinedWithSlash()
    {
        const string errors = """[{"message": "msg", "path": ["repository", "pullRequest", "id"]}]""";

        GitHubGraphQLException.FormatErrorsMessage(errors).Should()
            .Be("GitHub GraphQL: msg (path: repository/pullRequest/id)");
    }

    [Fact]
    public void FormatErrorsMessage_FallsBackToCount_WhenJsonIsUnparseable()
    {
        // Defensive: a malformed errors string must never throw from the
        // formatter — turning an exception construction into a thrown
        // formatter exception would mask the original GraphQL failure.
        GitHubGraphQLException.FormatErrorsMessage("not json")
            .Should().Be("GitHub GraphQL request returned errors (unparseable payload).");
    }

    [Fact]
    public void FormatErrorsMessage_HandlesEmptyArray()
    {
        GitHubGraphQLException.FormatErrorsMessage("[]")
            .Should().Be("GitHub GraphQL request returned 0 error(s).");
    }

    [Fact]
    public void FormatErrorsMessage_HandlesEmptyInput()
    {
        GitHubGraphQLException.FormatErrorsMessage("")
            .Should().Be("GitHub GraphQL request returned 0 error(s).");
    }

    [Fact]
    public void Exception_PreservesRawErrorsJson_ForDiagnosticLogging()
    {
        const string raw = """[{"message": "oops"}]""";
        var ex = new GitHubGraphQLException(GitHubGraphQLException.FormatErrorsMessage(raw), raw);

        ex.Message.Should().Be("GitHub GraphQL: oops");
        ex.ErrorsJson.Should().Be(raw);
    }
}
