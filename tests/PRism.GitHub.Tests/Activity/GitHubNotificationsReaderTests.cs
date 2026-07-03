using System;
using System.Globalization;
using System.Net;
using System.Threading;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.GitHub.Activity;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Activity;

public sealed class GitHubNotificationsReaderTests
{
    private static GitHubNotificationsReader MakeReader(HttpStatusCode code, string json)
        => new(new FakeHttpClientFactory(
                FakeHttpMessageHandler.Returns(code, json),
                new Uri("https://api.github.com/")),
            () => System.Threading.Tasks.Task.FromResult<string?>("token"));

    [Fact]
    public async System.Threading.Tasks.Task Parses_pr_notification()
    {
        const string json = """
        [{"reason":"review_requested","updated_at":"2026-06-10T10:00:00Z",
          "repository":{"full_name":"acme/api"},
          "subject":{"type":"PullRequest","title":"Fix it",
                     "url":"https://api.github.com/repos/acme/api/pulls/1842"}}]
        """;
        var reader = MakeReader(HttpStatusCode.OK, json);
        var result = await reader.ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None);
        result.Degraded.Should().BeFalse();
        var n = result.Notifications.Should().ContainSingle().Subject;
        n.Repo.Should().Be("acme/api");
        n.Reason.Should().Be("review_requested");
        n.PrNumber.Should().Be(1842);
        n.Title.Should().Be("Fix it");
        n.Timestamp.Should().Be(DateTimeOffset.Parse("2026-06-10T10:00:00Z", CultureInfo.InvariantCulture));
        n.Url.Should().Be("https://api.github.com/repos/acme/api/pulls/1842");
    }

    [Fact]
    public async System.Threading.Tasks.Task Drops_non_pullrequest_subjects()
    {
        const string json = """
        [{"reason":"subscribed","updated_at":"2026-06-10T10:00:00Z",
          "repository":{"full_name":"acme/api"},
          "subject":{"type":"Issue","title":"x","url":"https://api.github.com/repos/acme/api/issues/5"}}]
        """;
        var result = await MakeReader(HttpStatusCode.OK, json).ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None);
        result.Notifications.Should().BeEmpty();
        result.Degraded.Should().BeFalse();
    }

    [Fact]
    public async System.Threading.Tasks.Task Drops_pullrequest_subject_with_no_pulls_match_in_url()
    {
        const string json = """
        [{"reason":"mention","updated_at":"2026-06-10T10:00:00Z",
          "repository":{"full_name":"acme/api"},
          "subject":{"type":"PullRequest","title":"Bad url",
                     "url":"https://api.github.com/repos/acme/api/issues/99"}}]
        """;
        var result = await MakeReader(HttpStatusCode.OK, json).ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None);
        result.Notifications.Should().BeEmpty();
        result.Degraded.Should().BeFalse();
    }

    [Fact]
    public async System.Threading.Tasks.Task Drops_pr_with_oversized_number_without_throwing()
    {
        // 20-digit PR number overflows int. Parse() must drop it (degrade-don't-throw),
        // not let OverflowException escape the reader's catch filter and 500 /api/activity.
        const string json = """
        [{"reason":"review_requested","updated_at":"2026-06-10T10:00:00Z",
          "repository":{"full_name":"acme/api"},
          "subject":{"type":"PullRequest","title":"huge",
                     "url":"https://api.github.com/repos/acme/api/pulls/99999999999999999999"}}]
        """;
        var result = await MakeReader(HttpStatusCode.OK, json).ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None);
        result.Notifications.Should().BeEmpty();
        result.Degraded.Should().BeFalse();
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData((HttpStatusCode)429)]
    public async System.Threading.Tasks.Task Faults_degrade(HttpStatusCode code)
        => (await MakeReader(code, "").ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None)).Degraded.Should().BeTrue();

    [Fact]
    public async System.Threading.Tasks.Task Malformed_json_degrades_without_throwing()
    {
        var result = await MakeReader(HttpStatusCode.OK, "NOT JSON AT ALL {{{").ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None);
        result.Notifications.Should().BeEmpty();
        result.Degraded.Should().BeTrue();
    }

    [Fact]
    public async System.Threading.Tasks.Task Genuine_cancellation_propagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var reader = MakeReader(HttpStatusCode.OK, "[]");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => reader.ReadAsync(DateTimeOffset.UnixEpoch, cts.Token));
    }

    [Fact]
    public async System.Threading.Tasks.Task Since_query_param_is_present_in_request_uri()
    {
        HttpRequestMessage? captured = null;
        var handler = new FakeHttpMessageHandler(req =>
        {
            captured = req;
            return new System.Net.Http.HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new System.Net.Http.StringContent("[]", System.Text.Encoding.UTF8, "application/json")
            };
        });
        var reader = new GitHubNotificationsReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => System.Threading.Tasks.Task.FromResult<string?>("token"));

        var since = new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero);
        await reader.ReadAsync(since, CancellationToken.None);

        captured.Should().NotBeNull();
        captured!.RequestUri!.Query.Should().Contain("since=");
        captured.RequestUri.Query.Should().Contain("all=true");
        captured.RequestUri.Query.Should().Contain("per_page=100");
    }

    [Fact]
    public async System.Threading.Tasks.Task Later_page_fault_returns_prefix_not_degraded()
    {
        // Page 1 = one valid PR notification + a next; page 2 = 500. The reader must return the
        // page-1 item with Degraded:false (a coherent prefix), NOT Degraded:true — which would
        // blank the whole activity rail (spec Consumer-semantics section).
        const string page1 = """
            [{"subject":{"type":"PullRequest","url":"https://api.github.com/repos/o/r/pulls/5","title":"T"},
              "repository":{"full_name":"o/r"},"reason":"mention","updated_at":"2026-07-01T00:00:00Z"}]
            """;
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, page1, "https://api.github.com/notifications?page=2"),
            (HttpStatusCode.InternalServerError, "", null));
        var reader = new GitHubNotificationsReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => System.Threading.Tasks.Task.FromResult<string?>("token"),
            NullLogger<GitHubNotificationsReader>.Instance);

        var result = await reader.ReadAsync(DateTimeOffset.UtcNow.AddDays(-1), CancellationToken.None);

        result.Degraded.Should().BeFalse();          // coherent prefix ⇒ do NOT blank the rail
        result.Notifications.Should().ContainSingle(n => n.Repo == "o/r" && n.PrNumber == 5);
        handler.CallCount.Should().Be(2);            // it tried page 2, got 500, kept page 1
    }
}
