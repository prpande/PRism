using System.Text.Json;
using System.Text.Json.Nodes;

using FluentAssertions;

using PRism.Core.State.Migrations;

namespace PRism.Core.Tests.State.Migrations;

public class AppStateMigrationsV6ToV7Tests
{
    [Fact]
    public void Lifts_summary_into_synthesized_pr_root_draft_when_none_exists()
    {
        var root = JsonNode.Parse("""
        {
          "version": 6,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "draft-comments": [],
                    "draft-summary-markdown": "The summary text."
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV6ToV7(root);

        var session = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        session.ContainsKey("draft-summary-markdown").Should().BeFalse();
        var drafts = (JsonArray)session["draft-comments"]!;
        drafts.Count.Should().Be(1);
        var lifted = (JsonObject)drafts[0]!;
        lifted["side"]!.GetValue<string>().Should().Be("pr");
        lifted["file-path"].Should().BeNull();
        lifted["body-markdown"]!.GetValue<string>().Should().Be("The summary text.");
        lifted["status"]!.GetValue<string>().Should().Be("Draft");
        root["version"]!.GetValue<int>().Should().Be(7);
    }

    [Fact]
    public void Appends_summary_into_existing_pr_root_draft_body()
    {
        var root = JsonNode.Parse("""
        {
          "version": 6,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "draft-comments": [
                      {
                        "id": "draft-1",
                        "file-path": null,
                        "line-number": null,
                        "side": "pr",
                        "anchored-sha": null,
                        "anchored-line-content": null,
                        "body-markdown": "existing body",
                        "status": "Draft",
                        "is-overridden-stale": false,
                        "thread-id": null,
                        "posted-comment-id": null,
                        "posted-body-snapshot": null
                      }
                    ],
                    "draft-summary-markdown": "summary"
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV6ToV7(root);

        var session = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        session.ContainsKey("draft-summary-markdown").Should().BeFalse();
        var drafts = (JsonArray)session["draft-comments"]!;
        drafts.Count.Should().Be(1);
        ((JsonObject)drafts[0]!)["body-markdown"]!.GetValue<string>().Should().Be("existing body\n\nsummary");
        root["version"]!.GetValue<int>().Should().Be(7);
    }

    [Fact]
    public void Idempotent_when_summary_empty_and_no_pr_root_draft()
    {
        var root = JsonNode.Parse("""
        {
          "version": 6,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "draft-comments": [],
                    "draft-summary-markdown": null
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV6ToV7(root);

        var session = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        session.ContainsKey("draft-summary-markdown").Should().BeFalse();
        ((JsonArray)session["draft-comments"]!).Should().BeEmpty();
        root["version"]!.GetValue<int>().Should().Be(7);
    }

    [Fact]
    public void Iterates_every_account_not_just_default()
    {
        var root = JsonNode.Parse("""
        {
          "version": 6,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "draft-comments": [],
                    "draft-summary-markdown": "default summary"
                  }
                }
              }
            },
            "github_acme": {
              "reviews": {
                "sessions": {
                  "acme/repo/2": {
                    "draft-comments": [],
                    "draft-summary-markdown": "acme summary"
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV6ToV7(root);

        var defaultSession = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        var acmeSession = (JsonObject)root["accounts"]!["github_acme"]!["reviews"]!["sessions"]!["acme/repo/2"]!;
        defaultSession.ContainsKey("draft-summary-markdown").Should().BeFalse();
        acmeSession.ContainsKey("draft-summary-markdown").Should().BeFalse();
        ((JsonArray)defaultSession["draft-comments"]!).Count.Should().Be(1);
        ((JsonArray)acmeSession["draft-comments"]!).Count.Should().Be(1);
        ((JsonObject)((JsonArray)defaultSession["draft-comments"]!)[0]!)["body-markdown"]!.GetValue<string>().Should().Be("default summary");
        ((JsonObject)((JsonArray)acmeSession["draft-comments"]!)[0]!)["body-markdown"]!.GetValue<string>().Should().Be("acme summary");
        root["version"]!.GetValue<int>().Should().Be(7);
    }

    [Fact]
    public void Collapses_multiple_pr_root_drafts_with_visible_marker()
    {
        var root = JsonNode.Parse("""
        {
          "version": 6,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "draft-comments": [
                      {
                        "id": "aaa-first",
                        "file-path": null,
                        "line-number": null,
                        "side": "pr",
                        "anchored-sha": null,
                        "anchored-line-content": null,
                        "body-markdown": "first body",
                        "status": "Draft",
                        "is-overridden-stale": false,
                        "thread-id": null,
                        "posted-comment-id": null,
                        "posted-body-snapshot": null
                      },
                      {
                        "id": "bbb-second",
                        "file-path": null,
                        "line-number": null,
                        "side": "pr",
                        "anchored-sha": null,
                        "anchored-line-content": null,
                        "body-markdown": "second body",
                        "status": "Draft",
                        "is-overridden-stale": false,
                        "thread-id": null,
                        "posted-comment-id": null,
                        "posted-body-snapshot": null
                      }
                    ],
                    "draft-summary-markdown": null
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV6ToV7(root);

        var session = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        var drafts = (JsonArray)session["draft-comments"]!;
        drafts.Count.Should().Be(1);
        var survivor = (JsonObject)drafts[0]!;
        survivor["body-markdown"]!.GetValue<string>().Should().StartWith("<!-- migrated from previously-shadowed draft aaa-first -->");
        root["version"]!.GetValue<int>().Should().Be(7);
    }

    [Fact]
    public void Throws_on_partial_rollback_summary_plus_posted_comment_id()
    {
        var root = JsonNode.Parse("""
        {
          "version": 6,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "draft-comments": [
                      {
                        "id": "draft-1",
                        "file-path": null,
                        "line-number": null,
                        "side": "pr",
                        "anchored-sha": null,
                        "anchored-line-content": null,
                        "body-markdown": "already-posted body",
                        "status": "Draft",
                        "is-overridden-stale": false,
                        "thread-id": null,
                        "posted-comment-id": 42,
                        "posted-body-snapshot": "already-posted body"
                      }
                    ],
                    "draft-summary-markdown": "looming overwrite"
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        var ex = Assert.Throws<JsonException>(() => AppStateMigrations.MigrateV6ToV7(root));
        ex.Message.Should().Contain("partial rollback");
    }

    [Fact]
    public void Throws_on_corrupted_draft_comments_shape()
    {
        var root = JsonNode.Parse("""
        {
          "version": 6,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "draft-comments": "garbage",
                    "draft-summary-markdown": "summary"
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        var ex = Assert.Throws<JsonException>(() => AppStateMigrations.MigrateV6ToV7(root));
        ex.Message.Should().Contain("draft-comments must be a JSON array");
    }

    [Fact]
    public void Preserves_thread_id_on_existing_pr_root_draft()
    {
        var root = JsonNode.Parse("""
        {
          "version": 6,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "draft-comments": [
                      {
                        "id": "draft-1",
                        "file-path": null,
                        "line-number": null,
                        "side": "pr",
                        "anchored-sha": null,
                        "anchored-line-content": null,
                        "body-markdown": "existing body",
                        "status": "Draft",
                        "is-overridden-stale": false,
                        "thread-id": "thread-abc",
                        "posted-comment-id": null,
                        "posted-body-snapshot": null
                      }
                    ],
                    "draft-summary-markdown": "summary"
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV6ToV7(root);

        var session = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        var drafts = (JsonArray)session["draft-comments"]!;
        drafts.Count.Should().Be(1);
        var survivor = (JsonObject)drafts[0]!;
        survivor["thread-id"]!.GetValue<string>().Should().Be("thread-abc");
        survivor["body-markdown"]!.GetValue<string>().Should().Be("existing body\n\nsummary");
        root["version"]!.GetValue<int>().Should().Be(7);
    }
}
