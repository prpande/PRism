using System.Text.Json;
using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCliEnvelopeTests
{
    [Fact]
    public void Parses_result_text_and_usage_including_cache_read()
    {
        const string json = """
        {
          "result": "A concise summary.",
          "session_id": "abc-123",
          "total_cost_usd": 0.0042,
          "usage": { "input_tokens": 1200, "output_tokens": 90, "cache_read_input_tokens": 1024 }
        }
        """;

        var envelope = JsonSerializer.Deserialize<ClaudeCliEnvelope>(json, ClaudeCliEnvelope.Options);

        envelope.Should().NotBeNull();
        envelope!.Result.Should().Be("A concise summary.");
        envelope.TotalCostUsd.Should().Be(0.0042m);
        envelope.Usage!.InputTokens.Should().Be(1200);
        envelope.Usage.OutputTokens.Should().Be(90);
        envelope.Usage.CacheReadInputTokens.Should().Be(1024);
    }

    [Fact]
    public void Missing_usage_block_yields_null_usage_not_throw()
    {
        const string json = """{ "result": "x", "session_id": "s" }""";
        var envelope = JsonSerializer.Deserialize<ClaudeCliEnvelope>(json, ClaudeCliEnvelope.Options);
        envelope!.Usage.Should().BeNull();
    }
}
