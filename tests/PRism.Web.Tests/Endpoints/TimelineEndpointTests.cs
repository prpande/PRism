using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core.Activity;
using PRism.Core.Contracts;
using PRism.Core.Json;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class TimelineEndpointTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _baseFactory;

    public TimelineEndpointTests(PRismWebApplicationFactory baseFactory) => _baseFactory = baseFactory;

    private sealed class FakeReader : IPrTimelineFeedReader
    {
        public Task<TimelinePage> ReadPageAsync(PrReference prRef, string? cursor, int pageSize, CancellationToken ct)
            => Task.FromResult(new TimelinePage(
                new[]
                {
                    new TimelineEvent("c1", ActivityVerb.Approved, new TimelineActorRef("alice", null, false),
                        DateTimeOffset.UnixEpoch, null, null, null),
                },
                OlderCursor: cursor is null ? "CUR" : null, HasOlder: cursor is null));
    }

    private sealed class DegradedReader : IPrTimelineFeedReader
    {
        public Task<TimelinePage> ReadPageAsync(PrReference prRef, string? cursor, int pageSize, CancellationToken ct)
            => Task.FromResult(new TimelinePage(Array.Empty<TimelineEvent>(), OlderCursor: null, HasOlder: false, Degraded: true));
    }

    // Mirrors ChecksEndpointTests: swap the reader via RemoveAll + AddSingleton on a
    // WithWebHostBuilder-derived factory, then hit it with an authenticated client (this
    // GET endpoint sits behind SessionTokenMiddleware like every other /api/pr/* route).
    private WebApplicationFactory<Program> FactoryWith(IPrTimelineFeedReader reader) =>
        _baseFactory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IPrTimelineFeedReader>();
            s.AddSingleton(reader);
        }));

    [Fact]
    public async Task Returns_timeline_page()
    {
        var client = FactoryWith(new FakeReader()).CreateAuthenticatedClient();
        var resp = await client.GetAsync(new Uri("/api/pr/acme/api/7/timeline", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var page = await resp.Content.ReadFromJsonAsync<TimelinePage>(JsonSerializerOptionsFactory.Api);
        page!.Events.Should().ContainSingle().Which.Verb.Should().Be(ActivityVerb.Approved);
        page.HasOlder.Should().BeTrue();
    }

    [Fact]
    public async Task Rejects_bad_owner()
    {
        var client = FactoryWith(new FakeReader()).CreateAuthenticatedClient();
        var resp = await client.GetAsync(new Uri("/api/pr/bad!owner/api/7/timeline", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Returns_502_when_read_degraded()
    {
        var client = FactoryWith(new DegradedReader()).CreateAuthenticatedClient();
        var resp = await client.GetAsync(new Uri("/api/pr/acme/api/7/timeline", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway); // false-empty must not read as 200/empty
    }
}
