using System.Net;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core.Activity;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public sealed class ActivityEndpointsTests
{
    private sealed class StubProvider(ActivityResponse resp) : IActivityProvider
    {
        public Task<ActivityResponse> GetActivityAsync(CancellationToken ct) => Task.FromResult(resp);
        public void Reset() { }
    }

    // Builds a factory whose DI has IActivityProvider swapped for a stub.
    // Returns the inner PRismWebApplicationFactory (for CreateUnauthenticatedClient) and
    // the outer wrapper (the one whose server has the stub wired). The outer factory's
    // CreateClient returns a raw HttpClient (no session injection), so we manually add
    // the session token from its SessionTokenProvider (InternalsVisibleTo covers access).
    private static (PRismWebApplicationFactory Inner, WebApplicationFactory<Program> Outer)
        FactoryWith(ActivityResponse resp)
    {
        var inner = new PRismWebApplicationFactory();
        var outer = inner.WithWebHostBuilder(b =>
            b.ConfigureServices(s =>
            {
                s.RemoveAll<IActivityProvider>();
                s.AddSingleton<IActivityProvider>(new StubProvider(resp));
            }));
        return (inner, outer);
    }

    // Creates an authenticated client against the outer (stub-injected) server, manually
    // attaching the session token and origin header that PRismWebApplicationFactory.ConfigureClient
    // normally injects. The outer factory uses the base ConfigureClient (no auto-injection).
    private static System.Net.Http.HttpClient AuthenticatedClient(WebApplicationFactory<Program> outer)
    {
        var client = outer.CreateClient();
        var token = outer.Services.GetRequiredService<SessionTokenProvider>().Current;
        client.DefaultRequestHeaders.Add("X-PRism-Session", token);
        client.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin))
            client.DefaultRequestHeaders.Add("Origin", origin);
        return client;
    }

    private static ActivityResponse OneReviewed() => new(
        [new ActivityItem("alice", null, false, ActivityVerb.Reviewed, "acme/api", 7, "Fix",
            "https://github.com/acme/api/pull/7", System.DateTimeOffset.UnixEpoch, ActivitySource.ReceivedEvent)],
        System.DateTimeOffset.UnixEpoch, new ActivityDegradation(false, Notifications: false, Watching: false), []);

    // Two actorless notification items + a Watching list — used by the wire-value pin test.
    private static ActivityResponse NotificationFeed() => new(
        [
            new ActivityItem(null, null, false, ActivityVerb.ReviewRequested, "acme/api", 1842, "PR #1842",
                "https://github.com/acme/api/pull/1842", System.DateTimeOffset.UnixEpoch, ActivitySource.Notification),
            new ActivityItem(null, null, false, ActivityVerb.Mentioned, "acme/api", 1827, "PR #1827",
                "https://github.com/acme/api/pull/1827", System.DateTimeOffset.UnixEpoch, ActivitySource.Notification),
        ],
        System.DateTimeOffset.UnixEpoch,
        new ActivityDegradation(ReceivedEvents: false, Notifications: false, Watching: false),
        [new PRism.Core.Activity.WatchedRepoActivity("acme/api", 2, "https://github.com/acme/api")]);

    [Fact]
    public async Task Returns_200_with_items_and_kebab_case_enums()
    {
        var (inner, outer) = FactoryWith(OneReviewed());
        await using var _ = inner;
        await using var __ = outer;
        var client = AuthenticatedClient(outer);

        var resp = await client.GetAsync(new System.Uri("/api/activity", System.UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var json = await resp.Content.ReadAsStringAsync();
        // Architectural invariant: enums serialize kebab-case.
        json.Should().Contain("\"verb\":\"reviewed\"");
        json.Should().Contain("\"source\":\"received-event\"");

        var body = JsonDocument.Parse(json).RootElement;
        body.GetProperty("items").GetArrayLength().Should().Be(1);
        body.GetProperty("degraded").GetProperty("receivedEvents").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Returns_notification_source_watching_and_kebab_case_verbs_on_wire()
    {
        // Pin the exact serialized wire values for the new P2 shape so frontend
        // Tasks 11–12 can key on the literal kebab-case strings, not C# casing.
        var (inner, outer) = FactoryWith(NotificationFeed());
        await using var _ = inner;
        await using var __ = outer;
        var client = AuthenticatedClient(outer);

        var resp = await client.GetAsync(new System.Uri("/api/activity", System.UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var json = await resp.Content.ReadAsStringAsync();

        // Architectural invariant: ActivitySource.Notification → "notification" (NOT "Notification")
        json.Should().Contain("\"source\":\"notification\"");
        // ActivityVerb.ReviewRequested → "review-requested" (NOT "reviewRequested")
        json.Should().Contain("\"verb\":\"review-requested\"");
        // ActivityVerb.Mentioned → "mentioned"
        json.Should().Contain("\"verb\":\"mentioned\"");
        // watching array is present
        json.Should().Contain("\"watching\":");

        var body = JsonDocument.Parse(json).RootElement;
        body.GetProperty("items").GetArrayLength().Should().Be(2);

        // degraded object carries the three P2 flags (camelCase property names, boolean values)
        var degraded = body.GetProperty("degraded");
        degraded.GetProperty("notifications").GetBoolean().Should().BeFalse();
        degraded.GetProperty("watching").GetBoolean().Should().BeFalse();
        degraded.GetProperty("receivedEvents").GetBoolean().Should().BeFalse();

        // watching array has one entry
        body.GetProperty("watching").GetArrayLength().Should().Be(1);
    }

    [Fact]
    public async Task Returns_200_degraded_with_empty_items()
    {
        var (inner, outer) = FactoryWith(new ActivityResponse(
            [], System.DateTimeOffset.UnixEpoch,
            new ActivityDegradation(true, Notifications: false, Watching: false), []));
        await using var _ = inner;
        await using var __ = outer;
        var client = AuthenticatedClient(outer);

        var resp = await client.GetAsync(new System.Uri("/api/activity", System.UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement;
        body.GetProperty("items").GetArrayLength().Should().Be(0);
        body.GetProperty("degraded").GetProperty("receivedEvents").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Requires_session_token()
    {
        var (inner, outer) = FactoryWith(OneReviewed());
        await using var _ = inner;
        await using var __ = outer;
        // PRismWebApplicationFactory.ConfigureClient auto-attaches the session cookie AND
        // header on CreateClient(), so removing the header is NOT enough — use the factory's
        // CreateUnauthenticatedClient() which bypasses ConfigureClient entirely.
        // The inner factory's server runs with real IActivityProvider wiring but auth
        // middleware fires before any endpoint logic — 401 regardless of provider state.
        var client = inner.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new System.Uri("/api/activity", System.UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
