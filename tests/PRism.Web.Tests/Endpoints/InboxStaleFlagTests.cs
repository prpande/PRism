using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Inbox;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

/// <summary>
/// Verifies that <c>GET /api/inbox</c> surfaces the <c>stale</c> wire flag driven by
/// <see cref="IInboxRefreshOrchestrator.IsServingRehydratedSnapshot"/>. #619.
/// </summary>
public class InboxStaleFlagTests
{
    private static InboxSnapshot EmptySnapshot() =>
        new(
            new Dictionary<string, IReadOnlyList<PRism.Core.Contracts.PrInboxItem>>(),
            new Dictionary<string, PRism.AI.Contracts.Dtos.InboxItemEnrichment>(),
            DateTimeOffset.UtcNow,
            CiProbeComplete: true);

    [Fact]
    public async Task Inbox_GET_reports_stale_true_while_serving_rehydrated_snapshot()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = EmptySnapshot(),
            IsServingRehydratedSnapshot = true,
        };
        using var factory = new PRismWebApplicationFactory();
        factory.FakeOrchestrator = fakeOrch;
        var client = factory.CreateClient();

        var body = await client.GetFromJsonAsync<JsonElement>("/api/inbox");

        body.GetProperty("stale").GetBoolean().Should().BeTrue(
            "the endpoint must surface stale=true when the orchestrator is serving a rehydrated snapshot");
    }

    [Fact]
    public async Task Inbox_GET_reports_stale_false_when_not_rehydrated()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = EmptySnapshot(),
            IsServingRehydratedSnapshot = false,
        };
        using var factory = new PRismWebApplicationFactory();
        factory.FakeOrchestrator = fakeOrch;
        var client = factory.CreateClient();

        var body = await client.GetFromJsonAsync<JsonElement>("/api/inbox");

        body.GetProperty("stale").GetBoolean().Should().BeFalse(
            "the endpoint must surface stale=false when no rehydrated snapshot is being served");
    }
}
