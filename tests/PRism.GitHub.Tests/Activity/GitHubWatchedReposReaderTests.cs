using System.Net;
using System.Threading;
using FluentAssertions;
using PRism.GitHub.Activity;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Activity;

public sealed class GitHubWatchedReposReaderTests
{
    private static GitHubWatchedReposReader MakeReader(HttpStatusCode code, string json)
        => new(new FakeHttpClientFactory(
                FakeHttpMessageHandler.Returns(code, json),
                new Uri("https://api.github.com/")),
            () => System.Threading.Tasks.Task.FromResult<string?>("token"));

    [Fact]
    public async System.Threading.Tasks.Task Parses_full_names()
    {
        const string json = """[{"full_name":"acme/api"},{"full_name":"acme/pos"}]""";
        var result = await MakeReader(HttpStatusCode.OK, json).ReadAsync(CancellationToken.None);
        result.Degraded.Should().BeFalse();
        result.Repos.Should().Equal("acme/api", "acme/pos");
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData((HttpStatusCode)429)]
    public async System.Threading.Tasks.Task Faults_degrade(HttpStatusCode code)
        => (await MakeReader(code, "").ReadAsync(CancellationToken.None)).Degraded.Should().BeTrue();

    [Fact]
    public async System.Threading.Tasks.Task Malformed_json_degrades_without_throwing()
    {
        var result = await MakeReader(HttpStatusCode.OK, "NOT JSON AT ALL {{{").ReadAsync(CancellationToken.None);
        result.Repos.Should().BeEmpty();
        result.Degraded.Should().BeTrue();
    }

    [Fact]
    public async System.Threading.Tasks.Task Non_array_root_degrades()
    {
        var result = await MakeReader(HttpStatusCode.OK, """{"full_name":"acme/api"}""").ReadAsync(CancellationToken.None);
        result.Repos.Should().BeEmpty();
        result.Degraded.Should().BeTrue();
    }

    [Fact]
    public async System.Threading.Tasks.Task Genuine_cancellation_propagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var reader = MakeReader(HttpStatusCode.OK, "[]");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => reader.ReadAsync(cts.Token));
    }

    [Fact]
    public async System.Threading.Tasks.Task Element_missing_full_name_is_skipped()
    {
        const string json = """[{"id":1},{"full_name":"acme/api"},{"full_name":""}]""";
        var result = await MakeReader(HttpStatusCode.OK, json).ReadAsync(CancellationToken.None);
        result.Degraded.Should().BeFalse();
        result.Repos.Should().ContainSingle().Which.Should().Be("acme/api");
    }

    [Fact]
    public async System.Threading.Tasks.Task Reads_all_watched_repos_across_pages()
    {
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"full_name":"o/r1"}]""", "https://api.github.com/user/subscriptions?page=2"),
            (HttpStatusCode.OK, """[{"full_name":"o/r2"}]""", null));
        var reader = new GitHubWatchedReposReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => System.Threading.Tasks.Task.FromResult<string?>("token"),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<GitHubWatchedReposReader>.Instance);

        var result = await reader.ReadAsync(CancellationToken.None);

        result.Degraded.Should().BeFalse();
        result.Repos.Should().Equal("o/r1", "o/r2");   // page-2 repo no longer silently truncated
    }
}
