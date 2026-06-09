using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Activity;

// Adapter-agnostic projection of one GitHub received_events item. The reader
// (PRism.GitHub) parses JSON into this; the builder (pure) maps it to ActivityItem.
// `Id` is the GitHub event id — the dedup key (re-emitted duplicates share it).
// `IsPullRequestComment` is true only for an IssueCommentEvent whose payload.issue
// carried a pull_request marker (the reader resolves this; PrNumber = issue.number).
[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "Raw URL strings from the GitHub API; System.Uri is unnecessary overhead for wire records.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "Raw URL strings from the GitHub API; System.Uri is unnecessary overhead for wire records.")]
public sealed record RawReceivedEvent(
    string Id,
    string Type,
    string? ActorLogin,
    string? ActorAvatarUrl,
    string Repo,
    string? Action,
    int? PrNumber,
    string? Title,
    string? HtmlUrl,
    bool Merged,
    bool IsPullRequestComment,
    System.DateTimeOffset CreatedAt);

public readonly record struct ReceivedEventsResult(
    IReadOnlyList<RawReceivedEvent> Events,
    bool Degraded);
