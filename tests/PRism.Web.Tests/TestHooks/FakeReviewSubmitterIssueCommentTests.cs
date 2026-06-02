using System.Net;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.Web.TestHooks;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class FakeReviewSubmitterIssueCommentTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    [Fact]
    public async Task FakeReviewSubmitter_CreateIssueComment_records_the_comment()
    {
        var fake = new FakeReviewSubmitter();

        var result = await fake.CreateIssueCommentAsync(Ref, "Hello PR root", CancellationToken.None);

        Assert.True(result.Id > 0);
        Assert.Single(fake.IssueCommentsCreated);
        Assert.Equal(Ref, fake.IssueCommentsCreated[0].Pr);
        Assert.Equal("Hello PR root", fake.IssueCommentsCreated[0].Body);
    }

    [Fact]
    public async Task FakeReviewSubmitter_InjectFailure_throws_before_recording()
    {
        var fake = new FakeReviewSubmitter();
        var injected = new HttpRequestException("GitHub 403", inner: null, HttpStatusCode.Forbidden);
        fake.InjectFailure(nameof(FakeReviewSubmitter.CreateIssueCommentAsync), injected, afterEffect: false);

        await Assert.ThrowsAsync<HttpRequestException>(
            () => fake.CreateIssueCommentAsync(Ref, "body", CancellationToken.None));

        // pre-effect failure: comment must NOT have been recorded
        Assert.Empty(fake.IssueCommentsCreated);
    }

    [Fact]
    public async Task FakeReviewSubmitter_InjectFailure_afterEffect_throws_after_recording()
    {
        var fake = new FakeReviewSubmitter();
        var injected = new HttpRequestException("lost response", inner: null, HttpStatusCode.InternalServerError);
        fake.InjectFailure(nameof(FakeReviewSubmitter.CreateIssueCommentAsync), injected, afterEffect: true);

        await Assert.ThrowsAsync<HttpRequestException>(
            () => fake.CreateIssueCommentAsync(Ref, "body", CancellationToken.None));

        // after-effect: comment IS recorded even though exception was thrown (lost-response window)
        Assert.Single(fake.IssueCommentsCreated);
    }

    [Fact]
    public async Task FakeReviewSubmitter_Reset_clears_IssueCommentsCreated()
    {
        var fake = new FakeReviewSubmitter();
        await fake.CreateIssueCommentAsync(Ref, "first", CancellationToken.None);

        fake.Reset();

        Assert.Empty(fake.IssueCommentsCreated);
    }

    [Fact]
    public async Task FakeReviewSubmitter_MultipleComments_each_get_unique_Id()
    {
        var fake = new FakeReviewSubmitter();

        var r1 = await fake.CreateIssueCommentAsync(Ref, "first", CancellationToken.None);
        var r2 = await fake.CreateIssueCommentAsync(Ref, "second", CancellationToken.None);

        Assert.NotEqual(r1.Id, r2.Id);
        Assert.Equal(2, fake.IssueCommentsCreated.Count);
    }
}
