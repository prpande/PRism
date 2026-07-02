using System.Diagnostics.CodeAnalysis;
using PRism.Core.Contracts;

namespace PRism.Core.Activity;

/// <summary>Actor on a timeline node. Login/avatar are null for actorless/system events.</summary>
[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
public sealed record TimelineActorRef(string? Login, string? AvatarUrl, bool IsBot);

/// <summary>
/// One node in the unified PR activity feed. <paramref name="Body"/> is non-null only for
/// comments and reviews-with-body (rendered as cards); bare state changes leave it null (markers).
/// <paramref name="CommitCount"/> is set on push nodes for grouped rendering; <paramref name="Subject"/>
/// carries a verb-specific target (e.g. the requested reviewer for <see cref="ActivityVerb.ReviewRequested"/>).
/// </summary>
public sealed record TimelineEvent(
    string Id,
    ActivityVerb Verb,
    TimelineActorRef Actor,
    DateTimeOffset Timestamp,
    string? Body,
    int? CommitCount,
    string? Subject);

/// <summary>
/// One newest-first page of the feed. <paramref name="OlderCursor"/> + <paramref name="HasOlder"/>
/// drive "Show older activity" (backward pagination); when <c>HasOlder</c> is false the synthesized
/// <see cref="ActivityVerb.Opened"/> node is the last (oldest) element.
/// <paramref name="Degraded"/> is true when the underlying GitHub read failed (transport/parse) and
/// the reader returned an empty page rather than throwing — this lets the endpoint surface a real
/// error to the SPA instead of an indistinguishable false-empty ("No activity yet") state.
/// </summary>
public sealed record TimelinePage(
    IReadOnlyList<TimelineEvent> Events,
    string? OlderCursor,
    bool HasOlder,
    bool Degraded = false);

/// <summary>Reads a single PR's full activity timeline, newest-first, one page at a time.</summary>
public interface IPrTimelineFeedReader
{
    Task<TimelinePage> ReadPageAsync(PrReference prRef, string? cursor, int pageSize, CancellationToken ct);
}
