// tests/PRism.GitHub.Tests/Inbox/GitHubCheckClassifierTests.cs
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.GitHub.Inbox;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public class GitHubCheckClassifierTests
{
    private static JsonElement Run(string status, string? conclusion)
    {
        var json = conclusion is null
            ? $$"""{"status":"{{status}}","conclusion":null}"""
            : $$"""{"status":"{{status}}","conclusion":"{{conclusion}}"}""";
        return JsonDocument.Parse(json).RootElement;
    }

    [Theory]
    [InlineData("queued", null, CheckRunStatus.Queued, null)]
    [InlineData("in_progress", null, CheckRunStatus.InProgress, null)]
    // The non-terminal rule is a CATCH-ALL, not an allowlist: any non-"completed"
    // status (incl. GitHub's newer waiting/requested/pending) → non-terminal. The
    // existing detector tests cover only completed/in_progress, so this is the
    // narrowing-regression guard.
    [InlineData("waiting", null, CheckRunStatus.InProgress, null)]
    [InlineData("requested", null, CheckRunStatus.InProgress, null)]
    [InlineData("some_future_status", null, CheckRunStatus.InProgress, null)]
    [InlineData("completed", "success", CheckRunStatus.Completed, CheckConclusion.Success)]
    [InlineData("completed", "failure", CheckRunStatus.Completed, CheckConclusion.Failure)]
    [InlineData("completed", "timed_out", CheckRunStatus.Completed, CheckConclusion.TimedOut)]
    [InlineData("completed", "cancelled", CheckRunStatus.Completed, CheckConclusion.Cancelled)]
    [InlineData("completed", "action_required", CheckRunStatus.Completed, CheckConclusion.ActionRequired)]
    [InlineData("completed", "skipped", CheckRunStatus.Completed, CheckConclusion.Skipped)]
    [InlineData("completed", "neutral", CheckRunStatus.Completed, CheckConclusion.Neutral)]
    [InlineData("completed", "stale", CheckRunStatus.Completed, CheckConclusion.Stale)]
    [InlineData("completed", "startup_failure", CheckRunStatus.Completed, CheckConclusion.StartupFailure)]
    [InlineData("completed", null, CheckRunStatus.Completed, null)]
    public void ClassifyCheckRun_maps_status_and_conclusion(
        string status, string? conclusion, CheckRunStatus expectedStatus, CheckConclusion? expectedConclusion)
    {
        var (st, concl) = GitHubCheckClassifier.ClassifyCheckRun(Run(status, conclusion));
        Assert.Equal(expectedStatus, st);
        Assert.Equal(expectedConclusion, concl);
    }

    [Theory]
    [InlineData("success", CheckRunStatus.Completed, CheckConclusion.Success)]
    [InlineData("failure", CheckRunStatus.Completed, CheckConclusion.Failure)]
    [InlineData("error", CheckRunStatus.Completed, CheckConclusion.Failure)]
    [InlineData("pending", CheckRunStatus.InProgress, null)]
    public void ClassifyStatusContext_maps_state(
        string state, CheckRunStatus expectedStatus, CheckConclusion? expectedConclusion)
    {
        var ctx = JsonDocument.Parse($$"""{"state":"{{state}}","context":"ci/x","target_url":null}""").RootElement;
        var (st, concl) = GitHubCheckClassifier.ClassifyStatusContext(ctx);
        Assert.Equal(expectedStatus, st);
        Assert.Equal(expectedConclusion, concl);
    }

    [Fact]
    public void HasRegisteredStatuses_true_when_count_positive()
    {
        var root = JsonDocument.Parse("""{"total_count":2,"statuses":[{"state":"success"}]}""").RootElement;
        Assert.True(GitHubCheckClassifier.HasRegisteredStatuses(root));
    }

    [Fact]
    public void HasRegisteredStatuses_false_for_bare_pending_286()
    {
        // The #286 trap: Actions-only PRs return state="pending" with total_count=0
        // and an empty statuses[]. Must read as "none registered".
        var root = JsonDocument.Parse("""{"total_count":0,"statuses":[]}""").RootElement;
        Assert.False(GitHubCheckClassifier.HasRegisteredStatuses(root));
    }
}
