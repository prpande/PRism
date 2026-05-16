using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

using FluentAssertions;

using Microsoft.Extensions.Logging;

using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// Spec § 7.1 / § 7.2 / § 7.3 — POST /submit + /submit/foreign-pending-review/{resume,discard}.
public class PrSubmitEndpointsTests
{
    private static readonly JsonSerializerOptions CamelCase = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan PipelineWait = TimeSpan.FromSeconds(5);

    private static OwnPendingReviewSnapshot Snapshot(
        string reviewId, string commitOid = "anchsha", bool isResolved = false,
        string threadBody = "thread body", int line = 2, string filePath = "src/Foo.cs",
        params (string CommentId, string Body)[] replies)
        => new(reviewId, commitOid, DateTimeOffset.UtcNow,
            new[]
            {
                new PendingReviewThreadSnapshot(
                    PullRequestReviewThreadId: "PRRT_t1",
                    FilePath: filePath, LineNumber: line, Side: "RIGHT",
                    OriginalCommitOid: commitOid, OriginalLineContent: "",
                    IsResolved: isResolved, BodyMarkdown: threadBody,
                    CreatedAt: DateTimeOffset.UtcNow,
                    Comments: replies.Select(r => new PendingReviewCommentSnapshot(r.CommentId, r.Body)).ToList()),
            });

    // ----------------------------------------------------------------- POST /submit

    [Fact]
    public async Task PostSubmit_valid_session_returns_200_started_and_pipeline_runs_to_finalize()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, SubmitEndpointsTestContext.ValidSession());
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/1/submit", new { verdict = "Comment" });

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("outcome").GetString().Should().Be("started");

        await TestPoll.UntilAsync(() => ctx.Submitter.FinalizeCalled, PipelineWait, "pipeline should finalize");
        await TestPoll.UntilAsync(() => ctx.Bus.Published.OfType<DraftSubmitted>().Any(), PipelineWait, "DraftSubmitted should publish");
        ctx.Bus.Published.OfType<StateChanged>().Should().NotBeEmpty("a StateChanged fires alongside DraftSubmitted on success");

        var session = await ctx.LoadSessionAsync("o", "r", 1);
        session!.DraftComments.Should().BeEmpty();
        session.PendingReviewId.Should().BeNull();
        session.DraftSummaryMarkdown.Should().BeNull();
        session.DraftVerdict.Should().BeNull();
    }

    [Fact]
    public async Task PostSubmit_stale_draft_present_returns_400_stale_drafts()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        var session = SubmitEndpointsTestContext.ValidSession() with
        {
            DraftComments = new List<DraftComment>
            {
                new("d1", "src/Foo.cs", 42, "RIGHT", new string('a', 40), "x", "body", DraftStatus.Stale, false),
            },
        };
        await ctx.SeedSessionAsync("o", "r", 2, session);
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/2/submit", new { verdict = "Comment" });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("stale-drafts");
    }

    [Fact]
    public async Task PostSubmit_stale_but_overridden_draft_does_not_block_submit()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        var session = SubmitEndpointsTestContext.ValidSession() with
        {
            DraftComments = new List<DraftComment>
            {
                // Status=Stale but IsOverriddenStale=true → rule (b) lets submit proceed (spec § 9 (b)).
                new("d1", "src/Foo.cs", 42, "RIGHT", new string('a', 40), "x", "body", DraftStatus.Stale, IsOverriddenStale: true),
            },
        };
        await ctx.SeedSessionAsync("o", "r", 12, session);
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/12/submit", new { verdict = "Comment" });

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("outcome").GetString().Should().Be("started");
        await TestPoll.UntilAsync(() => ctx.Submitter.FinalizeCalled, PipelineWait);
    }

    [Fact]
    public async Task PostSubmit_needs_reconfirm_verdict_returns_400()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 3, SubmitEndpointsTestContext.ValidSession() with { DraftVerdictStatus = DraftVerdictStatus.NeedsReconfirm });
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/3/submit", new { verdict = "Comment" });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("verdict-needs-reconfirm");
    }

    [Fact]
    public async Task PostSubmit_empty_comment_review_returns_400_no_content()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 4, SubmitEndpointsTestContext.EmptySession());
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/4/submit", new { verdict = "Comment" });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("no-content");
    }

    [Fact]
    public async Task PostSubmit_head_sha_drift_returns_400()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.ActivePrCache.Current = new ActivePrSnapshot("head2", null, DateTimeOffset.UtcNow);
        await ctx.SeedSessionAsync("o", "r", 5, SubmitEndpointsTestContext.ValidSession("head1"));
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/5/submit", new { verdict = "Comment" });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("head-sha-drift");
    }

    [Fact]
    public async Task PostSubmit_head_sha_drift_logs_information_with_both_shas()
    {
        // Companion to PostSubmit_last_viewed_head_sha_null_logs_warning_with_pr_ref.
        // Real drift fires at Information level (UX issue, not a wire-up regression);
        // the message must include both SHAs so an operator can diagnose which side
        // moved without re-running the test under a debugger.
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.ActivePrCache.Current = new ActivePrSnapshot("head-current", null, DateTimeOffset.UtcNow);
        await ctx.SeedSessionAsync("o", "r", 52, SubmitEndpointsTestContext.ValidSession("head-stale"));
        using var client = ctx.CreateClient();

        await client.PostAsJsonAsync("/api/pr/o/r/52/submit", new { verdict = "Comment" });

        ctx.Logs.Records.Should().Contain(r =>
            r.Level == LogLevel.Information &&
            r.Category.Contains("PrSubmit", StringComparison.Ordinal) &&
            r.FormattedMessage.Contains("o/r/52", StringComparison.Ordinal) &&
            r.FormattedMessage.Contains("head-stale", StringComparison.Ordinal) &&
            r.FormattedMessage.Contains("head-current", StringComparison.Ordinal));
    }

    // Regression: production debugging on 2026-05-15 found the FE never calls
    // POST /mark-viewed, so LastViewedHeadSha was always null and submit
    // returned the misleading code "head-sha-drift" with the message "Reload
    // the PR" — but Reload only fires after drift is detected, so the user
    // had no way out. The new code "head-sha-not-stamped" distinguishes the
    // wire-up gap from a real drift; the FE maps it to a different message.
    [Fact]
    public async Task PostSubmit_last_viewed_head_sha_null_returns_400_head_sha_not_stamped()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        var session = SubmitEndpointsTestContext.ValidSession() with { LastViewedHeadSha = null };
        await ctx.SeedSessionAsync("o", "r", 50, session);
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/50/submit", new { verdict = "Comment" });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("head-sha-not-stamped");
        // The user-facing message stays terse — diagnostic detail (named missing
        // call + wire-up hint) lives in the structured Warning log instead, so
        // an unauthenticated viewer can't infer the route shape from the response.
        // The actionable phrase the user needs is "Reload the PR".
        var message = body.GetProperty("message").GetString();
        message.Should().Contain("Reload the PR");
        message.Should().NotContain("mark-viewed", "diagnostic detail belongs in the structured log, not the response body");
    }

    [Fact]
    public async Task PostSubmit_last_viewed_head_sha_null_logs_warning_with_pr_ref_and_diagnostic_phrase()
    {
        // Logging the wire-up gap helps diagnose the problem in production. The
        // log line MUST carry the actionable phrasing — naming the missing
        // /mark-viewed call and the FE wire-up — so an operator grepping logs
        // sees the diagnosis. A regression that shortens the log to just the
        // session key would silently pass a "log fired" assertion; this test
        // pins the actionable content.
        using var ctx = SubmitEndpointsTestContext.Create();
        var session = SubmitEndpointsTestContext.ValidSession() with { LastViewedHeadSha = null };
        await ctx.SeedSessionAsync("o", "r", 51, session);
        using var client = ctx.CreateClient();

        await client.PostAsJsonAsync("/api/pr/o/r/51/submit", new { verdict = "Comment" });

        ctx.Logs.Records.Should().Contain(r =>
            r.Level == LogLevel.Warning &&
            r.Category.Contains("PrSubmit", StringComparison.Ordinal) &&
            r.FormattedMessage.Contains("o/r/51", StringComparison.Ordinal) &&
            r.FormattedMessage.Contains("LastViewedHeadSha", StringComparison.Ordinal) &&
            r.FormattedMessage.Contains("mark-viewed", StringComparison.OrdinalIgnoreCase) &&
            r.FormattedMessage.Contains("frontend", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task PostSubmit_no_session_returns_400_no_session()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/6/submit", new { verdict = "Comment" });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("no-session");
    }

    [Fact]
    public async Task PostSubmit_invalid_verdict_returns_400()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/7/submit", new { verdict = "Bogus" });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("verdict-invalid");
    }

    [Fact]
    public async Task PostSubmit_concurrent_second_call_returns_409_submit_in_progress()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.BeginDelay = TimeSpan.FromSeconds(2);  // hold the per-PR lock past the second call
        await ctx.SeedSessionAsync("o", "r", 8, SubmitEndpointsTestContext.ValidSession());
        using var client = ctx.CreateClient();

        var first = await client.PostAsJsonAsync("/api/pr/o/r/8/submit", new { verdict = "Comment" });
        first.StatusCode.Should().Be(HttpStatusCode.OK);  // lock acquired synchronously before the fire-and-forget dispatch

        var second = await client.PostAsJsonAsync("/api/pr/o/r/8/submit", new { verdict = "Comment" });
        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await second.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("submit-in-progress");
    }

    [Fact]
    public async Task PostSubmit_body_over_16_KiB_returns_413()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        using var client = ctx.CreateClient();
        using var content = new StringContent(new string('x', 17 * 1024), Encoding.UTF8, "application/json");

        var resp = await client.PostAsync(new Uri("/api/pr/o/r/9/submit", UriKind.Relative), content);

        resp.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
    }

    [Fact]
    public async Task PostSubmit_foreign_pending_review_publishes_submit_foreign_pending_review_event()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.OwnPendingReview = Snapshot("PRR_foreign", replies: ("PRRC_c1", "reply body"));
        await ctx.SeedSessionAsync("o", "r", 10, SubmitEndpointsTestContext.ValidSession());
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/10/submit", new { verdict = "Comment" });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        await TestPoll.UntilAsync(() => ctx.Bus.Published.OfType<SubmitForeignPendingReviewBusEvent>().Any(), PipelineWait);
        var ev = ctx.Bus.Published.OfType<SubmitForeignPendingReviewBusEvent>().Single();
        ev.PullRequestReviewId.Should().Be("PRR_foreign");
        ev.ThreadCount.Should().Be(1);
        ev.ReplyCount.Should().Be(1);
        ctx.Submitter.FinalizeCalled.Should().BeFalse("the pipeline stops at the foreign-pending-review prompt");
    }

    // ----------------------------------------- POST /submit/foreign-pending-review/resume

    [Fact]
    public async Task PostResume_TOCTOU_pass_imports_threads_and_replies_as_drafts_returns_200_with_snapshot()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.OwnPendingReview = Snapshot(
            "PRR_x", commitOid: "anchsha", line: 2,
            threadBody: "thread body\n\n<!-- prism:client-id:olddraft -->",
            replies: ("PRRC_c1", "reply body"));
        ctx.PrReader.FileContents[("src/Foo.cs", "anchsha")] = "line1\nline2\nline3\n";
        await ctx.SeedSessionAsync("o", "r", 1, SubmitEndpointsTestContext.EmptySession());
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/1/submit/foreign-pending-review/resume", new { pullRequestReviewId = "PRR_x" });

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("pullRequestReviewId").GetString().Should().Be("PRR_x");
        body.GetProperty("threadCount").GetInt32().Should().Be(1);
        body.GetProperty("replyCount").GetInt32().Should().Be(1);
        body.GetProperty("threads").GetArrayLength().Should().Be(1);
        body.GetProperty("threads")[0].GetProperty("id").GetString().Should().Be("PRRT_t1");
        body.GetProperty("threads")[0].GetProperty("isResolved").GetBoolean().Should().BeFalse();
        body.GetProperty("threads")[0].GetProperty("body").GetString().Should().Be("thread body");  // marker stripped

        var session = await ctx.LoadSessionAsync("o", "r", 1);
        session!.DraftComments.Should().ContainSingle();
        session.DraftComments[0].ThreadId.Should().Be("PRRT_t1");
        session.DraftComments[0].AnchoredLineContent.Should().Be("line2");  // 1-indexed slice at OriginalCommitOid
        session.DraftComments[0].Status.Should().Be(DraftStatus.Draft);
        session.DraftComments[0].BodyMarkdown.Should().Be("thread body");
        session.DraftReplies.Should().ContainSingle();
        session.DraftReplies[0].ReplyCommentId.Should().Be("PRRC_c1");
        session.DraftReplies[0].ParentThreadId.Should().Be("PRRT_t1");
        session.PendingReviewId.Should().Be("PRR_x");
    }

    [Fact]
    public async Task PostResume_TOCTOU_409_when_pending_review_vanished()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.OwnPendingReview = null;
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/2/submit/foreign-pending-review/resume", new { pullRequestReviewId = "PRR_x" });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("pending-review-state-changed");
    }

    [Fact]
    public async Task PostResume_TOCTOU_409_when_pending_review_id_mismatch()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.OwnPendingReview = Snapshot("PRR_different");
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/3/submit/foreign-pending-review/resume", new { pullRequestReviewId = "PRR_x" });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task PostResume_file_fetch_fails_imports_draft_stale()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.OwnPendingReview = Snapshot("PRR_x", commitOid: "missingsha", line: 5);
        // PrReader.FileContents has no entry for ("src/Foo.cs", "missingsha") → NotFound.
        await ctx.SeedSessionAsync("o", "r", 4, SubmitEndpointsTestContext.EmptySession());
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/4/submit/foreign-pending-review/resume", new { pullRequestReviewId = "PRR_x" });

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var session = await ctx.LoadSessionAsync("o", "r", 4);
        session!.DraftComments.Should().ContainSingle();
        session.DraftComments[0].Status.Should().Be(DraftStatus.Stale);
    }

    // ----------------------------------------- POST /submit/foreign-pending-review/discard

    [Fact]
    public async Task PostDiscard_TOCTOU_pass_deletes_pending_review_and_clears_session_returns_200()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.OwnPendingReview = Snapshot("PRR_x");
        await ctx.SeedSessionAsync("o", "r", 1, SubmitEndpointsTestContext.ValidSession() with { PendingReviewId = "PRR_x", PendingReviewCommitOid = "head1" });
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/1/submit/foreign-pending-review/discard", new { pullRequestReviewId = "PRR_x" });

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        ctx.Submitter.DeletedPendingReviews.Should().Contain("PRR_x");
        var session = await ctx.LoadSessionAsync("o", "r", 1);
        session!.PendingReviewId.Should().BeNull();
        session.PendingReviewCommitOid.Should().BeNull();
    }

    [Fact]
    public async Task PostDiscard_TOCTOU_409_when_pending_review_changed()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.OwnPendingReview = null;
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/2/submit/foreign-pending-review/discard", new { pullRequestReviewId = "PRR_x" });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("pending-review-state-changed");
    }

    [Fact]
    public async Task PostDiscard_github_delete_failure_returns_502_and_leaves_session_untouched()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.OwnPendingReview = Snapshot("PRR_x");
        ctx.Submitter.DeletePendingReviewException = new HttpRequestException("network");
        await ctx.SeedSessionAsync("o", "r", 3, SubmitEndpointsTestContext.ValidSession() with { PendingReviewId = "PRR_x", PendingReviewCommitOid = "head1" });
        using var client = ctx.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/pr/o/r/3/submit/foreign-pending-review/discard", new { pullRequestReviewId = "PRR_x" });

        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase)).GetProperty("code").GetString().Should().Be("delete-failed");
        // The pending-review reference is NOT cleared — a re-detect on the next submit re-prompts.
        (await ctx.LoadSessionAsync("o", "r", 3))!.PendingReviewId.Should().Be("PRR_x");
    }
}
