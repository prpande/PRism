using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Json;
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

    [Fact]
    public void Project_pr_updated_threads_readiness_and_counts()
    {
        var evt = new ActivePrUpdated(
            new PrReference("o", "r", 1),
            HeadShaChanged: false, CommentCountChanged: false, NewHeadSha: null,
            CommentCountDelta: 0, IsMerged: false, IsClosed: false,
            BaseShaChanged: false, NewBaseSha: null,
            MergeReadiness: MergeReadiness.BehindBase, MergeReadinessChanged: true,
            Approvals: 2, ChangesRequested: 1);

        var (_, payload) = SseEventProjection.Project(evt);

        var wire = payload.Should().BeOfType<SseEventProjection.ActivePrUpdatedWire>().Subject;
        wire.MergeReadiness.Should().Be(MergeReadiness.BehindBase);
        wire.MergeReadinessChanged.Should().BeTrue();
        wire.Approvals.Should().Be(2);
        wire.ChangesRequested.Should().Be(1);
    }

    [Fact]
    public void Pr_updated_wire_serializes_readiness_kebab_case_via_api_options()
    {
        // The SSE channel (SseChannel.OnActivePrUpdated) serializes the projection payload with
        // JsonSerializerOptionsFactory.Api. Assert the enum emits kebab-case ("behind-base"), NOT
        // an int — otherwise the frontend MergeReadiness union would silently never match.
        var evt = new ActivePrUpdated(
            new PrReference("o", "r", 1),
            HeadShaChanged: false, CommentCountChanged: false, NewHeadSha: null,
            CommentCountDelta: 0, IsMerged: false, IsClosed: false,
            BaseShaChanged: false, NewBaseSha: null,
            MergeReadiness: MergeReadiness.BehindBase, MergeReadinessChanged: true,
            Approvals: null, ChangesRequested: null);

        var (_, payload) = SseEventProjection.Project(evt);
        var json = JsonSerializer.Serialize(payload, JsonSerializerOptionsFactory.Api);

        json.Should().Contain("\"mergeReadiness\":\"behind-base\"");
        json.Should().NotContain("\"mergeReadiness\":4"); // not the int ordinal
        json.Should().Contain("\"mergeReadinessChanged\":true");
    }

    // #571 — review-thread-resolution-changed: prRef-only payload, mirrors PrLifecycleChanged.
    [Fact]
    public void Project_review_thread_resolution_changed_carries_pr_ref()
    {
        var prRef = new PrReference("o", "r", 1);

        var (name, payload) = SseEventProjection.Project(new ReviewThreadResolutionChanged(prRef));

        name.Should().Be("review-thread-resolution-changed");
        var wire = payload.Should().BeOfType<SseEventProjection.ReviewThreadResolutionChangedWire>().Subject;
        wire.PrRef.Should().Be(prRef.ToString());
    }
}
