using System.Text.Json;
using PRism.Core.Json;
using PRism.Core.Submit;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

// Pins the SubmitEvent wire form (#318). SubmitEvent is the enum the submit pipeline actually
// uses; it had no wire-format test before the dead Core.Contracts/Verdict enum was deleted.
public class SubmitEventSerializationTests
{
    [Theory]
    [InlineData(SubmitEvent.Approve, "\"approve\"")]
    [InlineData(SubmitEvent.RequestChanges, "\"request-changes\"")]
    [InlineData(SubmitEvent.Comment, "\"comment\"")]
    public void SubmitEvent_serializes_kebab_case(SubmitEvent v, string expected)
    {
        var json = JsonSerializer.Serialize(v, JsonSerializerOptionsFactory.Storage);
        json.Should().Be(expected);
    }

    [Theory]
    [InlineData("\"approve\"", SubmitEvent.Approve)]
    [InlineData("\"request-changes\"", SubmitEvent.RequestChanges)]
    [InlineData("\"comment\"", SubmitEvent.Comment)]
    public void SubmitEvent_round_trips_from_kebab_case(string json, SubmitEvent expected)
    {
        var v = JsonSerializer.Deserialize<SubmitEvent>(json, JsonSerializerOptionsFactory.Storage);
        v.Should().Be(expected);
    }
}
