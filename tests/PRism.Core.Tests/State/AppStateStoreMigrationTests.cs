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
}
