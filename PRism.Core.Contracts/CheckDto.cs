using System;
using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

/// <summary>One unified per-check shape from either the check-runs or the legacy combined-status source.</summary>
[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "DetailsUrl is a raw URL string from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "DetailsUrl is a raw URL string from the GitHub API.")]
public sealed record CheckDto(
    string Name,                  // check-run "name" / status "context"
    CheckRunStatus Status,        // queued | in-progress | completed
    CheckConclusion? Conclusion,  // null while non-terminal
    string Source,                // "check-run" | "status" (no duration for "status")
    DateTimeOffset? StartedAt,    // check-runs only; null for legacy status
    DateTimeOffset? CompletedAt,  // check-runs only
    string? DetailsUrl,           // sanitized https-only; else null
    string? Summary,              // check-run "output.title" / status "description"; null if absent
    string? AppName);             // check-run "app.name" (e.g. "GitHub Actions"); null for legacy status
