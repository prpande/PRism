using System.Text.Json;
using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Json;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

// Covers the S6 PR1 allowlist extension: PatchAsync now accepts dotted-path
// `inbox.sections.*` keys in addition to the legacy bare `ui.*` keys (theme,
// accent, aiPreview). Spec § 2.3 + plan PR1 Task 1.5/1.6.
public class ConfigStorePatchAsyncDottedPathTests
{
    [Theory]
    [InlineData("inbox.sections.review-requested")]
    [InlineData("inbox.sections.awaiting-author")]
    [InlineData("inbox.sections.authored-by-me")]
    [InlineData("inbox.sections.mentioned")]
    public async Task PatchAsync_InboxSectionsKey_PersistsToCorrectField(string key)
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(
            new Dictionary<string, object?> { [key] = false },
            CancellationToken.None);

        var sections = store.Current.Inbox.Sections;
        var actual = key switch
        {
            "inbox.sections.review-requested" => sections.ReviewRequested,
            "inbox.sections.awaiting-author"  => sections.AwaitingAuthor,
            "inbox.sections.authored-by-me"   => sections.AuthoredByMe,
            "inbox.sections.mentioned"        => sections.Mentioned,
            _ => throw new InvalidOperationException("test key not handled")
        };
        actual.Should().BeFalse();
    }

    [Fact]
    public async Task PatchAsync_RecentlyClosed_TogglesSection()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.sections.recently-closed"] = false },
            CancellationToken.None);

        store.Current.Inbox.Sections.RecentlyClosed.Should().BeFalse();
    }

    // #219 inbox group-by-repo toggle: inbox.groupByRepo is a new Bool allowlisted key.
    [Fact]
    public async Task PatchAsync_GroupByRepo_TogglesField()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.groupByRepo"] = false },
            CancellationToken.None);

        store.Current.Inbox.GroupByRepo.Should().BeFalse();
    }

    [Fact]
    public void Default_GroupByRepo_IsTrue()
    {
        AppConfig.Default.Inbox.GroupByRepo.Should().BeTrue();
    }

    [Fact]
    public void Default_RecentlyClosed_IsTrue()
    {
        AppConfig.Default.Inbox.Sections.RecentlyClosed.Should().BeTrue();
    }

    [Fact]
    public async Task PatchAsync_InboxSectionsKey_PersistsAcrossReload()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.sections.authored-by-me"] = false },
            CancellationToken.None);

        using var roundTrip = new ConfigStore(dir.Path);
        await roundTrip.InitAsync(CancellationToken.None);
        roundTrip.Current.Inbox.Sections.AuthoredByMe.Should().BeFalse();
        // Sibling fields remain true (we only patched the one).
        roundTrip.Current.Inbox.Sections.ReviewRequested.Should().BeTrue();
    }

    [Fact]
    public async Task PatchAsync_UnknownDottedKey_ThrowsConfigPatchException()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.sections.unknown"] = true },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains("unknown field"));
    }

    [Fact]
    public async Task PatchAsync_LegacyUiKeys_StillAccepted_BackCompat()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark" },
            CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("dark");
    }

    // Copilot review finding on PR #69: PatchAsync previously did `(string)value!` directly
    // for string keys and `Convert.ToBoolean(null, ...)` for boolean keys. The first throws
    // InvalidCastException (→ 500 over the wire) on non-string input; the second silently
    // returns `false` on null (→ setting flips off without a 400 response). Both surface
    // worse since the allowlist grew to include five new boolean keys. PatchAsync now
    // validates `value` per key BEFORE the switch and throws ConfigPatchException on
    // type mismatch — the endpoint's existing catch turns that into 400, not 500.
    //
    // Theory covers every boolean key (the five inbox.sections.* plus aiPreview) against
    // every non-boolean input shape PreferencesEndpoints.cs can produce.
    public static TheoryData<string, object?> BooleanKeyTypeMismatchInputs() => new()
    {
        { "aiPreview", null },
        { "aiPreview", "true" },
        { "aiPreview", 1 },
        { "inbox.sections.review-requested", null },
        { "inbox.sections.review-requested", "false" },
        { "inbox.sections.awaiting-author", null },
        { "inbox.sections.authored-by-me", null },
        { "inbox.sections.mentioned", null },
        { "inbox.sections.recently-closed", null },
        { "inbox.sections.recently-closed", 42 },
        { "inbox.groupByRepo", null },
        { "inbox.groupByRepo", "false" },
    };

    [Theory]
    [MemberData(nameof(BooleanKeyTypeMismatchInputs))]
    public async Task PatchAsync_BooleanKey_RejectsNonBoolean(string key, object? value)
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { [key] = value },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains(key) && e.Message.Contains("bool"),
                $"key '{key}' is a boolean field — non-boolean input must be rejected with a clear ConfigPatchException so the endpoint returns 400 (not 500 or silent-flip).");
    }

    public static TheoryData<string, object?> StringKeyTypeMismatchInputs() => new()
    {
        { "theme", null },
        { "theme", true },
        { "theme", 5 },
        { "accent", null },
        { "accent", false },
        { "density", null },
        { "density", true },
        { "density", 5 },
        { "contentScale", null },
        { "contentScale", true },
        { "contentScale", 5 },
    };

    [Theory]
    [MemberData(nameof(StringKeyTypeMismatchInputs))]
    public async Task PatchAsync_StringKey_RejectsNonString(string key, object? value)
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { [key] = value },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains(key) && e.Message.Contains("string"),
                $"key '{key}' is a string field — non-string input must be rejected with a clear ConfigPatchException so the endpoint returns 400 (not 500).");
    }

    // PR9b-density: density is a string-typed `ui.*` key alongside theme/accent. Round-trips
    // both legal values (`comfortable` | `compact`); enum-membership validation is NOT enforced
    // server-side (Deviation 6 — same gap exists for theme/accent today).
    [Theory]
    [InlineData("comfortable")]
    [InlineData("compact")]
    public async Task PatchAsync_DensityValidString_PersistsAndReadsBack(string value)
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(
            new Dictionary<string, object?> { ["density"] = value },
            CancellationToken.None);

        store.Current.Ui.Density.Should().Be(value);
    }

    // PR9b-density: an existing config.json written before the field was added must load
    // with the parameter default ("comfortable"). Exercises STJ's record-positional-parameter
    // default path — same mechanism IterationsConfig.ClusteringDisabled already uses.
    [Fact]
    public async Task InitAsync_LegacyConfigWithoutDensity_DefaultsToComfortable()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        // On-disk config.json uses kebab-case naming policy (JsonSerializerOptionsFactory.Storage),
        // so `AiPreview` serializes as `ai-preview`. The wire shape `aiPreview` is the API
        // (camelCase) policy used by PreferencesEndpoints, NOT the storage format.
        await File.WriteAllTextAsync(path, """
            {
              "ui": { "theme": "dark", "accent": "amber", "ai-preview": true }
            }
            """);
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Density.Should().Be("comfortable");
        store.Current.Ui.Theme.Should().Be("dark");
        store.Current.Ui.Accent.Should().Be("amber");
        store.Current.Ui.AiPreview.Should().BeTrue();
    }

    // #135: contentScale is a string-typed `ui.*` key alongside theme/accent/density.
    // Round-trips all five legal values; enum-membership is NOT enforced server-side
    // (Deviation 6 — same gap as theme/accent/density).
    [Theory]
    [InlineData("xs")]
    [InlineData("s")]
    [InlineData("m")]
    [InlineData("l")]
    [InlineData("xl")]
    public async Task PatchAsync_ContentScaleValidString_PersistsAndReadsBack(string value)
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(
            new Dictionary<string, object?> { ["contentScale"] = value },
            CancellationToken.None);

        store.Current.Ui.ContentScale.Should().Be(value);
    }

    // #135: a config.json written before the field existed must load with the
    // parameter default ("m"). Same STJ record-positional-default path as density.
    [Fact]
    public async Task InitAsync_LegacyConfigWithoutContentScale_DefaultsToM()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        await File.WriteAllTextAsync(path, """
            {
              "ui": { "theme": "dark", "accent": "amber", "ai-preview": true, "density": "compact" }
            }
            """);
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.ContentScale.Should().Be("m");
        store.Current.Ui.Density.Should().Be("compact");
        store.Current.Ui.Theme.Should().Be("dark");
        store.Current.Ui.AiPreview.Should().BeTrue();
    }

    [Fact]
    public async Task PatchAsync_BooleanKey_NullValue_DoesNotSilentlyFlipOff()
    {
        // Defends against the specific bug Copilot flagged: Convert.ToBoolean(null, ...)
        // returns false, so a malformed JSON payload mapping to null (number, object, etc.)
        // would silently disable the section without surfacing a 400.
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.sections.recently-closed"] = null },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>();
        // After rejection, the on-disk value MUST remain at its default (true).
        store.Current.Inbox.Sections.RecentlyClosed.Should().BeTrue();
    }

    // S6 PR1: RecentlyClosed is a boolean field added to InboxSectionsConfig with
    // default value true. An existing config.json written before the field was added
    // must load with the default (true). Mirrors InitAsync_LegacyConfigWithoutDensity_DefaultsToComfortable.
    [Fact]
    public async Task InitAsync_LegacyConfigWithoutRecentlyClosed_DefaultsToTrue()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        // Legacy config.json with only the five old inbox.sections keys (kebab-case).
        await File.WriteAllTextAsync(path, """
            {
              "inbox": {
                "sections": {
                  "review-requested": true,
                  "awaiting-author": true,
                  "authored-by-me": true,
                  "mentioned": true,
                  "ci-failing": true
                }
              }
            }
            """);
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Inbox.Sections.RecentlyClosed.Should().BeTrue();
        // Verify the four existing fields round-tripped correctly (legacy ci-failing key
        // is now unknown — silently skipped by STJ, not bound to any record member).
        store.Current.Inbox.Sections.ReviewRequested.Should().BeTrue();
        store.Current.Inbox.Sections.AwaitingAuthor.Should().BeTrue();
        store.Current.Inbox.Sections.AuthoredByMe.Should().BeTrue();
        store.Current.Inbox.Sections.Mentioned.Should().BeTrue();
    }

    // #133 inbox group-by-repo: RecentlyClosedWindowDays is a new trailing-defaulted
    // parameter on InboxConfig (default 14). An existing config.json without this field
    // must deserialize with the default so existing users are unaffected.
    [Fact]
    public void LegacyConfig_WithoutRecentlyClosedWindowDays_DefaultsTo14()
    {
        const string json = """
        {
          "inbox": {
            "deduplicate": true,
            "sections": { "review-requested": true },
            "show-hidden-scope-footer": true
          }
        }
        """;
        var options = JsonSerializerOptionsFactory.Storage;
        var cfg = JsonSerializer.Deserialize<AppConfig>(json, options);
        cfg!.Inbox.RecentlyClosedWindowDays.Should().Be(14);
    }

    // #219 inbox group-by-repo: GroupByRepo is a new trailing-defaulted parameter on
    // InboxConfig (default true). An existing config.json without the kebab-case
    // `group-by-repo` key must deserialize with the default so existing users keep
    // grouping on. Mirrors LegacyConfig_WithoutRecentlyClosedWindowDays_DefaultsTo14.
    [Fact]
    public void LegacyConfig_WithoutGroupByRepo_DefaultsToTrue()
    {
        const string json = """
        {
          "inbox": {
            "deduplicate": true,
            "sections": { "review-requested": true },
            "show-hidden-scope-footer": true
          }
        }
        """;
        var options = JsonSerializerOptionsFactory.Storage;
        var cfg = JsonSerializer.Deserialize<AppConfig>(json, options);
        cfg!.Inbox.GroupByRepo.Should().BeTrue();
    }

    // #262: ci-failing was removed as a section. A config.json written by an older build
    // still carries the kebab-case `ci-failing` key under inbox.sections — it must load
    // cleanly (unknown key skipped, not rejected) with the other booleans preserved.
    [Fact]
    public async Task Loads_legacy_config_with_ciFailing_key_cleanly()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        // Keys MUST be kebab-case: JsonSerializerOptionsFactory.Storage uses
        // KebabCaseJsonNamingPolicy with PropertyNameCaseInsensitive=false, so a
        // camelCase key would silently miss-bind and fall back to record defaults.
        var json = """
        { "inbox": { "deduplicate": true, "sections": {
            "review-requested": true, "awaiting-author": false, "authored-by-me": true,
            "mentioned": true, "ci-failing": true, "recently-closed": false } } }
        """;
        await File.WriteAllTextAsync(Path.Combine(dir, "config.json"), json);

        var store = new ConfigStore(dir);
        await store.InitAsync(CancellationToken.None);

        store.LastLoadError.Should().BeNull();                                  // unknown ciFailing skipped, not rejected
        store.Current.Inbox.Sections.AwaitingAuthor.Should().BeFalse();         // other bools preserved
        store.Current.Inbox.Sections.RecentlyClosed.Should().BeFalse();
    }

    // #262: the patch allowlist no longer accepts inbox.sections.ci-failing — a client
    // (or a stale UI) patching it must get a clean rejection, not a silent no-op or 500.
    [Fact]
    public async Task Patch_rejects_removed_ci_failing_section_key()
    {
        var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
        await store.InitAsync(CancellationToken.None);

        var act = async () => await store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.sections.ci-failing"] = true }, CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>().WithMessage("*unknown field*");
    }

    // #262 PR3: inbox.defaultSort is the first scalar (string) inbox preference. A valid
    // value patches through to InboxConfig.DefaultSort and persists.
    [Fact]
    public async Task Patch_sets_valid_default_sort()
    {
        var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
        await store.InitAsync(CancellationToken.None);
        await store.PatchAsync(new Dictionary<string, object?> { ["inbox.defaultSort"] = "pushed" }, CancellationToken.None);
        store.Current.Inbox.DefaultSort.Should().Be("pushed");
    }

    // #262 PR3: the allowlist accepts inbox.defaultSort as a string, but a value-set check
    // (updated|pushed|diff|comments) runs before the gate — a bogus value is rejected with a
    // clean ConfigPatchException naming the field (→ 400), not silently persisted.
    [Fact]
    public async Task Patch_rejects_unknown_default_sort_value()
    {
        var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
        await store.InitAsync(CancellationToken.None);
        var act = async () => await store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.defaultSort"] = "bogus" }, CancellationToken.None);
        await act.Should().ThrowAsync<ConfigPatchException>().WithMessage("*inbox.defaultSort*");
    }

    // #275: SectionOrder is a new trailing-defaulted string parameter on InboxConfig.
    // AppConfig.Default (what feature code reads at runtime) must expose the canonical
    // work-section order — recently-closed is pinned in the frontend, so it is absent here.
    [Fact]
    public void Default_SectionOrder_IsCanonicalWorkOrder()
    {
        AppConfig.Default.Inbox.SectionOrder
            .Should().Be("review-requested,awaiting-author,authored-by-me,mentioned");
    }

    // #275: a config.json written before the field existed must load with the canonical
    // default via STJ's record-positional-default path (same mechanism as DefaultSort).
    [Fact]
    public async Task InitAsync_LegacyConfigWithoutSectionOrder_DefaultsToCanonical()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        await File.WriteAllTextAsync(path, """
            {
              "inbox": { "deduplicate": true, "sections": { "review-requested": true } }
            }
            """);
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Inbox.SectionOrder
            .Should().Be("review-requested,awaiting-author,authored-by-me,mentioned");
    }

    // #275: a valid 4-id permutation patches through to InboxConfig.SectionOrder and persists.
    [Fact]
    public async Task Patch_sets_valid_section_order()
    {
        var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
        await store.InitAsync(CancellationToken.None);
        await store.PatchAsync(
            new Dictionary<string, object?>
                { ["inbox.sectionOrder"] = "mentioned,review-requested,authored-by-me,awaiting-author" },
            CancellationToken.None);
        store.Current.Inbox.SectionOrder
            .Should().Be("mentioned,review-requested,authored-by-me,awaiting-author");
    }

    [Fact]
    public async Task Patch_section_order_persists_across_reload()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        var store = new ConfigStore(dir);
        await store.InitAsync(CancellationToken.None);
        await store.PatchAsync(
            new Dictionary<string, object?>
                { ["inbox.sectionOrder"] = "authored-by-me,mentioned,review-requested,awaiting-author" },
            CancellationToken.None);

        var roundTrip = new ConfigStore(dir);
        await roundTrip.InitAsync(CancellationToken.None);
        roundTrip.Current.Inbox.SectionOrder
            .Should().Be("authored-by-me,mentioned,review-requested,awaiting-author");
    }

    // Each malformed value must be rejected with a ConfigPatchException naming the field
    // (→ 400 at the endpoint), not silently persisted.
    public static TheoryData<string> InvalidSectionOrders() => new()
    {
        "review-requested,awaiting-author,authored-by-me",                            // incomplete (3)
        "review-requested,awaiting-author,authored-by-me,mentioned,recently-closed",  // too long (5)
        "review-requested,review-requested,authored-by-me,mentioned",                 // duplicate
        "review-requested,awaiting-author,authored-by-me,bogus",                      // unknown id
        "",                                                                            // empty
        // 4 ids but a valid one (authored-by-me) is replaced by the pinned id —
        // rejected because authored-by-me is MISSING, not because recently-closed is present.
        "recently-closed,review-requested,awaiting-author,mentioned",
        // Strict-write: a trailing/leading/double comma yields an empty segment that the
        // count check must reject — NOT silently drop. (Copilot PR #303.)
        "review-requested,awaiting-author,authored-by-me,mentioned,",                 // trailing comma
        "review-requested,,awaiting-author,authored-by-me,mentioned",                 // double comma
    };

    [Theory]
    [MemberData(nameof(InvalidSectionOrders))]
    public async Task Patch_rejects_invalid_section_order(string value)
    {
        var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
        await store.InitAsync(CancellationToken.None);
        var act = async () => await store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.sectionOrder"] = value }, CancellationToken.None);
        await act.Should().ThrowAsync<ConfigPatchException>().WithMessage("*inbox.sectionOrder*");
    }

    // #137: inbox.knownBots is a free-form string scalar (additive activity-rail bot
    // logins, comma-separated). Unlike sectionOrder there is no permutation constraint —
    // any string patches through (trimmed) and persists.
    [Fact]
    public async Task Patch_sets_known_bots()
    {
        var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
        await store.InitAsync(CancellationToken.None);
        await store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.knownBots"] = "acme-ci, security-scanner" },
            CancellationToken.None);
        store.Current.Inbox.KnownBots.Should().Be("acme-ci, security-scanner");
    }

    // Non-string value (number/null/bool) is rejected by the per-key type check.
    [Fact]
    public async Task Patch_rejects_nonstring_section_order()
    {
        var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
        await store.InitAsync(CancellationToken.None);
        var act = async () => await store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.sectionOrder"] = 42 }, CancellationToken.None);
        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains("inbox.sectionOrder") && e.Message.Contains("string"));
    }
}
