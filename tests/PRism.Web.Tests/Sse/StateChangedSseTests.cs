using System.Reflection;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Json;

namespace PRism.Web.Tests.Sse;

// Spec § 4.5 wire-shape contract for the three new IReviewEvent records. The SSE
// projection (PRism.Web.Sse.SseEventProjection) is the single point where the
// PrReference object → "owner/repo/number" string conversion happens; this test
// pins each event type's wire payload so a future refactor can't silently change
// the JSON the SPA receives.
//
// SseEventProjection is internal to PRism.Web; reach it via reflection so tests
// don't force a public surface for a tightly scoped serialization helper.
public class StateChangedSseTests
{
    private static readonly Type ProjectionType =
        typeof(PRism.Web.Endpoints.PrDraftEndpoints).Assembly
            .GetType("PRism.Web.Sse.SseEventProjection")
            ?? throw new InvalidOperationException("SseEventProjection type not found");

    private static readonly MethodInfo ProjectMethod =
        ProjectionType.GetMethod("Project", BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException("SseEventProjection.Project method not found");

    private static readonly PrReference SamplePr = new("acme", "api", 123);

    private static (string EventName, string PayloadJson) Project(IReviewEvent evt)
    {
        var resultObj = ProjectMethod.Invoke(null, new object[] { evt })
            ?? throw new InvalidOperationException("Project returned null");
        var resultType = resultObj.GetType();
        var item1 = resultType.GetField("Item1", BindingFlags.Public | BindingFlags.Instance)?.GetValue(resultObj) as string
            ?? throw new InvalidOperationException("Item1 missing");
        var item2 = resultType.GetField("Item2", BindingFlags.Public | BindingFlags.Instance)?.GetValue(resultObj)
            ?? throw new InvalidOperationException("Item2 missing");
        var json = JsonSerializer.Serialize(item2, JsonSerializerOptionsFactory.Api);
        return (item1, json);
    }

    [Fact]
    public void StateChanged_projects_to_state_changed_with_string_pr_ref()
    {
        var evt = new StateChanged(SamplePr, new[] { "draft-comments", "draft-replies" }, SourceTabId: "tab-1");

        var (eventName, json) = Project(evt);

        eventName.Should().Be("state-changed");
        json.Should().Contain("\"prRef\":\"acme/api/123\"");
        json.Should().Contain("\"fieldsTouched\":[\"draft-comments\",\"draft-replies\"]");
        json.Should().Contain("\"sourceTabId\":\"tab-1\"");
    }

    [Fact]
    public void DraftSaved_projects_to_draft_saved_with_string_pr_ref()
    {
        var evt = new DraftSaved(SamplePr, DraftId: "draft-id-xyz", SourceTabId: "tab-2");

        var (eventName, json) = Project(evt);

        eventName.Should().Be("draft-saved");
        json.Should().Contain("\"prRef\":\"acme/api/123\"");
        json.Should().Contain("\"draftId\":\"draft-id-xyz\"");
        json.Should().Contain("\"sourceTabId\":\"tab-2\"");
    }

    [Fact]
    public void DraftDiscarded_projects_to_draft_discarded_with_string_pr_ref()
    {
        var evt = new DraftDiscarded(SamplePr, DraftId: "abc", SourceTabId: null);

        var (eventName, json) = Project(evt);

        eventName.Should().Be("draft-discarded");
        json.Should().Contain("\"prRef\":\"acme/api/123\"");
        json.Should().Contain("\"draftId\":\"abc\"");
        json.Should().Contain("\"sourceTabId\":null");
    }

    [Fact]
    public void ActivePrUpdated_projects_to_pr_updated_with_string_pr_ref()
    {
        var evt = new ActivePrUpdated(SamplePr, HeadShaChanged: true, CommentCountChanged: false,
            NewHeadSha: "abc123", CommentCountDelta: 0);

        var (eventName, json) = Project(evt);

        eventName.Should().Be("pr-updated");
        // prRef MUST be the string "owner/repo/number" — a nested object {owner,repo,number}
        // is the bug this test exists to catch: the frontend compares event.prRef against a
        // string, so an object-shaped prRef silently drops every pr-updated event.
        json.Should().Contain("\"prRef\":\"acme/api/123\"");
        json.Should().NotContain("\"prRef\":{");
        json.Should().Contain("\"headShaChanged\":true");
        json.Should().Contain("\"newHeadSha\":\"abc123\"");
        json.Should().Contain("\"commentCountDelta\":0");
    }

    [Fact]
    public void ActivePrUpdated_projects_comment_count_delta()
    {
        var evt = new ActivePrUpdated(SamplePr, HeadShaChanged: false, CommentCountChanged: true,
            NewHeadSha: null, CommentCountDelta: 2);

        var (_, json) = Project(evt);

        json.Should().Contain("\"commentCountDelta\":2");
    }

    [Fact]
    public void ActivePrUpdated_projects_close_state_bools_default_false()
    {
        // An open-PR event (no merge/close) carries both flags false on the wire so the
        // frontend's merged/closed banner stays dormant. Pins the camelCase property names
        // the SPA reads (isMerged / isClosed).
        var evt = new ActivePrUpdated(SamplePr, HeadShaChanged: true, CommentCountChanged: false,
            NewHeadSha: "abc123", CommentCountDelta: 0);

        var (_, json) = Project(evt);

        json.Should().Contain("\"isMerged\":false");
        json.Should().Contain("\"isClosed\":false");
    }

    [Fact]
    public void ActivePrUpdated_projects_isMerged_true_on_merge()
    {
        var evt = new ActivePrUpdated(SamplePr, HeadShaChanged: false, CommentCountChanged: false,
            NewHeadSha: null, CommentCountDelta: 0, IsMerged: true, IsClosed: false);

        var (_, json) = Project(evt);

        json.Should().Contain("\"isMerged\":true");
        json.Should().Contain("\"isClosed\":false");
    }

    [Fact]
    public void ActivePrUpdated_projects_isClosed_true_on_close()
    {
        var evt = new ActivePrUpdated(SamplePr, HeadShaChanged: false, CommentCountChanged: false,
            NewHeadSha: null, CommentCountDelta: 0, IsMerged: false, IsClosed: true);

        var (_, json) = Project(evt);

        json.Should().Contain("\"isClosed\":true");
        json.Should().Contain("\"isMerged\":false");
    }

    [Fact]
    public void Unhandled_event_type_throws()
    {
        // SingleCommentPostedBusEvent (#302 diff post-now) is intentionally NOT in the
        // projection switch — SseChannel does not subscribe to it. Calling Project on it must
        // throw the default-arm ArgumentOutOfRangeException so a future contributor adding a
        // new IReviewEvent type without updating the projection switch hears about it loudly.
        // (DraftSubmitted used to be the example here; #392 added its projection arm.)
        var evt = new SingleCommentPostedBusEvent(SamplePr, ReviewCommentId: 42L);

        var act = () => Project(evt);

        act.Should().Throw<TargetInvocationException>()
            .WithInnerException<ArgumentOutOfRangeException>();
    }
}
