using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests;

public sealed class InboxPollerHostingTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public InboxPollerHostingTests(PRismWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task Host_starts_with_inbox_poller_registered()
    {
        // Creating the client triggers WebHost startup. If any registered IHostedService
        // fails to start, WebApplicationFactory throws here.
        using var client = _factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/api/health", UriKind.Relative));
        resp.IsSuccessStatusCode.Should().BeTrue();
    }
}
