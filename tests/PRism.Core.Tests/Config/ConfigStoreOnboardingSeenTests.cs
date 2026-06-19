using System.IO;
using System.Threading;
using FluentAssertions;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreOnboardingSeenTests
{
    private static async Task<ConfigStore> LoadAsync(string json)
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), json);
        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);
        // Safe to delete the temp dir now: InitAsync has materialized Current in memory, and
        // ConfigStore.Dispose only tears down the watcher/gate (no disk write on dispose).
        return store;
    }

    [Fact]
    public async Task KeyAbsent_modePreview_backfillsFalse()
    {
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"preview" },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
    }

    [Fact]
    public async Task KeyAbsent_modeOff_backfillsTrue()
    {
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"off" },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(true);
    }

    [Fact]
    public async Task KeyAbsent_consentRecordedCurrentVersion_backfillsTrue()
    {
        // On-disk casing is kebab-case (KebabCaseJsonNamingPolicy / JsonSerializerOptionsFactory.Storage).
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"live","consent": { "provider-id":"claude-code","disclosure-version":"1","acknowledged-at":"2026-01-01T00:00:00+00:00" } },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(true);
    }

    [Fact]
    public async Task KeyAbsent_modeLive_withoutValidConsent_backfillsFalse()
    {
        // Security correction: mode=live but no consent record → show the dialog (do NOT suppress).
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"live" },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
    }

    [Fact]
    public async Task KeyAbsent_modeLive_staleConsentVersion_backfillsFalse()
    {
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"live","consent": { "provider-id":"claude-code","disclosure-version":"0","acknowledged-at":"2026-01-01T00:00:00+00:00" } },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
    }

    [Fact]
    public async Task KeyPresentFalse_isLeftUntouched_noRecompute()
    {
        // mode=off would backfill TRUE, but the explicit stored false must win (no recompute once present).
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"off","onboarding-seen":false },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
    }

    [Fact]
    public async Task KeyPresentTrue_isLeftUntouched()
    {
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"preview","onboarding-seen":true },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(true);
    }

    // Bidirectional consent-conflation guard helpers and tests.
    private static AiConsentState Gate(AiConsentConfig consent)
    {
        var s = new AiConsentState();
        s.Set(consent);
        return s;
    }

    [Fact]
    public async Task OnboardingSeen_false_doesNotGateLiveOff_whenConsented()
    {
        // On-disk casing is kebab-case.
        var json = """{ "ui": { "ai": { "mode":"live","consent": { "provider-id":"claude-code","disclosure-version":"1","acknowledged-at":"2026-01-01T00:00:00+00:00" },"onboarding-seen":false } } }""";
        using var store = await LoadAsync(json);
        Gate(store.Current.Ui.Ai.Consent).IsConsented("claude-code", "1").Should().BeTrue();
    }

    [Fact]
    public async Task OnboardingSeen_true_doesNotGateLiveOn_whenNotConsented()
    {
        // The critical inverse: a UX flag of true with NO consent record must never enable egress.
        var json = """{ "ui": { "ai": { "mode":"live","onboarding-seen":true } } }""";
        using var store = await LoadAsync(json);
        Gate(store.Current.Ui.Ai.Consent).IsConsented("claude-code", "1").Should().BeFalse();
    }

    [Fact]
    public async Task FreshNoFileInstall_roundTrips_toSeenFalse_onReload()
    {
        using var dir = new TempDataDir();
        // First init: no file → writes Default (OnboardingSeen null on disk).
        using (var first = new ConfigStore(dir.Path))
            await first.InitAsync(CancellationToken.None);
        // Second init: re-reads the written file; key absent/null → backfill computes false (mode=Preview default).
        using var second = new ConfigStore(dir.Path);
        await second.InitAsync(CancellationToken.None);
        second.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
    }
}
