using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class ActivityProviderTests
{
    private sealed class FakeReader(ReceivedEventsResult result) : IReceivedEventsReader
    {
        public Task<ReceivedEventsResult> ReadAsync(CancellationToken ct) => Task.FromResult(result);
    }

    private static RawReceivedEvent Review(string id) => new(
        id, "PullRequestReviewEvent", "alice", null, "acme/api", "created", 7, "T",
        "https://github.com/acme/api/pull/7", false, false, System.DateTimeOffset.UtcNow);

    [Fact]
    public async Task Maps_reader_output_into_response()
    {
        var reader = new FakeReader(new ReceivedEventsResult([Review("1")], Degraded: false));
        var sut = new ActivityProvider(reader, NullLogger<ActivityProvider>.Instance);

        var resp = await sut.GetActivityAsync(default);

        resp.Items.Should().ContainSingle().Which.Verb.Should().Be(ActivityVerb.Reviewed);
        resp.Degraded.ReceivedEvents.Should().BeFalse();
    }

    [Fact]
    public async Task Propagates_degradation_with_empty_items()
    {
        var reader = new FakeReader(new ReceivedEventsResult([], Degraded: true));
        var sut = new ActivityProvider(reader, NullLogger<ActivityProvider>.Instance);

        var resp = await sut.GetActivityAsync(default);

        resp.Items.Should().BeEmpty();
        resp.Degraded.ReceivedEvents.Should().BeTrue();
    }
}
