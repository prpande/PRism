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
    public void Unhandled_event_type_throws()
    {
        // ActivePrUpdated is intentionally NOT in the projection switch — it ships its own
        // wire shape inline in OnActivePrUpdated (full record JSON, not "owner/repo/number"
        // string). Calling Project on it should throw the default-arm ArgumentOutOfRangeException
        // so a future contributor adding a new IReviewEvent type without updating the
        // projection switch hears about it loudly.
        var evt = new ActivePrUpdated(SamplePr, true, false, "headSha", null);

        var act = () => Project(evt);

        act.Should().Throw<TargetInvocationException>()
            .WithInnerException<ArgumentOutOfRangeException>();
    }
}
