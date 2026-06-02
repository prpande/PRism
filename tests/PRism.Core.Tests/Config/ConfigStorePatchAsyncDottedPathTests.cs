using FluentAssertions;
using PRism.Core.Config;
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
    [InlineData("inbox.sections.ci-failing")]
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
            "inbox.sections.ci-failing"       => sections.CiFailing,
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
            new Dictionary<string, object?> { ["inbox.sections.ci-failing"] = false },
            CancellationToken.None);

        using var roundTrip = new ConfigStore(dir.Path);
        await roundTrip.InitAsync(CancellationToken.None);
        roundTrip.Current.Inbox.Sections.CiFailing.Should().BeFalse();
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
        { "inbox.sections.ci-failing", null },
        { "inbox.sections.ci-failing", 42 },
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
            new Dictionary<string, object?> { ["inbox.sections.ci-failing"] = null },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>();
        // After rejection, the on-disk value MUST remain at its default (true).
        store.Current.Inbox.Sections.CiFailing.Should().BeTrue();
    }
}
