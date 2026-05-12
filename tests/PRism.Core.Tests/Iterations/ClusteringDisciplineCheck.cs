using Xunit;

namespace PRism.Core.Tests.Iterations;

public class ClusteringDisciplineCheck
{
    // Two skip guards are intentional and serve different purposes:
    //   1. Env-var guard (line below): the permanent dispatch shape — the harness only
    //      runs when PRISM_DISCIPLINE_PR_REFS is set. This is the steady-state contract.
    //   2. Unconditional skip: temporary, until Task 3 (IPrReader.GetTimelineAsync)
    //      lands. Keeps the harness compilable and pinned without forcing a NotImpl throw
    //      that would surface as a test failure when the env var is set.
    [SkippableFact]
    public void Manual_discipline_check_against_real_pr_set()
    {
        var prRefs = Environment.GetEnvironmentVariable("PRISM_DISCIPLINE_PR_REFS");
        Skip.If(prRefs is null, "Set PRISM_DISCIPLINE_PR_REFS to a comma-separated list of org/repo/number to run.");

        // Implementation: for each PR ref, fetch the timeline via IPrReader.GetTimelineAsync,
        // run WeightedDistanceClusteringStrategy.Cluster, print boundaries to stdout for hand-comparison.
        // Test author records results in the spec's § 12 "Discipline-check observations" section.
        Skip.If(true, "Discipline check awaits Task 3 (IPrReader.GetTimelineAsync); the env-var dispatch shape is pinned, but execution will land with that task.");
    }
}
