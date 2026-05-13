using System.Text.Json.Nodes;
using FluentAssertions;
using PRism.Core.State.Migrations;
using Xunit;

namespace PRism.Core.Tests.State.Migrations;

public class AppStateMigrationsV4ToV5Tests
{
    [Fact]
    public void MigrateV4ToV5_moves_reviews_ai_state_and_last_configured_host_under_accounts_default()
    {
        var root = JsonNode.Parse("""
        {
          "version": 4,
          "ui-preferences": { "diff-mode": "side-by-side" },
          "reviews": { "sessions": { "owner/repo/1": { "last-viewed-head-sha": "abc" } } },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """)!.AsObject();

        var migrated = AppStateMigrations.MigrateV4ToV5(root);

        migrated["version"]!.GetValue<int>().Should().Be(5);
        migrated.ContainsKey("reviews").Should().BeFalse();
        migrated.ContainsKey("ai-state").Should().BeFalse();
        migrated.ContainsKey("last-configured-github-host").Should().BeFalse();
        migrated["ui-preferences"].Should().NotBeNull();
        migrated["accounts"]!.AsObject().Should().ContainKey("default");

        var def = migrated["accounts"]!["default"]!.AsObject();
        def["reviews"]!["sessions"]!["owner/repo/1"]!["last-viewed-head-sha"]!.GetValue<string>().Should().Be("abc");
        def["ai-state"]!["repo-clone-map"]!.AsObject().Should().BeEmpty();
        def["last-configured-github-host"]!.GetValue<string>().Should().Be("https://github.com");
    }

    [Fact]
    public void MigrateV4ToV5_is_idempotent_for_v5_input()
    {
        // The migration framework guards by version comparison (see AppStateStore.MigrateIfNeeded),
        // so this test simulates running the step in isolation against an already-V5 shape.
        // The transform itself should be a no-op when there's nothing at root to move.
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "ui-preferences": { "diff-mode": "side-by-side" },
          "accounts": { "default": { "reviews": { "sessions": {} }, "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null }, "last-configured-github-host": null } }
        }
        """)!.AsObject();

        var migrated = AppStateMigrations.MigrateV4ToV5(root);

        migrated["version"]!.GetValue<int>().Should().Be(5);
        migrated["accounts"]!["default"]!["reviews"].Should().NotBeNull();
        migrated.ContainsKey("reviews").Should().BeFalse();
    }

    [Fact]
    public void MigrateV4ToV5_handles_partially_populated_v4_with_missing_optional_fields()
    {
        // A V4 file with `last-configured-github-host` absent (it's nullable). The migration must
        // produce `accounts.default.last-configured-github-host: null`, not throw and not omit the key.
        var root = JsonNode.Parse("""
        {
          "version": 4,
          "ui-preferences": { "diff-mode": "side-by-side" },
          "reviews": { "sessions": {} },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null }
        }
        """)!.AsObject();

        var migrated = AppStateMigrations.MigrateV4ToV5(root);

        var def = migrated["accounts"]!["default"]!.AsObject();
        def.ContainsKey("last-configured-github-host").Should().BeTrue();
        def["last-configured-github-host"].Should().BeNull();
    }

    [Fact]
    public void MigrateV4ToV5_throws_on_partial_rollback_file_with_both_orphan_root_keys_and_accounts()
    {
        // Hand-edit / partial-rollback scenario from a hypothetical V6 binary back to V4. The user
        // (or a fix-up script) lowered `version: 6` to `version: 4` but left the `accounts` key in
        // alongside re-introduced root-level `reviews`. The naive idempotency check (just `accounts
        // is JsonObject`) would silently drop the user's freshly-edited root-level data; instead we
        // surface as JsonException so AppStateStore.LoadCoreAsync quarantines the file.
        var root = JsonNode.Parse("""
        {
          "version": 4,
          "ui-preferences": { "diff-mode": "side-by-side" },
          "reviews": { "sessions": { "owner/repo/1": { "last-viewed-head-sha": "freshly-edited" } } },
          "accounts": { "default": { "reviews": { "sessions": { "owner/repo/1": { "last-viewed-head-sha": "stale" } } } } }
        }
        """)!.AsObject();

        Action act = () => AppStateMigrations.MigrateV4ToV5(root);

        act.Should().Throw<System.Text.Json.JsonException>()
            .WithMessage("*partial rollback*");
    }
}
