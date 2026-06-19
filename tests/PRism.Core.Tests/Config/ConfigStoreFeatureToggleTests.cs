using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreFeatureToggleTests
{
    [Fact]
    public async Task Patch_summary_feature_off_updates_config()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.features.summary"] = false }, CancellationToken.None);

        store.Current.Ui.Ai.Features.Enabled["summary"].Should().BeFalse();
        store.Current.Ui.Ai.Features.Enabled["fileFocus"].Should().BeTrue();
    }

    [Theory]
    [InlineData("summary")]
    [InlineData("fileFocus")]
    [InlineData("hunkAnnotations")]
    [InlineData("inboxEnrichment")]
    public async Task Patch_settable_feature_flips_only_that_seam(string seam)
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(new Dictionary<string, object?> { [$"ui.ai.features.{seam}"] = false }, CancellationToken.None);

        var enabled = store.Current.Ui.Ai.Features.Enabled;
        enabled[seam].Should().BeFalse();
        foreach (var other in new[] { "summary", "fileFocus", "hunkAnnotations", "inboxEnrichment" })
            if (other != seam) enabled[other].Should().BeTrue($"{other} must stay on when only {seam} is toggled");
    }

    [Fact]
    public async Task Patch_unsettable_feature_key_is_rejected()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        var act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["ui.ai.features.inboxRanking"] = false }, CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>();
    }
}
