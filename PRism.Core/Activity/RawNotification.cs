using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Activity;

// Adapter-agnostic projection of one GitHub notification item. The reader
// (PRism.GitHub) parses JSON into this; the builder (pure) maps it to ActivityItem.
// `Url` is the API subject.url — the builder rewrites it to the html PR url.
[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "Raw URL strings from the GitHub API; System.Uri is unnecessary overhead for wire records.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "Raw URL strings from the GitHub API; System.Uri is unnecessary overhead for wire records.")]
public sealed record RawNotification(
    string Repo, string Reason, int PrNumber, string? Title,
    string Url,                      // subject.url (API) — builder rewrites to the html PR url
    DateTimeOffset Timestamp);

public readonly record struct NotificationsResult(
    IReadOnlyList<RawNotification> Notifications, bool Degraded);

public readonly record struct WatchedReposResult(
    IReadOnlyList<string> Repos, bool Degraded);  // full names "owner/repo"
