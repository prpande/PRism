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
}
