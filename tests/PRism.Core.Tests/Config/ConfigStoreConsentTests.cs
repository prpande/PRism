using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public sealed class ConfigStoreConsentTests
{
    [Fact]
    public async Task RecordAiConsent_PersistsProviderAndVersion()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.RecordAiConsentAsync("claude-code", "1", CancellationToken.None);

        store.Current.Ui.Ai.Consent.ProviderId.Should().Be("claude-code");
        store.Current.Ui.Ai.Consent.DisclosureVersion.Should().Be("1");
        store.Current.Ui.Ai.Consent.AcknowledgedAt.Should().NotBeNull();
    }

    [Fact]
    public async Task RecordAiConsent_RacingThemePatch_LosesNeither()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await Task.WhenAll(
            store.RecordAiConsentAsync("claude-code", "1", CancellationToken.None),
            store.PatchAsync(new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None));

        store.Current.Ui.Ai.Consent.DisclosureVersion.Should().Be("1");
        store.Current.Ui.Theme.Should().Be("dark");
    }
}
