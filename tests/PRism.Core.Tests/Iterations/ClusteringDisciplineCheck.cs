using PRism.Core.Iterations;
using Xunit;
using Xunit.Sdk;

namespace PRism.Core.Tests.Iterations;

public class ClusteringDisciplineCheck
{
    [SkippableFact]
    public void Manual_discipline_check_against_real_pr_set()
    {
        var prRefs = Environment.GetEnvironmentVariable("PRISM_DISCIPLINE_PR_REFS");
        Skip.If(prRefs is null, "Set PRISM_DISCIPLINE_PR_REFS to a comma-separated list of org/repo/number to run.");

        // Implementation: for each PR ref, fetch the timeline via IReviewService.GetTimelineAsync,
        // run WeightedDistanceClusteringStrategy.Cluster, print boundaries to stdout for hand-comparison.
        // Test author records results in the spec's § 12 "Discipline-check observations" section.
        // The skipped test is the harness; the recording is manual.

        throw new NotImplementedException(
            "Wire this to IReviewService.GetTimelineAsync once Task 3 lands; until then, the skipped " +
            "fact pins the env-var-gated dispatch shape.");
    }
}
