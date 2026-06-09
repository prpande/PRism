using System.Text.Json;
using PRism.Core.Config;
using PRism.Core.Json;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreTests
{
    [Fact]
    public async Task LoadAsync_creates_defaults_when_file_missing()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("system");
        store.Current.Ui.Accent.Should().Be("indigo");
        store.Current.Ui.AiPreview.Should().BeTrue();   // #283 AI preview ON by default for fresh installs
        store.Current.Inbox.ShowActivityRail.Should().BeFalse(); // #283 rail decoupled from AI, default OFF
        store.Current.Github.Host.Should().Be("https://github.com");
        File.Exists(Path.Combine(dir.Path, "config.json")).Should().BeTrue();
    }

    [Fact]
    public async Task LoadAsync_with_malformed_json_falls_back_to_defaults_without_overwrite()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        var bad = "{ broken";
        await File.WriteAllTextAsync(path, bad);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("system");
        (await File.ReadAllTextAsync(path)).Should().Be(bad);            // file preserved
        store.LastLoadError.Should().NotBeNull();
    }

    [Fact]
    public async Task PatchAsync_with_single_field_succeeds_and_persists()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("dark");
        using var roundTrip = new ConfigStore(dir.Path);
        await roundTrip.InitAsync(CancellationToken.None);
        roundTrip.Current.Ui.Theme.Should().Be("dark");
    }

    [Fact]
    public async Task PatchAsync_with_multi_field_throws()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark", ["accent"] = "amber" },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains("exactly one"));
    }

    [Fact]
    public async Task PatchAsync_with_unknown_field_throws()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["unknown"] = "x" },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains("unknown"));
    }

    [Fact]
    public async Task External_edit_triggers_reload_within_polling_window()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        var original = await File.ReadAllTextAsync(path);
        var modified = original.Replace("\"theme\":\"system\"", "\"theme\":\"dark\"", StringComparison.Ordinal);
        await File.WriteAllTextAsync(path, modified);

        // FileSystemWatcher debounce + reload happens; allow up to 2s
        for (var i = 0; i < 20 && store.Current.Ui.Theme != "dark"; i++)
            await Task.Delay(100);

        store.Current.Ui.Theme.Should().Be("dark");
    }

    [Fact]
    public async Task Default_inbox_config_has_dedupe_on_all_sections_visible_footer_on()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Inbox.Deduplicate.Should().BeTrue();
        store.Current.Inbox.ShowHiddenScopeFooter.Should().BeTrue();
        store.Current.Inbox.Sections.ReviewRequested.Should().BeTrue();
        store.Current.Inbox.Sections.AwaitingAuthor.Should().BeTrue();
        store.Current.Inbox.Sections.AuthoredByMe.Should().BeTrue();
        store.Current.Inbox.Sections.Mentioned.Should().BeTrue();
    }

    [Fact]
    public async Task LoadAsync_with_pre_phase2_config_fills_new_fields_from_defaults()
    {
        using var dir = new TempDataDir();
        // Legacy config.json shape from S0+S1 — has show-hidden-scope-footer but
        // no deduplicate or sections keys. Wire format is kebab-case (matches Storage policy).
        var legacyJson = """
            {
              "polling": { "active-pr-seconds": 30, "inbox-seconds": 120 },
              "inbox": { "show-hidden-scope-footer": true },
              "review": { "block-submit-on-stale-drafts": true, "require-verdict-reconfirm-on-new-iteration": true },
              "iterations": { "cluster-gap-seconds": 60 },
              "logging": { "level": "info", "state-events": true, "state-events-retention-files": 30 },
              "ui": { "theme": "system", "accent": "indigo", "ai-preview": false },
              "github": { "host": "https://github.com", "local-workspace": null },
              "llm": {}
            }
            """;
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), legacyJson);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Inbox.ShowHiddenScopeFooter.Should().BeTrue(); // preserved from legacy file
        store.Current.Inbox.Deduplicate.Should().BeTrue();           // filled from default
        store.Current.Inbox.Sections.Should().NotBeNull();
        store.Current.Inbox.Sections.ReviewRequested.Should().BeTrue();
        store.Current.Inbox.Sections.AwaitingAuthor.Should().BeTrue();
        store.Current.Inbox.Sections.AuthoredByMe.Should().BeTrue();
        store.Current.Inbox.Sections.Mentioned.Should().BeTrue();
    }

    [Fact]
    public async Task LoadAsync_with_partial_config_fills_all_missing_sub_records_from_defaults()
    {
        using var dir = new TempDataDir();
        // Only github.host is provided; every other sub-record must come from defaults.
        var partialJson = """
            { "github": { "host": "https://ghe.acme.com" } }
            """;
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), partialJson);

        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Github.Host.Should().Be("https://ghe.acme.com"); // user value preserved
        store.Current.Ui.Should().NotBeNull();
        // #283: a legacy `ui`-less config inherits AppConfig.Default.Ui, whose AiPreview is
        // now true. This is the accepted "ui-section-absent flips ON" edge documented in the
        // spec — such a config predates the ui section and never carried an AI value to preserve.
        store.Current.Ui.AiPreview.Should().BeTrue();               // from default (now ON)
        store.Current.Polling.Should().NotBeNull();
        store.Current.Polling.InboxSeconds.Should().Be(120);        // from default
        store.Current.Review.Should().NotBeNull();
        store.Current.Iterations.Should().NotBeNull();
        store.Current.Logging.Should().NotBeNull();
        store.Current.Llm.Should().NotBeNull();
        store.Current.Inbox.Should().NotBeNull();
        store.Current.Inbox.Deduplicate.Should().BeTrue();
        store.Current.Inbox.Sections.ReviewRequested.Should().BeTrue();
    }

    // #283 AC #1: an EXISTING config that carries ui.aiPreview = false is preserved on load
    // (the new default-on does NOT overwrite a value physically present on disk).
    [Fact]
    public async Task LoadAsync_preserves_existing_aiPreview_false()
    {
        using var dir = new TempDataDir();
        // Keys are kebab-case to match JsonSerializerOptionsFactory.Storage's
        // KebabCaseJsonNamingPolicy (PropertyNameCaseInsensitive = false). A camelCase
        // "aiPreview" key would be unrecognized → AiPreview falls back to default(false) and
        // the test would pass VACUOUSLY (proving "unknown key → false", not preservation).
        // Caught by claude[bot] on PR #309.
        var json = """
            { "ui": { "theme": "system", "accent": "indigo", "ai-preview": false, "density": "comfortable", "content-scale": "m" } }
            """;
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), json);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.AiPreview.Should().BeFalse(); // saved value wins over the new default
    }

    // #283: a config whose `ui` section is present but lacks the `aiPreview` key deserializes
    // the non-nullable bool to default(false) — it stays OFF, NOT the new default-on. Documents
    // the precise preservation boundary (key-present vs ui-section-present-but-key-absent).
    [Fact]
    public async Task LoadAsync_with_ui_present_but_aiPreview_key_absent_is_off()
    {
        using var dir = new TempDataDir();
        var json = """
            { "ui": { "theme": "dark", "accent": "amber" } }
            """;
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), json);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("dark");          // ui section honored
        store.Current.Ui.AiPreview.Should().BeFalse();       // missing key → default(bool), not new default-on
    }

    [Fact]
    public void AppConfig_roundtrips_expanded_inbox_config_via_json()
    {
        var config = AppConfig.Default;
        var json = JsonSerializer.Serialize(config, JsonSerializerOptionsFactory.Storage);
        var parsed = JsonSerializer.Deserialize<AppConfig>(json, JsonSerializerOptionsFactory.Storage);

        parsed.Should().NotBeNull();
        parsed!.Inbox.Deduplicate.Should().BeTrue();
        parsed.Inbox.ShowHiddenScopeFooter.Should().BeTrue();
        parsed.Inbox.Sections.ReviewRequested.Should().BeTrue();
        parsed.Inbox.Sections.AwaitingAuthor.Should().BeTrue();
        parsed.Inbox.Sections.AuthoredByMe.Should().BeTrue();
        parsed.Inbox.Sections.Mentioned.Should().BeTrue();
        parsed.Inbox.ShowActivityRail.Should().BeFalse(); // #283 survives the JSON round-trip, default off
    }
}
