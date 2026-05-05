using PRism.GitHub;
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests;

public class HostUrlResolverTests
{
    [Theory]
    [InlineData("https://github.com", "https://api.github.com/")]
    [InlineData("https://github.acme.com", "https://github.acme.com/api/v3/")]
    [InlineData("https://github.acme.com/", "https://github.acme.com/api/v3/")]
    public void ApiBase_returns_expected(string host, string expected)
    {
        HostUrlResolver.ApiBase(host).ToString().Should().Be(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("github.com")]              // no scheme
    [InlineData("ftp://github.com")]
    public void ApiBase_throws_on_invalid(string? host)
    {
        Action act = () => HostUrlResolver.ApiBase(host!);
        act.Should().Throw<ArgumentException>();
    }
}
