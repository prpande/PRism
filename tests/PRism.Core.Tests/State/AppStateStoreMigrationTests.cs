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
        state.Reviews.Sessions.Should().ContainKey("owner/repo/123");
        state.Reviews.Sessions["owner/repo/123"].ViewedFiles.Should().BeEmpty();
        state.Reviews.Sessions["owner/repo/123"].LastViewedHeadSha.Should().Be("abc123");
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
        state.Reviews.Sessions["owner/repo/123"].ViewedFiles.Should().ContainKey("src/Foo.cs");
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
                    DraftComments: new List<DraftComment>(),
                    DraftReplies: new List<DraftReply>(),
                    DraftSummaryMarkdown: null,
                    DraftVerdict: null,
                    DraftVerdictStatus: DraftVerdictStatus.Draft,
                    ViewedFiles: new Dictionary<string, string>
                    {
                        ["src/Foo.cs"] = "head1",
                        ["PRism.Core/State/AppState.cs"] = "head1",
                        ["lower/case/path.ts"] = "head1",
                    })
            };
            await writeStore.SaveAsync(initial with { Reviews = initial.Reviews with { Sessions = sessions } }, CancellationToken.None);
        }

        using var readStore = new AppStateStore(dir.Path);
        var roundtrip = await readStore.LoadAsync(CancellationToken.None);

        var session = roundtrip.Reviews.Sessions["mindbody/Mindbody.BizApp.Bff/42"];
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

    [Fact]
    public async Task LoadAsync_quarantines_state_when_root_is_not_a_json_object()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        // Root is a JSON array — root["version"] would throw InvalidOperationException
        // (not JsonException) on JsonNode's string indexer, escaping the quarantine path.
        await File.WriteAllTextAsync(statePath, "[]");

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Should().BeEquivalentTo(AppState.Default);
        Directory.GetFiles(dir.Path, "state.json.corrupt-*").Should().NotBeEmpty();
    }

    [Fact]
    public async Task LoadAsync_quarantines_state_with_overflowing_version_value()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        // 99999999999 exceeds int.MaxValue; GetValue<int>() can throw OverflowException
        // depending on the underlying JsonValue backing — must funnel through quarantine.
        await File.WriteAllTextAsync(statePath, """
        {
          "version": 99999999999,
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

    [Fact]
    public async Task LoadAsync_quarantines_v1_state_when_review_sessions_is_not_an_object()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        // v1 input where review-sessions is a string — MigrateV1ToV2's AsObject() would
        // throw InvalidOperationException, escaping LoadAsync's catch (JsonException).
        await File.WriteAllTextAsync(statePath, """
        {
          "version": 1,
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
    }

    [Fact]
    public async Task SaveAsync_then_LoadAsync_round_trips_default_ui_preferences()
    {
        // AppState.Default carries UiPreferences { DiffMode: SideBySide }. A round-trip
        // through SaveAsync + LoadAsync must preserve it (and persist it to disk).
        using var dir = new TempDataDir();
        using (var writeStore = new AppStateStore(dir.Path))
        {
            var initial = await writeStore.LoadAsync(CancellationToken.None);
            await writeStore.SaveAsync(initial, CancellationToken.None);
        }

        using var readStore = new AppStateStore(dir.Path);
        var state = await readStore.LoadAsync(CancellationToken.None);

        state.UiPreferences.DiffMode.Should().Be(DiffMode.SideBySide);

        // Verify the kebab-case wire format actually landed on disk.
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "state.json"));
        raw.Should().Contain("\"ui-preferences\"")
           .And.Contain("\"diff-mode\":\"side-by-side\"");
    }

    [Fact]
    public async Task LoadAsync_migrates_v1_state_file_adds_ui_preferences_with_side_by_side_default()
    {
        // Spec § 6.3: v1 → v2 migration inserts `ui-preferences: { "diff-mode": "side-by-side" }`
        // at the top level via the EnsureV2Shape forward-fixup step.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
        {
          "version": 1,
          "review-sessions": {},
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(2);
        state.UiPreferences.DiffMode.Should().Be(DiffMode.SideBySide);
    }

    [Fact]
    public async Task LoadAsync_forward_fixes_v2_state_without_ui_preferences()
    {
        // The smoking-gun case: PR #14 shipped v2 without `ui-preferences`. Pure v2 → v2
        // reads on those files would skip MigrateV1ToV2 entirely. Spec § 6.3 EnsureV2Shape
        // backfills the key on every v2 read regardless of stored version. Idempotent.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
        {
          "version": 2,
          "review-sessions": {
            "owner/repo/1": {
              "last-viewed-head-sha": null,
              "last-seen-comment-id": null,
              "pending-review-id": null,
              "pending-review-commit-oid": null,
              "viewed-files": {}
            }
          },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.UiPreferences.DiffMode.Should().Be(DiffMode.SideBySide);

        // The backfilled key persists on the next save, so a future implementer of the
        // EnsureV2Shape helper can choose either approach (in-place mutation or post-load
        // wrap with `state with`) and the wire format still ends up correct.
        await store.SaveAsync(state, CancellationToken.None);
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "state.json"));
        raw.Should().Contain("\"diff-mode\":\"side-by-side\"");
    }

    [Fact]
    public async Task LoadAsync_future_version_without_ui_preferences_stays_read_only_with_defaults_filled()
    {
        // Future-version state.json missing `ui-preferences` must (a) NOT trip the
        // JsonException quarantine path (which would clear IsReadOnlyMode and delete the
        // user's data), and (b) still leave the store in IsReadOnlyMode=true so SaveAsync
        // refuses writes from the older binary. EnsureV2Shape backfills the in-memory
        // shape on the future-version path; nothing is persisted because saves are blocked.
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

        store.IsReadOnlyMode.Should().BeTrue();
        state.UiPreferences.Should().NotBeNull();
        state.UiPreferences.DiffMode.Should().Be(DiffMode.SideBySide);

        // Quarantine file was not created (the file is preserved for future-binary use).
        Directory.GetFiles(dir.Path, "state.json.corrupt-*").Should().BeEmpty();
        File.Exists(Path.Combine(dir.Path, "state.json")).Should().BeTrue();

        // SaveAsync still refuses (read-only invariant intact).
        var save = async () => await store.SaveAsync(state, CancellationToken.None);
        await save.Should().ThrowAsync<InvalidOperationException>().WithMessage("*read-only mode*");
    }

    [Fact]
    public async Task ResetToDefaultAsync_round_trips_clean_state()
    {
        // Save a non-default state, reset, re-load → must equal AppState.Default.
        // Spec § 6.3 Setup-reset bypass.
        using var dir = new TempDataDir();
        using (var writeStore = new AppStateStore(dir.Path))
        {
            var initial = await writeStore.LoadAsync(CancellationToken.None);
            var sessions = new Dictionary<string, ReviewSessionState>
            {
                ["owner/repo/1"] = new ReviewSessionState(
                    LastViewedHeadSha: "abc",
                    LastSeenCommentId: null,
                    PendingReviewId: null,
                    PendingReviewCommitOid: null,
                    ViewedFiles: new Dictionary<string, string>(),
                    DraftComments: new List<DraftComment>(),
                    DraftReplies: new List<DraftReply>(),
                    DraftSummaryMarkdown: null,
                    DraftVerdict: null,
                    DraftVerdictStatus: DraftVerdictStatus.Draft)
            };
            await writeStore.SaveAsync(initial with { Reviews = initial.Reviews with { Sessions = sessions } }, CancellationToken.None);
            await writeStore.ResetToDefaultAsync(CancellationToken.None);
        }

        using var readStore = new AppStateStore(dir.Path);
        var state = await readStore.LoadAsync(CancellationToken.None);

        state.Should().BeEquivalentTo(AppState.Default);
    }

    [Fact]
    public async Task ResetToDefaultAsync_clears_read_only_mode_after_future_version_load()
    {
        // The whole point of ResetToDefaultAsync is recovery from a future-version state.json
        // that put the store into IsReadOnlyMode. Setup is the only caller; it bypasses
        // SaveAsync's read-only guard, deletes state.json, and clears the flag.
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

        await store.ResetToDefaultAsync(CancellationToken.None);

        store.IsReadOnlyMode.Should().BeFalse();
        File.Exists(Path.Combine(dir.Path, "state.json")).Should().BeFalse();

        // The next SaveAsync now succeeds (read-only guard cleared).
        var act = async () => await store.SaveAsync(AppState.Default, CancellationToken.None);
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task ResetToDefaultAsync_throws_StateResetFailedException_when_File_Delete_fails()
    {
        // P2.20: surface a domain exception so Setup can show a recovery message.
        // Hold an exclusive read-lock on state.json so File.Delete fails with IOException,
        // which the implementation translates into StateResetFailedException.
        using var dir = new TempDataDir();
        using var initStore = new AppStateStore(dir.Path);
        _ = await initStore.LoadAsync(CancellationToken.None);   // creates the file

        var statePath = Path.Combine(dir.Path, "state.json");
        using var locker = new FileStream(statePath, FileMode.Open, FileAccess.Read, FileShare.None);

        using var store = new AppStateStore(dir.Path);
        var act = async () => await store.ResetToDefaultAsync(CancellationToken.None);
        await act.Should().ThrowAsync<StateResetFailedException>();
    }

    [Fact]
    public async Task LoadAsync_quarantines_state_with_unsupported_low_version()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        // Version 0 was never a real format. The previous `stored < 2` migration gate
        // silently ran the v1->v2 migration on it; the contract is that unknown old
        // versions quarantine instead.
        await File.WriteAllTextAsync(statePath, """
        {
          "version": 0,
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
