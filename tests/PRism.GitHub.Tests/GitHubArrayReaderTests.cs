using System.Net;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging;
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

    private static FakeHttpClientFactory FactoryFor(HttpMessageHandler handler)
        => new(handler, new Uri("https://api.github.com/"));

    private static Task<string?> Token() => Task.FromResult<string?>("token");

    // Projects element { "v": "..." } → its string value; null (skipped) when "v" is absent.
    private static string? ParseV(JsonElement el)
        => el.TryGetProperty("v", out var v) ? v.GetString() : null;

    [Fact]
    public async Task Follows_link_next_across_pages_and_concatenates()
    {
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.OK, """[{"v":"b"}]""", "https://api.github.com/x?page=3"),
            (HttpStatusCode.OK, """[{"v":"c"}]""", null));

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeFalse();
        items.Should().Equal("a", "b", "c");
        handler.CallCount.Should().Be(3);
    }

    [Fact]
    public async Task Later_page_failure_returns_partial_prefix_not_degraded()
    {
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"},{"v":"b"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.InternalServerError, "", null));

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeFalse();          // coherent prefix must not blank the rail
        items.Should().Equal("a", "b");       // page-1 items retained
        handler.CallCount.Should().Be(2);     // it tried page 2, got 500, stopped
    }

    [Fact]
    public async Task Later_page_transport_fault_returns_partial_prefix_not_degraded()
    {
        // Page 1 OK with a next; page 2 throws (no scripted page → over-call throw is a
        // transport-style fault the catch filter would NOT cover, so instead script an
        // explicit page-2 fault via a malformed body caught as JsonException on the SECOND page).
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.OK, "NOT JSON {{{", null));

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeFalse();
        items.Should().Equal("a");
        handler.CallCount.Should().Be(2);
    }

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

    [Fact]
    public async Task Stops_at_max_page_budget_and_logs_cap_hit()
    {
        // 4 pages, each advertising a next; maxPages: 2 → only 2 requests, then break+log.
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.OK, """[{"v":"b"}]""", "https://api.github.com/x?page=3"),
            (HttpStatusCode.OK, """[{"v":"c"}]""", "https://api.github.com/x?page=4"),
            (HttpStatusCode.OK, """[{"v":"d"}]""", null));
        var logger = new CapturingLogger<GitHubArrayReaderTests>();

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None,
            logger, resource: "user/subscriptions", maxPages: 2);

        degraded.Should().BeFalse();
        items.Should().Equal("a", "b");
        handler.CallCount.Should().Be(2);
        logger.Entries.Should().ContainSingle(e =>
            e.Level == LogLevel.Warning && e.Message.Contains("user/subscriptions"));
    }

    [Fact]
    public async Task Repeated_next_url_breaks_without_exhausting_budget()
    {
        // Both pages advertise the SAME next URL. The visited guard must stop after the
        // second fetch (the repeat), NOT loop up to maxPages, and NOT log a cap-hit.
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.OK, """[{"v":"b"}]""", "https://api.github.com/x?page=2"));
        var logger = new CapturingLogger<GitHubArrayReaderTests>();

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None,
            logger, resource: "user/subscriptions", maxPages: 10);

        degraded.Should().BeFalse();
        items.Should().Equal("a", "b");
        handler.CallCount.Should().Be(2);            // stopped on the repeat, not at page 10
        logger.Entries.Should().BeEmpty();           // a cycle is not a budget cap
    }

    [Fact]
    public async Task Cycle_at_budget_boundary_does_not_log_cap_hit()
    {
        // A cycle that lands EXACTLY on the budget boundary must be treated as exhaustion,
        // not a cap: the visited-guard is checked before the budget, so no cap-hit is logged.
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.OK, """[{"v":"b"}]""", "https://api.github.com/x?page=2")); // repeat at page 2
        var logger = new CapturingLogger<GitHubArrayReaderTests>();

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None,
            logger, resource: "user/subscriptions", maxPages: 2); // budget == 2, cycle == page 2

        degraded.Should().BeFalse();
        items.Should().Equal("a", "b");
        logger.Entries.Should().BeEmpty();           // cycle wins over the budget: no false truncation signal
    }

    [Fact]
    public async Task Off_host_next_url_is_not_credentialed_and_degrades_to_prefix()
    {
        // Page 1 OK (same-host) advertises a WELL-FORMED but OFF-HOST next. Following it must
        // trip GitHubHttp.ApplyHeaders' scheme+host+port guard (throw HttpRequestException)
        // BEFORE the request is sent, so the off-host host never receives a credentialed call.
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://attacker.example/x?page=2"));

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None);

        items.Should().Equal("a");            // page-1 prefix retained
        degraded.Should().BeFalse();          // non-empty prefix ⇒ not degraded
        handler.CallCount.Should().Be(1);     // the off-host page-2 request never reached the handler

        // Positive control: prove the loop actually RECEIVED the off-host next, so CallCount==1
        // means "ApplyHeaders blocked the credentialed send" — NOT "the parser silently rejected
        // the URL" or "the loop never followed it" (which would make the assertion green for the
        // wrong reason if a future refactor host-filtered inside the parser). GitHubLinkHeader
        // must surface the off-host URL; the block therefore happens downstream at the egress guard.
        var probe = new HttpResponseMessage(HttpStatusCode.OK);
        probe.Headers.TryAddWithoutValidation("Link", "<https://attacker.example/x?page=2>; rel=\"next\"");
        GitHubLinkHeader.TryGetRel(probe, "next", out var surfaced).Should().BeTrue();
        surfaced.Should().Be("https://attacker.example/x?page=2");
    }
}
