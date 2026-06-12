using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.Contracts.Observability;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class JsonlAiInteractionLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-ai-log-" + Guid.NewGuid().ToString("N"));

    private JsonlAiInteractionLog NewSink() =>
        new(_dir, TimeProvider.System, NullLogger<JsonlAiInteractionLog>.Instance);

    private string LogPath => Path.Combine(_dir, "ai-interactions.log");

    private static AiInteractionRecord Ok() => new(
        Component: "summary", ProviderId: "claude-code", Model: "claude-sonnet-4-6",
        PrRef: "o/r#1", HeadSha: "abc123", Outcome: AiInteractionOutcome.Ok, Egressed: true,
        LatencyMs: 4200, InputTokens: 100, OutputTokens: 20, CacheReadInputTokens: 0,
        EstimatedCostUsd: 0.01m, PromptChars: 5000, ResponseChars: 300);

    [Fact]
    public void Record_writes_one_camelCase_json_line_tagged_with_the_component()
    {
        NewSink().Record(Ok());

        var lines = File.ReadAllLines(LogPath);
        lines.Should().HaveCount(1);

        using var doc = JsonDocument.Parse(lines[0]);
        var root = doc.RootElement;
        root.GetProperty("component").GetString().Should().Be("summary");
        root.GetProperty("providerId").GetString().Should().Be("claude-code");
        root.GetProperty("outcome").GetString().Should().Be("ok"); // enum → camelCase string
        root.GetProperty("egressed").GetBoolean().Should().BeTrue();
        root.GetProperty("inputTokens").GetInt64().Should().Be(100);
        root.GetProperty("timestamp").GetString().Should().NotBeNullOrWhiteSpace();
        // Metadata only: no prompt/response content fields are ever serialized.
        root.TryGetProperty("body", out _).Should().BeFalse();
        root.TryGetProperty("prompt", out _).Should().BeFalse();
        root.TryGetProperty("diff", out _).Should().BeFalse();
    }

    [Fact]
    public void Record_appends_one_line_per_call()
    {
        var sink = NewSink();
        sink.Record(Ok());
        sink.Record(Ok() with { Outcome = AiInteractionOutcome.CacheHit, Egressed = false, LatencyMs = null });

        var lines = File.ReadAllLines(LogPath);
        lines.Should().HaveCount(2);
        using var second = JsonDocument.Parse(lines[1]);
        second.RootElement.GetProperty("outcome").GetString().Should().Be("cacheHit");
        // Null fields are omitted (WhenWritingNull): a cache hit has no latency.
        second.RootElement.TryGetProperty("latencyMs", out _).Should().BeFalse();
    }

    [Fact]
    public void Record_is_non_fatal_when_the_target_path_is_unwritable()
    {
        // Point the sink at a directory path that collides with an existing FILE, so the
        // Directory.CreateDirectory / append fails. Record must swallow, not throw.
        var fileWhereDirExpected = Path.Combine(_dir, "occupied");
        Directory.CreateDirectory(_dir);
        File.WriteAllText(fileWhereDirExpected, "x");
        var sink = new JsonlAiInteractionLog(
            Path.Combine(fileWhereDirExpected, "logs"), TimeProvider.System,
            NullLogger<JsonlAiInteractionLog>.Instance);

        var act = () => sink.Record(Ok());
        act.Should().NotThrow();
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
    }
}
