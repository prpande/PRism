using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

// The latest timeline actor + resolved action for a PR, used to enrich an otherwise
// actorless notification row. AvatarUrl may be null; IsBot reflects the GraphQL actor
// __typename (the builder ORs this with its own [bot]-suffix / built-in detection).
[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "URL string from the GitHub API; System.Uri is unnecessary overhead for wire records (matches ActivityItem).")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "URL string from the GitHub API; System.Uri is unnecessary overhead for wire records (matches ActivityItem).")]
public sealed record TimelineActor(string Login, string? AvatarUrl, bool IsBot, ActivityVerb Verb);

// Batched enrichment: given a set of PRs, return the most-recent timeline actor/action for
// each. Implementations are fault-isolated (degrade-don't-throw): a PR with no resolvable
// actor is simply absent from the result, and a transport/parse failure yields an empty map
// so the caller falls back to actorless notification rows.
public interface IPrTimelineReader
{
    Task<IReadOnlyDictionary<(string Repo, int PrNumber), TimelineActor>> ReadLatestAsync(
        IReadOnlyCollection<(string Repo, int PrNumber)> pullRequests, CancellationToken ct);
}
