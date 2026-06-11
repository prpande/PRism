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

    [Theory]
    [InlineData("https://github.com", "https://api.github.com/graphql")]
    // GHES: REST is at /api/v3/, GraphQL is at /api/graphql (no /v3) — GitHub's
    // documented contract. Composing /api/v3/ + "graphql" against the named REST
    // client's BaseAddress would yield /api/v3/graphql which 404s on every GHES.
    [InlineData("https://github.acme.com", "https://github.acme.com/api/graphql")]
    [InlineData("https://github.acme.com/", "https://github.acme.com/api/graphql")]
    public void GraphQlEndpoint_returns_absolute_url(string host, string expected)
    {
        HostUrlResolver.GraphQlEndpoint(host).ToString().Should().Be(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("github.com")]
    [InlineData("ftp://github.com")]
    public void GraphQlEndpoint_throws_on_invalid(string? host)
    {
        Action act = () => HostUrlResolver.GraphQlEndpoint(host!);
        act.Should().Throw<ArgumentException>();
    }
}

public class HostUrlResolverIsGitHubDotComTests
{
    [Theory]
    [InlineData("https://api.github.com/user", true)]
    [InlineData("https://API.GITHUB.COM/user", true)]
    [InlineData("https://github.example.com/api/v3/user", false)]
    [InlineData(null, false)]
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Design",
        "CA1054:URI-like parameters should not be strings",
        Justification = "xUnit InlineData cannot carry a Uri; the string is converted in the body.")]
    public void IsGitHubDotCom_ClassifiesHost(string? uri, bool expected)
    {
        var u = uri is null ? null : new Uri(uri);
        Assert.Equal(expected, HostUrlResolver.IsGitHubDotCom(u));
    }
}
