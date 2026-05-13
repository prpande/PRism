using PRism.Core.State;

namespace PRism.Core.Tests.State;

public class MigrationChainTests
{
    [Fact]
    public async Task LoadsV1File_AppliesV1ToV2_ThenV2ToV3_ThenV3ToV4_ThenV4ToV5_ResultIsV5()
    {
        var temp = Path.GetTempPath();
        var dir = Directory.CreateDirectory(Path.Combine(temp, $"prism-test-{Guid.NewGuid():N}")).FullName;
        try
        {
            var v1Json = """
            {
              "version": 1,
              "review-sessions": {
                "acme/api/123": {
                  "last-viewed-head-sha": "abc",
                  "last-seen-comment-id": "100"
                }
              },
              "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
              "last-configured-github-host": null,
              "ui-preferences": { "diff-mode": "side-by-side" }
            }
            """;
            await File.WriteAllTextAsync(Path.Combine(dir, "state.json"), v1Json);

            var store = new AppStateStore(dir);
            var loaded = await store.LoadAsync(CancellationToken.None);

            Assert.Equal(5, loaded.Version);
            Assert.True(loaded.Reviews.Sessions.ContainsKey("acme/api/123"));
            var session = loaded.Reviews.Sessions["acme/api/123"];
            Assert.Empty(session.DraftComments);
            Assert.Empty(session.DraftReplies);
            Assert.Null(session.DraftSummaryMarkdown);
            Assert.Equal(DraftVerdictStatus.Draft, session.DraftVerdictStatus);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task LoadsV3FileWithReviewsButNoSessions_BackfillsEmptySessions()
    {
        // Regression: a state.json shaped `{ "reviews": {} }` (missing the inner `sessions`
        // child) used to deserialize to `Reviews.Sessions == null`, which would NRE in
        // any downstream `state.Reviews.Sessions.TryGetValue(...)` call.
        var temp = Path.GetTempPath();
        var dir = Directory.CreateDirectory(Path.Combine(temp, $"prism-test-{Guid.NewGuid():N}")).FullName;
        try
        {
            var json = """
            {
              "version": 3,
              "reviews": {},
              "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
              "last-configured-github-host": null,
              "ui-preferences": { "diff-mode": "side-by-side" }
            }
            """;
            await File.WriteAllTextAsync(Path.Combine(dir, "state.json"), json);

            var store = new AppStateStore(dir);
            var loaded = await store.LoadAsync(CancellationToken.None);

            Assert.NotNull(loaded.Reviews);
            Assert.NotNull(loaded.Reviews.Sessions);
            Assert.Empty(loaded.Reviews.Sessions);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task LoadsV3File_AppliesV3ToV4_ThenV4ToV5_ResultIsV5()
    {
        var temp = Path.GetTempPath();
        var dir = Directory.CreateDirectory(Path.Combine(temp, $"prism-test-{Guid.NewGuid():N}")).FullName;
        try
        {
            var v3Json = """
            {
              "version": 3,
              "reviews": { "sessions": {} },
              "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
              "last-configured-github-host": null,
              "ui-preferences": { "diff-mode": "side-by-side" }
            }
            """;
            await File.WriteAllTextAsync(Path.Combine(dir, "state.json"), v3Json);

            var store = new AppStateStore(dir);
            var loaded = await store.LoadAsync(CancellationToken.None);

            Assert.Equal(5, loaded.Version);
            Assert.Empty(loaded.Reviews.Sessions);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task LoadsV4File_AppliesV4ToV5_ResultIsV5()
    {
        var temp = Path.GetTempPath();
        var dir = Directory.CreateDirectory(Path.Combine(temp, $"prism-test-{Guid.NewGuid():N}")).FullName;
        try
        {
            var v4Json = """
            {
              "version": 4,
              "reviews": { "sessions": {} },
              "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
              "last-configured-github-host": null,
              "ui-preferences": { "diff-mode": "side-by-side" }
            }
            """;
            await File.WriteAllTextAsync(Path.Combine(dir, "state.json"), v4Json);

            var store = new AppStateStore(dir);
            var loaded = await store.LoadAsync(CancellationToken.None);

            Assert.Equal(5, loaded.Version);
            Assert.Empty(loaded.Reviews.Sessions);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }
}
