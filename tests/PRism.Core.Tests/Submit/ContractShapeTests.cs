using PRism.Core;
using PRism.Core.Submit;

namespace PRism.Core.Tests.Submit;

// Pins the shape of the IReviewSubmitter contract: the record fields the GraphQL adapter and the
// SubmitPipeline both depend on, the SubmitEvent value set, and the seven method names. A future
// rename or dropped method fails CI here rather than surfacing as a downstream compile break with
// no explanation.
public class ContractShapeTests
{
    [Fact]
    public void DraftThreadRequest_CarriesAllRequiredFieldsForGraphQL()
    {
        var req = new DraftThreadRequest(
            DraftId: "draft-1",
            BodyMarkdown: "hello\n\n<!-- prism:client-id:draft-1 -->",
            FilePath: "src/Foo.cs",
            LineNumber: 42,
            Side: "RIGHT");

        Assert.Equal("draft-1", req.DraftId);
        Assert.Equal("hello\n\n<!-- prism:client-id:draft-1 -->", req.BodyMarkdown);
        Assert.Equal("src/Foo.cs", req.FilePath);
        Assert.Equal(42, req.LineNumber);
        Assert.Equal("RIGHT", req.Side);
        Assert.Null(req.StartLine);
        Assert.Null(req.StartSide);
    }

    [Fact]
    public void SubmitEvent_HasThreeValues()
    {
        var values = Enum.GetValues<SubmitEvent>();
        Assert.Equal(3, values.Length);
        Assert.Contains(SubmitEvent.Approve, values);
        Assert.Contains(SubmitEvent.RequestChanges, values);
        Assert.Contains(SubmitEvent.Comment, values);
    }

    [Fact]
    public void IReviewSubmitter_HasSevenMethods()
    {
        var methods = typeof(IReviewSubmitter).GetMethods()
            .Where(m => !m.IsSpecialName)
            .Select(m => m.Name)
            .ToHashSet();

        Assert.Equal(7, methods.Count);
        Assert.Contains("BeginPendingReviewAsync", methods);
        Assert.Contains("AttachThreadAsync", methods);
        Assert.Contains("AttachReplyAsync", methods);
        Assert.Contains("FinalizePendingReviewAsync", methods);
        Assert.Contains("DeletePendingReviewAsync", methods);
        Assert.Contains("DeletePendingReviewThreadAsync", methods);  // multi-marker-match cleanup (Task 16 / Task 29)
        Assert.Contains("FindOwnPendingReviewAsync", methods);
    }
}
