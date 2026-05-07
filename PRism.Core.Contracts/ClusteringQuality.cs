namespace PRism.Core.Contracts;

/// <summary>
/// Per-PR clustering confidence signal carried on <see cref="PrDetailDto"/>.
/// <c>Ok</c> means the strategy produced trustworthy iteration boundaries; the frontend
/// renders an iteration-tab strip. <c>Low</c> means the strategy could not cluster the
/// commits (≤ 1 commit, per-PR degenerate detector fired, or
/// <c>iterations.clusteringDisabled</c> globally); the frontend renders a
/// GitHub-style <c>CommitMultiSelectPicker</c>.
/// </summary>
/// <remarks>
/// Wire format: kebab-case lowercase (<c>"ok"</c> | <c>"low"</c>) via the
/// <see cref="System.Text.Json.Serialization.JsonStringEnumConverter"/> wired in
/// <c>JsonSerializerOptionsFactory</c>.
/// </remarks>
public enum ClusteringQuality
{
    Ok,
    Low,
}
