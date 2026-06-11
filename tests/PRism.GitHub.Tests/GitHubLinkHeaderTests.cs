using System.Net;
using FluentAssertions;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public sealed class GitHubLinkHeaderTests
{
    private static HttpResponseMessage WithLink(string? link)
    {
        var r = new HttpResponseMessage(HttpStatusCode.OK);
        if (link is not null) r.Headers.TryAddWithoutValidation("Link", link);
        return r;
    }

    [Fact]
    public void Returns_next_url_when_present()
    {
        using var resp = WithLink(
            "<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"");
        GitHubLinkHeader.TryGetNext(resp).Should().Be(new Uri("https://api.github.com/x?page=2"));
    }

    [Fact]
    public void Returns_null_when_only_last()
    {
        using var resp = WithLink("<https://api.github.com/x?page=9>; rel=\"last\"");
        GitHubLinkHeader.TryGetNext(resp).Should().BeNull();
    }

    [Fact]
    public void Returns_null_when_no_link_header()
    {
        using var resp = WithLink(null);
        GitHubLinkHeader.TryGetNext(resp).Should().BeNull();
    }
}
