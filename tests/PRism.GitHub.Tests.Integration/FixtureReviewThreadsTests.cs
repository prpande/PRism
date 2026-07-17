using System.Text.Json;
using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;

namespace PRism.GitHub.Tests.Integration;

/// <summary>
/// Offline replay of the frozen PR #19 capture through the production parser. No
/// Integration trait — this runs in the default (CI) filter; the fixture ships with
/// the test bin. PR #19 is a locked corpus PR, so its thread population is stable.
/// </summary>
public class FixtureReviewThreadsTests
{
    private static JsonElement LoadPull()
    {
        var path = FixturePathResolver.GetFixturePath("pr19-graphql-response.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return doc.RootElement.GetProperty("data").GetProperty("repository").GetProperty("pullRequest").Clone();
    }

    [Fact]
    public void Outdated_threads_surface_null_line_isOutdated_and_originalLine()
    {
        var threads = GitHubPrParser.ParseReviewThreads(LoadPull());
        threads.Should().HaveCount(6);
        var outdated = threads.Where(t => t.LineNumber is null).ToList();
        outdated.Should().HaveCount(3);
        outdated.Should().OnlyContain(t => t.IsOutdated && t.OriginalLine != null,
            "GitHub returns line:null exactly for outdated LINE-subject threads, with originalLine populated");
    }

    [Fact]
    public void Anchored_threads_keep_their_line_numbers()
    {
        var threads = GitHubPrParser.ParseReviewThreads(LoadPull());
        threads.Where(t => t.LineNumber is not null).Select(t => t.LineNumber!.Value)
            .Should().BeEquivalentTo(new[] { 390, 548, 56 });
    }

    [Fact]
    public void Fixture_never_carries_freeform_hunks_or_review_ids()
    {
        // Leak guard for FixtureStripAllowlist edits: diffHunk (freeform code text) and
        // pullRequestReview{databaseId} must stay stripped in the committed capture. The
        // shape-drift test cannot catch an over-broad allowlist — it re-strips the live
        // response with the same allowlist, so a mis-edit is self-consistent there. This
        // assertion is the permanent CI gate.
        var threads = GitHubPrParser.ParseReviewThreads(LoadPull());
        threads.Should().OnlyContain(t => t.DiffHunk == null && t.ReviewDatabaseId == null);
    }
}
