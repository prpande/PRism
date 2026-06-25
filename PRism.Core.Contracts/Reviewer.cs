using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

// A reviewer surfaced by the merge-readiness popover (#593): an approver, a changes-requester,
// or a still-requested ("waiting on") reviewer. Login doubles as a team name for team review
// requests (GitHub's reviewRequests can target a Team, which has `name` not `login`); AvatarUrl
// is null for teams and for users whose avatar wasn't fetched.
[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
public sealed record Reviewer(string Login, string? AvatarUrl = null);
