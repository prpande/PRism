using FluentAssertions;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiSeamFeatureKeysTests
{
    [Fact]
    public void Summarizer_MapsToSummaryKey()
        => AiSeamFeatureKeys.ForSeam(typeof(IPrSummarizer)).Should().Be("summary");

    [Fact]
    public void EveryNamedSeam_HasAKey()
    {
        Type[] seams =
        {
            typeof(IPrSummarizer), typeof(IFileFocusRanker), typeof(IHunkAnnotator),
            typeof(IPreSubmitValidator), typeof(IComposerAssistant), typeof(IDraftSuggester),
            typeof(IDraftReconciliator), typeof(IInboxItemEnricher), typeof(IInboxRanker),
        };
        foreach (var s in seams)
            AiSeamFeatureKeys.ForSeam(s).Should().NotBeNullOrEmpty();
    }
}
