using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;

namespace PRism.Core.Tests.Submit.Pipeline;

// Pins the shape of the SubmitPipeline value types (spec § 5.1): the five-step enum, the four
// SubmitOutcome variants, and the SubmitProgressEvent payload. A rename or dropped variant fails
// here rather than as an opaque downstream compile break.
public class PipelineTypesTests
{
    [Fact]
    public void SubmitStep_EnumHasFiveValues()
    {
        Assert.Equal(5, Enum.GetValues<SubmitStep>().Length);
    }

    [Fact]
    public void SubmitOutcome_HasFourVariants()
    {
        var session = new ReviewSessionState(
            LastViewedHeadSha: null, LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(),
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null, DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
        var snapshot = new OwnPendingReviewSnapshot("PRR_x", "head", DateTimeOffset.UtcNow, new List<PendingReviewThreadSnapshot>());

        SubmitOutcome o1 = new SubmitOutcome.Success("PRR_x");
        SubmitOutcome o2 = new SubmitOutcome.Failed(SubmitStep.AttachThreads, "boom", session);
        SubmitOutcome o3 = new SubmitOutcome.ForeignPendingReviewPromptRequired(snapshot);
        SubmitOutcome o4 = new SubmitOutcome.StaleCommitOidRecreating("PRR_orphan", "stale_oid");

        Assert.IsType<SubmitOutcome.Success>(o1);
        Assert.IsType<SubmitOutcome.Failed>(o2);
        Assert.IsType<SubmitOutcome.ForeignPendingReviewPromptRequired>(o3);
        Assert.IsType<SubmitOutcome.StaleCommitOidRecreating>(o4);
    }

    [Fact]
    public void SubmitProgressEvent_CarriesStepStatusDoneTotal()
    {
        var ev = new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, 2, 5);
        Assert.Equal(SubmitStep.AttachThreads, ev.Step);
        Assert.Equal(SubmitStepStatus.Succeeded, ev.Status);
        Assert.Equal(2, ev.Done);
        Assert.Equal(5, ev.Total);
        Assert.Null(ev.ErrorMessage);
    }
}
