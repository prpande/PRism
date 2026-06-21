using FluentAssertions;
using PRism.GitHub;

namespace PRism.GitHub.Tests;

public class GitHubGraphQLExceptionNotFoundTests
{
    [Fact]
    public void IsFirstErrorNotFound_true_for_top_level_type()  // GitHub's real "could not resolve to a node" shape
    {
        var json = """[{"type":"NOT_FOUND","path":["addPullRequestReviewThreadReply"],"message":"Could not resolve to a node with the global id of 'PRRT_x'."}]""";
        GitHubGraphQLException.IsFirstErrorNotFound(json).Should().BeTrue();
    }

    [Fact]
    public void IsFirstErrorNotFound_true_for_extensions_code()
    {
        var json = """[{"message":"nope","extensions":{"code":"NOT_FOUND"}}]""";
        GitHubGraphQLException.IsFirstErrorNotFound(json).Should().BeTrue();
    }

    [Fact]
    public void IsFirstErrorNotFound_false_for_message_only()  // the existing simplified fixtures
    {
        var json = """[{"message":"Could not resolve to a node with the global id of 'PRRT_x'."}]""";
        GitHubGraphQLException.IsFirstErrorNotFound(json).Should().BeFalse();
    }

    [Theory]
    [InlineData("""[{"type":"FORBIDDEN","message":"no"}]""")]
    [InlineData("""[{"extensions":{"code":"RATE_LIMITED"}}]""")]
    [InlineData("[]")]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("""[42]""")]
    public void IsFirstErrorNotFound_false_for_non_notfound_or_malformed(string json)
        => GitHubGraphQLException.IsFirstErrorNotFound(json).Should().BeFalse();

    [Fact]
    public void FormatErrorsMessage_prefixes_top_level_type_code()  // formerly only extensions.code got a [CODE] prefix
    {
        var json = """[{"type":"NOT_FOUND","message":"gone"}]""";
        GitHubGraphQLException.FormatErrorsMessage(json).Should().Contain("[NOT_FOUND]").And.Contain("gone");
    }
}
