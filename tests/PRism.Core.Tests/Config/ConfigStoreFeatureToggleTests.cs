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
