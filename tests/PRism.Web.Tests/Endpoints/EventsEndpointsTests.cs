using System.IO;
using System.Net;
using System.Text;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class EventsEndpointsTests
{
    [Fact]
    public async Task Sse_endpoint_returns_text_event_stream_content_type()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        resp.Content.Headers.ContentType!.MediaType.Should().Be("text/event-stream");
    }

    [Fact]
    public async Task Sse_endpoint_writes_initial_heartbeat()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        var firstLine = await reader.ReadLineAsync(cts.Token);

        firstLine.Should().StartWith(":heartbeat");
    }

    [Fact]
    public async Task Sse_endpoint_increments_subscriber_count_on_connect()
    {
        using var factory = new PRismWebApplicationFactory();
        var subs = factory.Services.GetRequiredService<InboxSubscriberCount>();

        subs.Current.Should().Be(0);

        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        // Read the initial heartbeat to confirm the subscription is established.
        using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token); // ":heartbeat"

        subs.Current.Should().Be(1);
    }

    [Fact]
    public async Task Sse_endpoint_close_decrements_subscriber_count()
    {
        using var factory = new PRismWebApplicationFactory();
        var subs = factory.Services.GetRequiredService<InboxSubscriberCount>();

        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token); // wait for initial heartbeat → subscription established

        subs.Current.Should().Be(1);

        // Dispose the response to close the connection.
        resp.Dispose();
        stream.Dispose();

        // Give the server a moment to process the disconnect.
        await Task.Delay(200, CancellationToken.None);

        subs.Current.Should().Be(0);
    }

    [Fact]
    public async Task Sse_endpoint_writes_inbox_updated_event_when_published()
    {
        using var factory = new PRismWebApplicationFactory();
        var bus = factory.Services.GetRequiredService<IReviewEventBus>();

        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        // Consume the initial heartbeat first.
        await reader.ReadLineAsync(cts.Token); // ":heartbeat"
        await reader.ReadLineAsync(cts.Token); // ""  (blank line after heartbeat)

        // Publish an event from the bus.
        bus.Publish(new InboxUpdated(new[] { "review-requested" }, 1));

        // Read the event frame lines.
        var eventLine = await reader.ReadLineAsync(cts.Token);
        var dataLine = await reader.ReadLineAsync(cts.Token);

        eventLine.Should().Be("event: inbox-updated");
        dataLine.Should().Contain("\"changedSectionIds\":[\"review-requested\"]");
        dataLine.Should().Contain("\"newOrUpdatedPrCount\":1");
        dataLine.Should().StartWith("data: ");
    }
}
