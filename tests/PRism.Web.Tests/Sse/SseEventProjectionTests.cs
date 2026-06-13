using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Web.Sse;
using Xunit;

namespace PRism.Web.Tests.Sse;

// Wire-shape contract for the pr-updated SSE projection.
// SseChannel.OnActivePrUpdated delegates wire shape to SseEventProjection.Project (the SSOT).
public class SseEventProjectionTests
{
    [Fact]
    public void Project_pr_updated_carries_base_sha_fields()
    {
        var evt = new ActivePrUpdated(
            new PrReference("o", "r", 1),
            HeadShaChanged: false, CommentCountChanged: false, NewHeadSha: null,
            CommentCountDelta: 0, IsMerged: false, IsClosed: false,
            BaseShaChanged: true, NewBaseSha: "base2");

        var (name, payload) = SseEventProjection.Project(evt);

        name.Should().Be("pr-updated");
        var wire = payload.Should().BeOfType<SseEventProjection.ActivePrUpdatedWire>().Subject;
        wire.BaseShaChanged.Should().BeTrue();
        wire.NewBaseSha.Should().Be("base2");
    }
}
