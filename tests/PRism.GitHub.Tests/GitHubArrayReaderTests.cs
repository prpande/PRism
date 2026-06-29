using System.Net;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

// Direct tests for the shared degrade-don't-throw array reader (issue #665, sub-task 2).
// This helper is now the single home of the degrade contract the three Activity readers
// used to copy, so the contract is pinned here; the per-reader tests guard URL + parse.
public sealed class GitHubArrayReaderTests
{
    private static FakeHttpClientFactory Factory(HttpStatusCode code, string? body)
        => new(FakeHttpMessageHandler.Returns(code, body), new Uri("https://api.github.com/"));

    private static Task<string?> Token() => Task.FromResult<string?>("token");

    // Projects element { "v": "..." } → its string value; null (skipped) when "v" is absent.
    private static string? ParseV(JsonElement el)
        => el.TryGetProperty("v", out var v) ? v.GetString() : null;

    [Fact]
    public async Task Parses_array_via_delegate()
    {
        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            Factory(HttpStatusCode.OK, """[{"v":"a"},{"v":"b"}]"""), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeFalse();
        items.Should().Equal("a", "b");
    }

    [Fact]
    public async Task Empty_array_is_not_degraded()
    {
        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            Factory(HttpStatusCode.OK, "[]"), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeFalse();
        items.Should().BeEmpty();
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData((HttpStatusCode)429)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task Non_success_degrades(HttpStatusCode code)
    {
        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            Factory(code, ""), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeTrue();
        items.Should().BeEmpty();
    }

    [Fact]
    public async Task Malformed_json_degrades_without_throwing()
    {
        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            Factory(HttpStatusCode.OK, "NOT JSON AT ALL {{{"), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeTrue();
        items.Should().BeEmpty();
    }

    [Fact]
    public async Task Non_array_root_degrades()
    {
        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            Factory(HttpStatusCode.OK, """{"v":"a"}"""), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeTrue();
        items.Should().BeEmpty();
    }

    [Fact]
    public async Task Element_parse_returning_null_is_skipped_not_degraded()
    {
        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            Factory(HttpStatusCode.OK, """[{"v":"a"},{"x":1},{"v":"b"}]"""), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeFalse();
        items.Should().Equal("a", "b");
    }

    [Fact]
    public async Task Genuine_cancellation_propagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => GitHubArrayReader.ReadAsync(
            Factory(HttpStatusCode.OK, "[]"), Token, "x", ParseV, cts.Token));
    }

    // The parse delegate runs inside the helper's guarded region. An exception it raises
    // OUTSIDE the catch filter (HttpRequestException/JsonException/TaskCanceledException) must
    // propagate — this is the invariant the Notifications reader's int.TryParse defends, now
    // that the filter lives cross-file in the helper. (#665 adversarial review, finding 1)
    [Fact]
    public async Task Parse_delegate_throwing_out_of_filter_exception_propagates()
    {
        static string? Throwing(JsonElement _) => throw new OverflowException();

        await Assert.ThrowsAsync<OverflowException>(() => GitHubArrayReader.ReadAsync(
            Factory(HttpStatusCode.OK, """[{"v":"a"}]"""), Token, "x", Throwing, CancellationToken.None));
    }

    // A parse-delegate exception that IS in the filter degrades like any transport JSON fault.
    [Fact]
    public async Task Parse_delegate_throwing_in_filter_exception_degrades()
    {
        static string? Throwing(JsonElement _) => throw new JsonException("boom");

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            Factory(HttpStatusCode.OK, """[{"v":"a"}]"""), Token, "x", Throwing, CancellationToken.None);

        degraded.Should().BeTrue();
        items.Should().BeEmpty();
    }
}
