using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public sealed class ConfigStoreHunkAnnotationCapTests
{
    [Fact]
    public void Default_config_has_hunk_annotation_cap_of_ten()
    {
        AppConfig.Default.Ui.Ai.HunkAnnotationCap.Should().Be(10);
    }

    [Fact]
    public async Task Custom_cap_round_trips_from_disk()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"),
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"live","hunk-annotation-cap": 25 } } }""");
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.HunkAnnotationCap.Should().Be(25);
    }

    [Fact]
    public async Task Missing_cap_key_binds_to_the_constructor_default()
    {
        // A pre-existing config written before the key existed: ui.ai present with mode only.
        // STJ on net10 honors the constructor's default-value parameter for a missing key
        // (see project memory #439). The annotator additionally clamps cap <= 0 → 10 at read
        // time (Task 3), so this binding is belt-and-suspenders either way.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"),
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"off" } } }""");
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.HunkAnnotationCap.Should().Be(10);
    }
}
