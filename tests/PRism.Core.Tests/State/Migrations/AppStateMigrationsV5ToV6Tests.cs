using System.Text.Json;
using System.Text.Json.Nodes;

using FluentAssertions;

using PRism.Core.State.Migrations;

namespace PRism.Core.Tests.State.Migrations;

public class AppStateMigrationsV5ToV6Tests
{
    [Fact]
    public void Migrates_legacy_session_to_empty_tab_map_and_preserves_last_seen_comment_id()
    {
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "last-viewed-head-sha": "abc",
                    "last-seen-comment-id": "999"
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV5ToV6(root);

        var session = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        session["last-viewed-head-sha"].Should().BeNull();
        session["tab-stamps"].Should().NotBeNull();
        ((JsonObject)session["tab-stamps"]!).Should().BeEmpty();
        session["last-seen-comment-id"]!.GetValue<string>().Should().Be("999");
        root["version"]!.GetValue<int>().Should().Be(6);
    }

    [Fact]
    public void Idempotent_on_v6_session_already_carrying_tab_stamps()
    {
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "accounts": { "default": { "reviews": { "sessions": {
            "owner/repo/1": { "tab-stamps": {}, "last-seen-comment-id": "42" }
          }}}}
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV5ToV6(root);

        var session = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        ((JsonObject)session["tab-stamps"]!).Should().BeEmpty();
        session["last-seen-comment-id"]!.GetValue<string>().Should().Be("42");
        root["version"]!.GetValue<int>().Should().Be(6);
    }

    [Fact]
    public void Throws_on_partial_rollback_session_with_both_legacy_and_tab_stamps_keys()
    {
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "accounts": { "default": { "reviews": { "sessions": {
            "owner/repo/1": {
              "last-viewed-head-sha": "abc",
              "tab-stamps": { "tab-A": { "head-sha": "def", "stamped-at-utc": "2026-05-18T00:00:00Z" } }
            }
          }}}}
        }
        """)!.AsObject();

        var ex = Assert.Throws<JsonException>(() => AppStateMigrations.MigrateV5ToV6(root));
        ex.Message.Should().Contain("partial rollback");
    }

    [Fact]
    public void Empty_accounts_object_bumps_version_only()
    {
        var root = JsonNode.Parse("""
        { "version": 5, "accounts": {} }
        """)!.AsObject();

        AppStateMigrations.MigrateV5ToV6(root);

        root["version"]!.GetValue<int>().Should().Be(6);
    }

    [Fact]
    public void Session_with_existing_tab_stamps_only_passes_through()
    {
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "accounts": { "default": { "reviews": { "sessions": {
            "owner/repo/1": {
              "tab-stamps": { "tab-A": { "head-sha": "def", "stamped-at-utc": "2026-05-18T00:00:00Z" } }
            }
          }}}}
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV5ToV6(root);

        var stamps = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!["tab-stamps"]!;
        stamps.Count.Should().Be(1);
        stamps["tab-A"]!["head-sha"]!.GetValue<string>().Should().Be("def");
    }

    [Fact]
    public void Iterates_every_account_not_just_default()
    {
        // V5 introduced accounts.default; v2 will layer more accounts. Migration MUST iterate
        // every account's sessions — a non-default account whose sessions still carry the
        // legacy key would otherwise persist past V6.
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "accounts": {
            "default": { "reviews": { "sessions": {
              "owner/repo/1": { "last-viewed-head-sha": "abc" }
            }}},
            "other-account": { "reviews": { "sessions": {
              "owner/repo/2": { "last-viewed-head-sha": "def" }
            }}}
          }
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV5ToV6(root);

        var s1 = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        var s2 = (JsonObject)root["accounts"]!["other-account"]!["reviews"]!["sessions"]!["owner/repo/2"]!;
        s1["last-viewed-head-sha"].Should().BeNull();
        s2["last-viewed-head-sha"].Should().BeNull();
        ((JsonObject)s1["tab-stamps"]!).Should().BeEmpty();
        ((JsonObject)s2["tab-stamps"]!).Should().BeEmpty();
    }
}
