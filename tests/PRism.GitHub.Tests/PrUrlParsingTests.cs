using System.Diagnostics.CodeAnalysis;
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public sealed class PrUrlParsingTests
{
    private static IReviewService Make(string host) =>
        new GitHubReviewService(
            new FakeHttpClientFactory(new FakeHttpMessageHandler(_ => new HttpResponseMessage()), HostUrlResolver.ApiBase(host)),
            () => Task.FromResult<string?>("token"),
            host);

    [Theory]
    [InlineData("https://github.com/foo/bar/pull/42", "https://github.com", "foo", "bar", 42)]
    [InlineData("https://github.com/foo/bar/pull/42/files", "https://github.com", "foo", "bar", 42)]
    [InlineData("https://github.com/foo/bar/pull/42#discussion_r1", "https://github.com", "foo", "bar", 42)]
    [InlineData("https://ghe.acme.com/foo/bar/pull/7", "https://ghe.acme.com", "foo", "bar", 7)]
    [SuppressMessage("Design", "CA1054:URI-like parameters should not be strings",
        Justification = "Test helper; URL is the input under test.")]
    public void Valid_pr_url_for_configured_host_parses(
        string url, string host, string owner, string repo, int n)
    {
        var sut = Make(host);
        sut.TryParsePrUrl(url, out var r).Should().BeTrue();
        r!.Owner.Should().Be(owner);
        r.Repo.Should().Be(repo);
        r.Number.Should().Be(n);
    }

    [Fact]
    public void Pr_url_on_wrong_host_returns_false()
    {
        var sut = Make("https://ghe.acme.com");
        sut.TryParsePrUrl("https://github.com/foo/bar/pull/42", out var r).Should().BeFalse();
        r.Should().BeNull();
    }

    [Theory]
    [InlineData("https://github.com/foo/bar/issues/1")]   // not a PR
    [InlineData("https://github.com/foo")]                // not a PR URL
    [InlineData("not a url at all")]
    [InlineData("")]
    [InlineData("ftp://github.com/foo/bar/pull/1")]       // wrong scheme
    [SuppressMessage("Design", "CA1054:URI-like parameters should not be strings",
        Justification = "Test helper; URL is the input under test.")]
    public void Non_pr_or_malformed_input_returns_false(string url)
    {
        var sut = Make("https://github.com");
        sut.TryParsePrUrl(url, out var r).Should().BeFalse();
        r.Should().BeNull();
    }

    [Fact]
    public void Trailing_slash_on_host_tolerated()
    {
        var sut = Make("https://github.com/");
        sut.TryParsePrUrl("https://github.com/foo/bar/pull/9", out var r).Should().BeTrue();
        r!.Number.Should().Be(9);
    }

    [Fact]
    public void Host_compare_is_case_insensitive()
    {
        var sut = Make("https://GitHub.com");
        sut.TryParsePrUrl("https://github.com/foo/bar/pull/9", out var r).Should().BeTrue();
    }
}
