using System.Text.Json;
using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration.Helpers;

public class FixtureStripAllowlistTests
{
    private static string Strip(string input)
    {
        using var doc = JsonDocument.Parse(input);
        var stripped = FixtureStripAllowlist.Apply(doc.RootElement);
        return stripped!.ToJsonString();
    }

    [Fact]
    public void Keeps_structural_fields_strips_body()
    {
        // PR body is NOT in the allowlist (allowlist design — spec § 7) — must be stripped.
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "number": 19,
                "body": "Lots of internal critique here",
                "state": "MERGED"
              }
            }
          }
        }
        """);
        stripped.Should().Contain("\"number\":19").And.Contain("\"state\":\"MERGED\"");
        stripped.Should().NotContain("Lots of internal critique here");
        stripped.Should().Contain("\"body\":null");  // shape preserved as null
    }

    [Fact]
    public void Unknown_fields_default_to_stripped_under_allowlist_design()
    {
        // Spec § 7 mandates allowlist over denylist so a future GraphQL field addition doesn't
        // silently include sensitive content. A field never seen before — e.g. "avatarUrl",
        // "databaseId", "secretToken" — must default to stripped, not pass through.
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "number": 19,
                "author": { "login": "someone", "avatarUrl": "https://example.com/a", "databaseId": 12345, "secretToken": "ghp_abc" }
              }
            }
          }
        }
        """);
        stripped.Should().Contain("\"number\":19");
        stripped.Should().NotContain("someone");
        stripped.Should().NotContain("example.com");
        stripped.Should().NotContain("12345");
        stripped.Should().NotContain("ghp_abc");
    }

    [Fact]
    public void Strips_identity_email_and_keeps_type_marker()
    {
        // Commit author email is identity per spec § 7 — must be stripped.
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "commits": {
                  "nodes": [
                    {
                      "commit": {
                        "author": { "email": "private@example.com", "name": "Some Person" },
                        "message": "fix: thing"
                      }
                    }
                  ]
                }
              }
            }
          }
        }
        """);
        stripped.Should().NotContain("private@example.com");
        stripped.Should().NotContain("Some Person");
        stripped.Should().NotContain("fix: thing");
    }

    [Fact]
    public void Keeps_enum_state_review_type_count_fields()
    {
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "reviews": {
                  "totalCount": 2,
                  "nodes": [
                    { "state": "APPROVED" },
                    { "state": "COMMENTED" }
                  ]
                }
              }
            }
          }
        }
        """);
        stripped.Should().Contain("\"totalCount\":2");
        stripped.Should().Contain("\"state\":\"APPROVED\"");
        stripped.Should().Contain("\"state\":\"COMMENTED\"");
    }

    [Fact]
    public void Strips_login_field_universally()
    {
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "author": { "login": "someone" },
                "reviews": { "nodes": [ { "author": { "login": "reviewer" } } ] }
              }
            }
          }
        }
        """);
        stripped.Should().NotContain("\"login\":\"someone\"");
        stripped.Should().NotContain("\"login\":\"reviewer\"");
    }

    [Fact]
    public void Preserves_overall_shape_for_diff_compatibility()
    {
        // After stripping, the result must still be valid JSON the differ can walk.
        var input = """{"data": {"repository": {"pullRequest": {"body": "x", "number": 1}}}}""";
        var stripped = Strip(input);
        // Re-parse to assert it's well-formed JSON.
        var doc = JsonDocument.Parse(stripped);
        doc.RootElement.GetProperty("data").GetProperty("repository").GetProperty("pullRequest").GetProperty("number").GetInt32().Should().Be(1);
    }
}
