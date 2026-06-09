using System.IO;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using PRism.Core.Ai;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public sealed class ConfigStoreAiBackfillTests
{
    private static string WriteTemp(string json)
    {
        var dir = Path.Combine(Path.GetTempPath(), "prism-cfg-" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "config.json"), json);
        return dir;
    }

    [Fact]
    public async Task LegacyAiShape_WithoutConsentOrFeatures_BackfillsDefaults()
    {
        // ui.ai present with mode only (the post-PR2 on-disk shape)
        var dir = WriteTemp("""{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"off" },"density":"comfortable" } }""");
        var store = new ConfigStore(dir);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.Consent.Should().NotBeNull();
        store.Current.Ui.Ai.Consent.DisclosureVersion.Should().BeNull();           // "no consent recorded"
        store.Current.Ui.Ai.Features.Enabled["summary"].Should().BeTrue();         // default all-on
        store.Current.Ui.Ai.Features.Enabled.Should().HaveCount(9);
    }
}
