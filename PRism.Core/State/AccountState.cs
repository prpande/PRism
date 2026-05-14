namespace PRism.Core.State;

/// <summary>
/// Per-account slice of state. v1 has one entry under <see cref="AccountKeys.Default"/>.
/// v2 may add more entries; the dictionary topology in <see cref="AppState.Accounts"/> is
/// advisory (spec § 7) so v2 may restructure with a V5→V6 migration if it chooses.
/// </summary>
public sealed record AccountState(
    PrSessionsState Reviews,
    AiState AiState,
    string? LastConfiguredGithubHost)
{
    public static AccountState Default { get; } = new(
        Reviews: PrSessionsState.Empty,
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null);
}
