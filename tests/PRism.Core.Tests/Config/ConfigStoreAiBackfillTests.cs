using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public sealed class ConfigStoreAiBackfillTests
{
    [Fact]
    public async Task LegacyAiShape_WithoutConsentOrFeatures_BackfillsDefaults()
    {
        // ui.ai present with mode only (the post-PR2 on-disk shape)
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"),
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"off" },"density":"comfortable" } }""");
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.Consent.Should().NotBeNull();
        store.Current.Ui.Ai.Consent.DisclosureVersion.Should().BeNull();           // "no consent recorded"
        store.Current.Ui.Ai.Features.Enabled["summary"].Should().BeTrue();         // default all-on
        store.Current.Ui.Ai.Features.Enabled.Should().HaveCount(9);
    }

    [Fact]
    public async Task AiShape_WithConsentButNullFeatures_PreservesConsentAndBackfillsFeatures()
    {
        // consent is present on disk but features is absent — the independent-fill branch
        // (ConfigStore lines 296-303: ai.Consent ?? default, ai.Features ?? default)
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"),
            """
            {
              "ui": {
                "ai": {
                  "mode": "off",
                  "consent": {
                    "provider-id": "claude",
                    "disclosure-version": "1",
                    "acknowledged-at": "2026-01-01T00:00:00Z"
                  }
                }
              }
            }
            """);
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        // Consent round-trips intact
        store.Current.Ui.Ai.Consent.Should().NotBeNull();
        store.Current.Ui.Ai.Consent.ProviderId.Should().Be("claude");
        store.Current.Ui.Ai.Consent.DisclosureVersion.Should().Be("1");
        store.Current.Ui.Ai.Consent.AcknowledgedAt.Should().Be(DateTimeOffset.Parse("2026-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));

        // Features backfilled to all-on
        store.Current.Ui.Ai.Features.Should().NotBeNull();
        store.Current.Ui.Ai.Features.Enabled["summary"].Should().BeTrue();
        store.Current.Ui.Ai.Features.Enabled.Should().HaveCount(9);
    }
}
