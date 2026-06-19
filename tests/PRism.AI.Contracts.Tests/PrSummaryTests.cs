using System.Text.Json;
using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using Xunit;

namespace PRism.AI.Contracts.Tests;

// #525 — PrSummary carries the generation-time summary cap so the card can detect a summary that
// was generated under a now-changed cap. The field is additive + nullable so legacy/absent payloads
// (and the ~existing construction sites that omit it) stay valid.
public sealed class PrSummaryTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    [Fact]
    public void GeneratedMaxChars_serializes_camelCase_when_present()
    {
        var json = JsonSerializer.Serialize(new PrSummary("body", "fix", 1000), Web);
        json.Should().Contain("\"generatedMaxChars\":1000");
    }

    [Fact]
    public void GeneratedMaxChars_round_trips()
    {
        var json = JsonSerializer.Serialize(new PrSummary("body", "fix", 750), Web);
        var back = JsonSerializer.Deserialize<PrSummary>(json, Web)!;
        back.Body.Should().Be("body");
        back.Category.Should().Be("fix");
        back.GeneratedMaxChars.Should().Be(750);
    }

    [Fact]
    public void Legacy_payload_without_the_field_deserializes_to_null()
    {
        var back = JsonSerializer.Deserialize<PrSummary>("""{ "body":"b","category":"c" }""", Web)!;
        back.GeneratedMaxChars.Should().BeNull("an absent cap is never treated as stale (#525 D6)");
    }

    [Fact]
    public void Default_construction_leaves_the_cap_null()
    {
        new PrSummary("b", "c").GeneratedMaxChars.Should().BeNull();
    }
}
