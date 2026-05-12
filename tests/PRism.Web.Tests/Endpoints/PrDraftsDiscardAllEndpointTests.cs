using System.Net;
using System.Net.Http;
using System.Net.Http.Json;

using FluentAssertions;

using PRism.Core.Events;
using PRism.Core.State;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// Spec § 13 — POST /api/pr/{ref}/drafts/discard-all (closed/merged-PR bulk-discard).
public class PrDraftsDiscardAllEndpointTests
{
    private static ReviewSessionState SessionWithDraftsAndPending(string? pendingReviewId = null) =>
        SubmitEndpointsTestContext.ValidSession() with
        {
            PendingReviewId = pendingReviewId,
            PendingReviewCommitOid = pendingReviewId is null ? null : "head1",
            DraftReplies = new List<DraftReply> { new("rep1", "PRRT_x", null, "reply", DraftStatus.Draft, false) },
        };

    [Fact]
    public async Task PostDiscardAll_clears_session_state_returns_200()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, SessionWithDraftsAndPending());
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/o/r/1/drafts/discard-all", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var session = await ctx.LoadSessionAsync("o", "r", 1);
        session!.DraftComments.Should().BeEmpty();
        session.DraftReplies.Should().BeEmpty();
        session.DraftSummaryMarkdown.Should().BeNull();
        session.DraftVerdict.Should().BeNull();
        session.PendingReviewId.Should().BeNull();
        session.PendingReviewCommitOid.Should().BeNull();
    }

    [Fact]
    public async Task PostDiscardAll_pending_review_set_fires_courtesy_delete()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 2, SessionWithDraftsAndPending(pendingReviewId: "PRR_del"));
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/o/r/2/drafts/discard-all", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        ctx.Submitter.DeletedPendingReviews.Should().Contain("PRR_del");
        ctx.Bus.Published.OfType<SubmitOrphanCleanupFailedBusEvent>().Should().BeEmpty();
    }

    [Fact]
    public async Task PostDiscardAll_courtesy_delete_failure_publishes_orphan_cleanup_failed_and_still_clears()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.DeletePendingReviewException = new HttpRequestException("network");
        await ctx.SeedSessionAsync("o", "r", 3, SessionWithDraftsAndPending(pendingReviewId: "PRR_del"));
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/o/r/3/drafts/discard-all", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);  // courtesy failure does not block
        var session = await ctx.LoadSessionAsync("o", "r", 3);
        session!.DraftComments.Should().BeEmpty();
        session.PendingReviewId.Should().BeNull();
        ctx.Bus.Published.OfType<SubmitOrphanCleanupFailedBusEvent>().Should().ContainSingle();
    }
}
