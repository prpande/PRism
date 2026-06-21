namespace PRism.Core.Contracts;

// A PR's lifecycle state, normalized from GitHub's REST (lowercase + separate merged flag)
// and GraphQL (uppercase, literal "MERGED") representations. Serializes kebab-case
// ("open"/"closed"/"merged") via the global JsonStringEnumConverter. `Open` is the zero
// value, so a default-constructed snapshot reads as Open (matches the prior string fall-through).
public enum PrState
{
    Open,
    Closed,
    Merged,
}
