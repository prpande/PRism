using System.Reflection;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Events;
using PRism.Core.Json;
using Xunit;

namespace PRism.Web.Tests.Sse;

// S6 PR2 Task 2.5 — wire-shape contract for the global identity-change broadcast.
// Mirrors the reflection-based pattern from StateChangedSseTests because
// SseEventProjection is `internal static` (visible via InternalsVisibleTo to
// PRism.Web.Tests, but reflection keeps the test independent of any future
// internal-keyword refactor).
//
// Spec § 3.2.1 wire-shape contract: NO login strings on the wire. Login fields
// stay server-side in the structured-log forensic record emitted by
// LogIdentityChanged (spec § 3.6).
public class SseEventProjectionIdentityChangedTests
{
    private static readonly Type ProjectionType =
        typeof(PRism.Web.Endpoints.PrDraftEndpoints).Assembly
            .GetType("PRism.Web.Sse.SseEventProjection")
            ?? throw new InvalidOperationException("SseEventProjection type not found");

    private static readonly MethodInfo ProjectMethod =
        ProjectionType.GetMethod("Project", BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException("SseEventProjection.Project method not found");

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
    public void IdentityChanged_projects_to_identity_changed_with_minimal_wire_payload()
    {
        var evt = new IdentityChanged("default", "alice", "bob");

        var (eventName, json) = Project(evt);

        eventName.Should().Be("identity-changed");
        json.Should().Contain("\"type\":\"identity-change\"");
    }

    [Fact]
    public void IdentityChanged_wire_payload_never_carries_login_strings()
    {
        var evt = new IdentityChanged("default", "alice", "bob");

        var (_, json) = Project(evt);

        // Spec § 3.2.1: login fields stay server-side, never on the wire.
        json.Should().NotContain("alice");
        json.Should().NotContain("bob");
        json.Should().NotContain("priorLogin");
        json.Should().NotContain("newLogin");
        json.Should().NotContain("accountKey");
    }
}
