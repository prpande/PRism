using FluentAssertions;
using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.State;

public class AppStateStoreMigrationTests
{
    [Fact]
    public async Task LoadAsync_migrates_v1_state_file_to_v2_and_adds_empty_viewed_files_to_each_session()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
        {
          "version": 1,
          "review-sessions": {
            "owner/repo/123": {
              "last-viewed-head-sha": "abc123",
              "last-seen-comment-id": "42",
              "pending-review-id": null,
              "pending-review-commit-oid": null
            }
          },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(2);
        state.ReviewSessions.Should().ContainKey("owner/repo/123");
        state.ReviewSessions["owner/repo/123"].ViewedFiles.Should().BeEmpty();
        state.ReviewSessions["owner/repo/123"].LastViewedHeadSha.Should().Be("abc123");
    }

    [Fact]
    public async Task LoadAsync_leaves_v2_state_file_unchanged()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
        {
          "version": 2,
          "review-sessions": {
            "owner/repo/123": {
              "last-viewed-head-sha": "abc",
              "last-seen-comment-id": "1",
              "pending-review-id": null,
              "pending-review-commit-oid": null,
              "viewed-files": { "src/Foo.cs": "abc" }
            }
          },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(2);
        state.ReviewSessions["owner/repo/123"].ViewedFiles.Should().ContainKey("src/Foo.cs");
        store.IsReadOnlyMode.Should().BeFalse();
    }

    [Fact]
    public async Task LoadAsync_throws_on_missing_version_field()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
        {
          "review-sessions": {},
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        await FluentActions.Invoking(() => store.LoadAsync(CancellationToken.None))
            .Should().ThrowAsync<UnsupportedStateVersionException>()
            .Where(e => e.Version == 0);
    }

    [Fact]
    public async Task LoadAsync_enters_read_only_mode_on_future_version()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
        {
          "version": 99,
          "review-sessions": {},
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        _ = await store.LoadAsync(CancellationToken.None);

        store.IsReadOnlyMode.Should().BeTrue();
    }

    [Fact]
    public async Task SaveAsync_throws_when_in_read_only_mode()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
        {
          "version": 99,
          "review-sessions": {},
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        var act = async () => await store.SaveAsync(state, CancellationToken.None);
        await act.Should().ThrowAsync<InvalidOperationException>().WithMessage("*read-only mode*");
    }

    [Fact]
    public async Task SaveAsync_then_LoadAsync_preserves_viewed_files_keys_with_uppercase_characters()
    {
        using var dir = new TempDataDir();
        using (var writeStore = new AppStateStore(dir.Path))
        {
            // Force a v2 default file to disk by loading first.
            var initial = await writeStore.LoadAsync(CancellationToken.None);
            var sessions = new Dictionary<string, ReviewSessionState>
            {
                ["mindbody/Mindbody.BizApp.Bff/42"] = new ReviewSessionState(
                    LastViewedHeadSha: "abc",
                    LastSeenCommentId: null,
                    PendingReviewId: null,
                    PendingReviewCommitOid: null,
                    ViewedFiles: new Dictionary<string, string>
                    {
                        ["src/Foo.cs"] = "head1",
                        ["PRism.Core/State/AppState.cs"] = "head1",
                        ["lower/case/path.ts"] = "head1",
                    })
            };
            await writeStore.SaveAsync(initial with { ReviewSessions = sessions }, CancellationToken.None);
        }

        using var readStore = new AppStateStore(dir.Path);
        var roundtrip = await readStore.LoadAsync(CancellationToken.None);

        var session = roundtrip.ReviewSessions["mindbody/Mindbody.BizApp.Bff/42"];
        session.ViewedFiles.Should().ContainKey("src/Foo.cs");
        session.ViewedFiles.Should().ContainKey("PRism.Core/State/AppState.cs");
        session.ViewedFiles.Should().ContainKey("lower/case/path.ts");
    }

    [Fact]
    public async Task LoadAsync_resets_read_only_when_future_version_body_quarantined()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        // version=99 trips the future-version branch (IsReadOnlyMode=true), but the
        // structurally-incompatible body (review-sessions as a string) makes Deserialize
        // throw JsonException — the catch quarantines and writes a fresh v2 default.
        // After that, the on-disk file IS v2 and saves must work again.
        await File.WriteAllTextAsync(statePath, """
        {
          "version": 99,
          "review-sessions": "not-a-dict",
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Should().BeEquivalentTo(AppState.Default);
        Directory.GetFiles(dir.Path, "state.json.corrupt-*").Should().NotBeEmpty();
        store.IsReadOnlyMode.Should().BeFalse();

        var act = async () => await store.SaveAsync(state, CancellationToken.None);
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task LoadAsync_quarantines_state_with_malformed_version_value()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        await File.WriteAllTextAsync(statePath, """
        {
          "version": "not-an-int",
          "review-sessions": {},
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Should().BeEquivalentTo(AppState.Default);
        Directory.GetFiles(dir.Path, "state.json.corrupt-*").Should().NotBeEmpty();
    }
}
