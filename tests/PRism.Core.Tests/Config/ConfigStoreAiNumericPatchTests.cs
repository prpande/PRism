using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public sealed class ConfigStoreAiNumericPatchTests
{
    private static async Task<ConfigStore> NewStoreAsync(TempDataDir dir)
    {
        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);
        return store;
    }

    [Fact]
    public async Task Patch_provider_timeout_in_range_persists_value()
    {
        using var dir = new TempDataDir();
        using var store = await NewStoreAsync(dir);
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 300 }, default);
        store.Current.Ui.Ai.ProviderTimeoutSeconds.Should().Be(300);
    }

    [Fact]
    public async Task Patch_provider_timeout_above_max_clamps_to_600()
    {
        using var dir = new TempDataDir();
        using var store = await NewStoreAsync(dir);
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 5000 }, default);
        store.Current.Ui.Ai.ProviderTimeoutSeconds.Should().Be(600);
    }

    [Fact]
    public async Task Patch_provider_timeout_below_min_clamps_to_30()
    {
        using var dir = new TempDataDir();
        using var store = await NewStoreAsync(dir);
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 1 }, default);
        store.Current.Ui.Ai.ProviderTimeoutSeconds.Should().Be(30);
    }

    [Fact]
    public async Task Patch_cap_in_range_persists_value()
    {
        using var dir = new TempDataDir();
        using var store = await NewStoreAsync(dir);
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.hunkAnnotationCap"] = 20 }, default);
        store.Current.Ui.Ai.HunkAnnotationCap.Should().Be(20);
    }

    [Fact]
    public async Task Patch_cap_above_max_clamps_to_50()
    {
        using var dir = new TempDataDir();
        using var store = await NewStoreAsync(dir);
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.hunkAnnotationCap"] = 999 }, default);
        store.Current.Ui.Ai.HunkAnnotationCap.Should().Be(50);
    }

    [Fact]
    public async Task Patch_numeric_key_with_non_integer_value_throws()
    {
        using var dir = new TempDataDir();
        using var store = await NewStoreAsync(dir);
        var act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = null }, default);
        await act.Should().ThrowAsync<ConfigPatchException>()
            .WithMessage("*expects an integer*");
    }

    // #525 — summary character cap (same plumbing as the two #496 knobs).
    [Fact]
    public async Task Patch_summary_max_chars_in_range_persists_value()
    {
        using var dir = new TempDataDir();
        using var store = await NewStoreAsync(dir);
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.summaryMaxChars"] = 2000 }, default);
        store.Current.Ui.Ai.SummaryMaxChars.Should().Be(2000);
    }

    [Fact]
    public async Task Patch_summary_max_chars_above_max_clamps_to_5000()
    {
        using var dir = new TempDataDir();
        using var store = await NewStoreAsync(dir);
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.summaryMaxChars"] = 99999 }, default);
        store.Current.Ui.Ai.SummaryMaxChars.Should().Be(5000);
    }

    [Fact]
    public async Task Patch_summary_max_chars_below_min_clamps_to_500()
    {
        using var dir = new TempDataDir();
        using var store = await NewStoreAsync(dir);
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.summaryMaxChars"] = 10 }, default);
        store.Current.Ui.Ai.SummaryMaxChars.Should().Be(500);
    }

    [Fact]
    public void Default_config_has_summary_max_chars_of_1000()
    {
        AppConfig.Default.Ui.Ai.SummaryMaxChars.Should().Be(1000);
    }

    [Fact]
    public async Task Missing_summary_max_chars_key_binds_to_the_constructor_default()
    {
        // Pre-existing config written before the key existed: ui.ai present without summary-max-chars.
        // STJ on net10 honors the constructor default for a missing key (project memory #439); the
        // read-clamp additionally floors a non-positive value to the default at display/read time.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"),
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"off" } } }""");
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.SummaryMaxChars.Should().Be(1000);
    }
}
