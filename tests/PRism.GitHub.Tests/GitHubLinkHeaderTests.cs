using System.Net;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubLinkHeaderTests
{
    private static HttpResponseMessage WithLink(string link)
    {
        var r = new HttpResponseMessage(HttpStatusCode.OK);
        r.Headers.TryAddWithoutValidation("Link", link);
        return r;
    }

    [Fact]
    public void TryGetRel_finds_quoted_next()
    {
        using var r = WithLink("<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"");
        Assert.True(GitHubLinkHeader.TryGetRel(r, "next", out var url));
        Assert.Equal("https://api.github.com/x?page=2", url);
    }

    [Fact]
    public void TryGetRel_finds_last()
    {
        using var r = WithLink("<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"");
        Assert.True(GitHubLinkHeader.TryGetRel(r, "last", out var url));
        Assert.Equal("https://api.github.com/x?page=9", url);
    }

    [Fact]
    public void TryGetRel_accepts_unquoted_rel()
    {
        using var r = WithLink("<https://api.github.com/x?page=2>; rel=next");
        Assert.True(GitHubLinkHeader.TryGetRel(r, "next", out var url));
        Assert.Equal("https://api.github.com/x?page=2", url);
    }

    [Fact]
    public void TryGetRel_missing_header_returns_false()
    {
        using var r = new HttpResponseMessage(HttpStatusCode.OK);
        Assert.False(GitHubLinkHeader.TryGetRel(r, "next", out var url));
        Assert.Equal(string.Empty, url);
    }

    [Fact]
    public void TryGetRel_rel_absent_returns_false()
    {
        using var r = WithLink("<https://api.github.com/x?page=9>; rel=\"last\"");
        Assert.False(GitHubLinkHeader.TryGetRel(r, "next", out _));
    }
}
