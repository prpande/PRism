using PRism.Core.Contracts;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class PrReferenceParserTests
{
    [Theory]
    [InlineData("acme/api-server/123", "acme", "api-server", 123)]
    [InlineData("Anthropic/claude-code/9999", "Anthropic", "claude-code", 9999)]
    public void Parse_accepts_owner_repo_number(string s, string owner, string repo, int number)
    {
        PrReferenceParser.TryParse(s, out var result).Should().BeTrue();
        result!.Owner.Should().Be(owner);
        result.Repo.Should().Be(repo);
        result.Number.Should().Be(number);
    }

    [Theory]
    [InlineData("")]
    [InlineData("acme")]
    [InlineData("acme/api-server")]
    [InlineData("acme/api-server/")]
    [InlineData("acme/api-server/abc")]
    [InlineData("acme/api-server/-1")]
    [InlineData("acme//123")]
    [InlineData("/api-server/123")]
    [InlineData("acme/api-server/123/extra")]
    [InlineData("acme:x/api-server/123")]
    public void Parse_rejects_malformed_inputs(string s)
    {
        PrReferenceParser.TryParse(s, out var result).Should().BeFalse();
        result.Should().BeNull();
    }
}
