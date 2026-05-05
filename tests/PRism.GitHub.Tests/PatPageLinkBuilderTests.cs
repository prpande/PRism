using PRism.GitHub;
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests;

public class PatPageLinkBuilderTests
{
    [Theory]
    [InlineData("https://github.com", "https://github.com/settings/personal-access-tokens/new")]
    [InlineData("https://github.acme.com", "https://github.acme.com/settings/personal-access-tokens/new")]
    [InlineData("https://github.acme.com/", "https://github.acme.com/settings/personal-access-tokens/new")]
    public void Build_returns_host_aware_URL(string host, string expected)
    {
        PatPageLinkBuilder.Build(host).Should().Be(expected);
    }
}
