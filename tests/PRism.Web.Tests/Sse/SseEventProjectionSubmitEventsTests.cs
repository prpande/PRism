using System.Text.Json;

using FluentAssertions;

using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Json;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Sse;

namespace PRism.Web.Tests.Sse;

// Spec § 7.4 / § 7.5 wire-shape contract for the five submit-* SSE events. Counts + IDs the
// dialog UX needs; never thread/reply bodies, never the orphan review id, never pendingReviewId
// (threat-model defense — the per-PR subscription is broader-than-spec). step / status use the
// C# enum names (PascalCase) per spec § 18.2.
public class SseEventProjectionSubmitEventsTests
{
    private static readonly PrReference Pr = new("o", "r", 1);

    private static (string Name, string Json) Project(IReviewEvent evt)
    {
        var (name, payload) = SseEventProjection.Project(evt);
        return (name, JsonSerializer.Serialize(payload, JsonSerializerOptionsFactory.Api));
    }

    [Fact]
    public void SubmitProgress_projects_to_submit_progress_with_pascal_case_step_and_status()
    {
        var evt = new SubmitProgressBusEvent(Pr, SubmitStep.AttachThreads, SubmitStepStatus.Started, 0, 5, ErrorMessage: null);

        var (name, json) = Project(evt);

        name.Should().Be("submit-progress");
        json.Should().Contain("\"prRef\":\"o/r/1\"");
        json.Should().Contain("\"step\":\"AttachThreads\"");
        json.Should().Contain("\"status\":\"Started\"");
        json.Should().Contain("\"done\":0");
        json.Should().Contain("\"total\":5");
        json.Should().Contain("\"errorMessage\":null");
    }

    [Fact]
    public void SubmitProgress_failed_carries_error_message()
    {
        var evt = new SubmitProgressBusEvent(Pr, SubmitStep.Finalize, SubmitStepStatus.Failed, 3, 3, ErrorMessage: "boom");

        var (name, json) = Project(evt);

        name.Should().Be("submit-progress");
        json.Should().Contain("\"status\":\"Failed\"");
        json.Should().Contain("\"errorMessage\":\"boom\"");
    }

    [Fact]
    public void SubmitForeignPendingReview_projects_counts_only_no_bodies()
    {
        var evt = new SubmitForeignPendingReviewBusEvent(
            Pr, "PRR_x", "abc1234", new DateTimeOffset(2026, 5, 11, 10, 0, 0, TimeSpan.Zero), ThreadCount: 3, ReplyCount: 2);

        var (name, json) = Project(evt);

        name.Should().Be("submit-foreign-pending-review");
        json.Should().Contain("\"prRef\":\"o/r/1\"");
        json.Should().Contain("\"pullRequestReviewId\":\"PRR_x\"");
        json.Should().Contain("\"commitOid\":\"abc1234\"");
        json.Should().Contain("\"threadCount\":3");
        json.Should().Contain("\"replyCount\":2");
        // Round-trip the ISO-8601 string back through the serializer so the escaping (the
        // serializer escapes '+' as +) is irrelevant to the assertion.
        json.Should().Contain("\"createdAt\":\"2026-05-11T10:00:00.0000000");
        // No thread / reply bodies in the SSE payload.
        json.Should().NotContain("\"threads\"");
        json.Should().NotContain("\"body\"");
    }

    [Fact]
    public void SubmitStaleCommitOid_omits_orphan_review_id()
    {
        var evt = new SubmitStaleCommitOidBusEvent(Pr, OrphanCommitOid: "stale_abc");

        var (name, json) = Project(evt);

        name.Should().Be("submit-stale-commit-oid");
        json.Should().Contain("\"prRef\":\"o/r/1\"");
        json.Should().Contain("\"orphanCommitOid\":\"stale_abc\"");
        json.Should().NotContain("orphanReviewId");
        json.Should().NotContain("pendingReviewId");
    }

    [Fact]
    public void SubmitOrphanCleanupFailed_omits_pending_review_id()
    {
        var evt = new SubmitOrphanCleanupFailedBusEvent(Pr);

        var (name, json) = Project(evt);

        name.Should().Be("submit-orphan-cleanup-failed");
        json.Should().Contain("\"prRef\":\"o/r/1\"");
        json.Should().NotContain("pendingReviewId");
    }

    [Fact]
    public void SubmitDuplicateMarkerDetected_carries_draft_id_not_thread_ids()
    {
        var evt = new SubmitDuplicateMarkerDetectedBusEvent(Pr, DraftId: "d1");

        var (name, json) = Project(evt);

        name.Should().Be("submit-duplicate-marker-detected");
        json.Should().Contain("\"prRef\":\"o/r/1\"");
        json.Should().Contain("\"draftId\":\"d1\"");
        json.Should().NotContain("threadId");
    }
}
