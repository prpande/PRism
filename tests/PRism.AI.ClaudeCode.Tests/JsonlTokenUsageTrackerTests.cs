using System.Text.Json;
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class JsonlTokenUsageTrackerTests : IDisposable
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-usage-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Appends_one_json_line_per_record()
    {
        using var tracker = new JsonlTokenUsageTracker(_dir);
        await tracker.RecordAsync(new TokenUsageRecord("summary", "claude-code", 100, 20, 80, 4096, 0.5m, IsRetry: false), default);
        await tracker.RecordAsync(new TokenUsageRecord("summary", "claude-code", 50, 10, 0, 0, 0.2m, IsRetry: true), default);

        var lines = await File.ReadAllLinesAsync(Path.Combine(_dir, "token-usage.jsonl"));
        lines.Should().HaveCount(2);

        var first = JsonSerializer.Deserialize<TokenUsageRecord>(lines[0], Web);
        first!.Feature.Should().Be("summary");
        first.CacheReadInputTokens.Should().Be(80);
        // #379: cache-creation tokens must round-trip — they hold the bulk of cold-call input volume.
        first.CacheCreationInputTokens.Should().Be(4096);
        first.IsRetry.Should().BeFalse();
        first.RecordedAt.Should().BeCloseTo(DateTimeOffset.UtcNow, TimeSpan.FromMinutes(5));
    }

    [Fact]
    public async Task Never_writes_environment_variable_values()
    {
        using var tracker = new JsonlTokenUsageTracker(_dir);
        await tracker.RecordAsync(new TokenUsageRecord("summary", "claude-code", 1, 1, 0, 0, 0m, false), default);
        var content = await File.ReadAllTextAsync(Path.Combine(_dir, "token-usage.jsonl"));
        content.Should().NotContain("ANTHROPIC_");
        content.Should().NotContain("apiKey");
    }

    [SkippableFact]
    public async Task Usage_dir_is_owner_only_on_posix()
    {
        Skip.If(OperatingSystem.IsWindows(), "POSIX-only: Windows relies on the per-user dataDir ACL, not Unix mode bits.");
        using var tracker = new JsonlTokenUsageTracker(_dir);
        await tracker.RecordAsync(new TokenUsageRecord("summary", "claude-code", 1, 1, 0, 0, 0m, false), default);

#pragma warning disable CA1416 // Guarded by Skip.If(IsWindows) above — this assertion only runs on POSIX.
        var mode = File.GetUnixFileMode(_dir);
#pragma warning restore CA1416
        var groupOrOther = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute
                         | UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
        (mode & groupOrOther).Should().Be(UnixFileMode.None);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }
}
