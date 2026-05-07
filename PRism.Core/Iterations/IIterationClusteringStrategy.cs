namespace PRism.Core.Iterations;

public interface IIterationClusteringStrategy
{
    IReadOnlyList<IterationCluster> Cluster(
        ClusteringInput input,
        IterationClusteringCoefficients coefficients);
}
