using System.Text.Json.Nodes;
using PRism.Core.State;
using PRism.Core.State.Migrations;

namespace PRism.Core.Tests.State;

// Spec § 6 — v3→v4 adds DraftComment.ThreadId as an additive nullable field. The migration's
// transform body is empty (null is the correct default for pre-existing entries); the visible
// version bump is the point. See also the deferrals sidecar "[Skip] V4 schema migration with
// empty transform body" — kept anyway per the project's "document schema changes visibly" rule.
public class MigrateV3ToV4Tests
{
    [Fact]
    public void MigrateV3ToV4_BumpsVersionField_PreservesAllOtherShape()
    {
        var input = JsonNode.Parse("""
            {
              "version": 3,
              "reviews": {
                "sessions": {
                  "owner/repo/42": {
                    "draft-comments": [
                      { "id": "d1", "file-path": "src/Foo.cs", "line-number": 42, "side": "RIGHT",
                        "anchored-sha": "abc", "anchored-line-content": "line", "body-markdown": "body",
                        "status": "draft", "is-overridden-stale": false }
                    ]
                  }
                }
              }
            }
            """)!.AsObject();

        var output = AppStateMigrations.MigrateV3ToV4(input);

        Assert.Equal(4, output["version"]!.GetValue<int>());
        var draft = output["reviews"]!["sessions"]!["owner/repo/42"]!["draft-comments"]![0]!.AsObject();
        Assert.Equal("d1", draft["id"]!.GetValue<string>());
        Assert.Equal("src/Foo.cs", draft["file-path"]!.GetValue<string>());
        // thread-id is absent — the intended state (deserializes to null).
        Assert.False(draft.ContainsKey("thread-id"));
    }

    [Fact]
    public void MigrateV3ToV4_HandlesEmptyReviews()
    {
        var input = JsonNode.Parse("""{"version":3, "reviews":{"sessions":{}}}""")!.AsObject();
        var output = AppStateMigrations.MigrateV3ToV4(input);
        Assert.Equal(4, output["version"]!.GetValue<int>());
    }

    [Fact]
    public void AppStateDefault_IsAtVersion7()
    {
        // Documentation pin: the in-memory default and the migration target stay in lockstep.
        // S6 PR0 — bumped from 4 to 5 alongside the multi-account scaffold migration.
        // Cross-tab-stamp slice — bumped from 5 to 6 alongside the V5→V6 migration that
        // replaces session-flat LastViewedHeadSha with a per-tab TabStamps map.
        // PR-root Post + submit-discard slice — bumped from 6 to 7 alongside the V6→V7 migration
        // that lifts DraftSummaryMarkdown into a PR-root DraftComment row.
        Assert.Equal(7, AppState.Default.Version);
    }
}
