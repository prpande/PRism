// tests/PRism.Core.Tests/Config/AiModeMigrationTests.cs
using System.Threading;
using FluentAssertions;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public sealed class AiModeMigrationTests
{
    [Fact]
    public async Task InitAsync_migrates_legacy_ai_preview_true_to_preview_mode()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "ui": { "theme": "light", "accent": "indigo", "ai-preview": true } }
        """, CancellationToken.None);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.Mode.Should().Be(AiMode.Preview);

        var rewritten = await File.ReadAllTextAsync(Path.Combine(dir.Path, "config.json"), CancellationToken.None);
        rewritten.Should().Contain("\"ai\"").And.Contain("\"mode\"");
        rewritten.Should().NotContain("ai-preview");
    }

    [Fact]
    public async Task InitAsync_migrates_legacy_ai_preview_false_to_off_mode()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "ui": { "theme": "light", "accent": "indigo", "ai-preview": false } }
        """, CancellationToken.None);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.Mode.Should().Be(AiMode.Off);
    }

    [Fact]
    public async Task InitAsync_does_not_crash_when_legacy_ai_preview_is_non_bool()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "ui": { "theme": "light", "accent": "indigo", "ai-preview": "yes-please" } }
        """, CancellationToken.None);

        using var store = new ConfigStore(dir.Path);
        var act = async () => await store.InitAsync(CancellationToken.None);

        await act.Should().NotThrowAsync();
        store.Current.Ui.Ai.Mode.Should().Be(AiMode.Off); // falls back to Default
    }

    [Fact]
    public async Task InitAsync_migrates_legacy_ai_preview_true_even_when_ai_object_is_empty()
    {
        // Empty `ai` object ({}) must NOT short-circuit the migration: the legacy
        // ai-preview:true intent would otherwise be silently discarded. The rewrite
        // rebuilds `ai` from the legacy bool. (ce-doc-review rounds 1+2 edge case.)
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "ui": { "ai-preview": true, "ai": {} } }
        """, CancellationToken.None);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.Mode.Should().Be(AiMode.Preview);
    }

    [Fact]
    public async Task InitAsync_preserves_existing_ai_mode_when_already_migrated()
    {
        // A config that already has a real ui.ai.mode AND a stale ai-preview key (a half-migrated
        // file) must keep the existing mode — the stale legacy bool must NOT overwrite it. A user
        // who set Live via a config-file edit must not be silently downgraded by ai-preview:false.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "ui": { "ai-preview": false, "ai": { "mode": "live" } } }
        """, CancellationToken.None);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.Mode.Should().Be(AiMode.Live); // existing mode preserved, NOT downgraded

        var rewritten = await File.ReadAllTextAsync(Path.Combine(dir.Path, "config.json"), CancellationToken.None);
        rewritten.Should().NotContain("ai-preview"); // stale legacy key still dropped
    }

    [Fact]
    public async Task InitAsync_rebuilds_ai_from_legacy_bool_when_ai_value_is_malformed()
    {
        // A corrupt non-object `ai` value (here a JSON string) must NOT block the migration: the
        // rewrite falls through and rebuilds `ai` from the legacy bool, so a corrupt value cannot
        // discard the user's ai-preview intent.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "ui": { "ai-preview": true, "ai": "garbage" } }
        """, CancellationToken.None);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.Mode.Should().Be(AiMode.Preview);
    }
}
