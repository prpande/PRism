namespace PRism.Core.Contracts;

// Minimum-viable shape for IPrReader.GetCommitAsync. The S4 PR3 reconciliation
// path only uses presence (`commit is not null`) to detect "is this SHA reachable from
// the PR's commit graph"; richer fields (author, message, committed-at) can be added
// later without breaking existing callers.
public sealed record CommitInfo(string Sha);
