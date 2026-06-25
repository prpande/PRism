// PRism.GitHub/Inbox/GitHubCheckClassifier.cs
using System.Text.Json;
using PRism.Core.Contracts;

namespace PRism.GitHub.Inbox;

/// <summary>
/// Pure classification of GitHub check-run / commit-status JSON into PRism's normalized shape.
/// SHARED between <see cref="GitHubCiFailingDetector"/> (folds into the 4-state rollup) and
/// GitHubPrChecksReader (keeps verbatim per-check). No HTTP, no cache. The rules encode ~5 issues
/// of edge cases (#213/#264/#286/#305) — sharing prevents silent drift on the next fix.
/// </summary>
internal static class GitHubCheckClassifier
{
    /// <summary>Raw check-run element → normalized. The non-terminal rule is a CATCH-ALL
    /// (status != "completed"), NOT an allowlist — covers queued/in_progress and any future
    /// non-terminal status (waiting/requested/pending). queued is preserved as a finer label.</summary>
    public static (CheckRunStatus Status, CheckConclusion? Conclusion) ClassifyCheckRun(JsonElement run)
    {
        var status = run.GetProperty("status").GetString();
        if (status != "completed")
            return (status == "queued" ? CheckRunStatus.Queued : CheckRunStatus.InProgress, null);

        var raw = run.TryGetProperty("conclusion", out var cn) ? cn.GetString() : null;
        return (CheckRunStatus.Completed, MapConclusion(raw));
    }

    /// <summary>A single combined-status statuses[] entry → normalized. READER-ONLY:
    /// the detector reads the server-computed rollup `state`, not per-entry contexts.</summary>
    public static (CheckRunStatus Status, CheckConclusion? Conclusion) ClassifyStatusContext(JsonElement ctx)
    {
        var state = ctx.TryGetProperty("state", out var s) ? s.GetString() : null;
        return state switch
        {
            "success" => (CheckRunStatus.Completed, CheckConclusion.Success),
            "failure" or "error" => (CheckRunStatus.Completed, CheckConclusion.Failure),
            "pending" => (CheckRunStatus.InProgress, null),
            _ => (CheckRunStatus.Completed, CheckConclusion.Neutral),
        };
    }

    /// <summary>Whether a combined-status payload has ≥1 registered context. SHARED — the #286 guard.
    /// A registered context surfaces as a positive total_count OR a non-empty inline statuses[].</summary>
    public static bool HasRegisteredStatuses(JsonElement root)
    {
        var hasStatuses = root.TryGetProperty("statuses", out var statuses)
            && statuses.ValueKind == JsonValueKind.Array
            && statuses.GetArrayLength() > 0;
        var hasCount = root.TryGetProperty("total_count", out var count)
            && count.ValueKind == JsonValueKind.Number
            && count.TryGetInt32(out var n)
            && n > 0;
        return hasStatuses || hasCount;
    }

    private static CheckConclusion? MapConclusion(string? raw) => raw switch
    {
        "success" => CheckConclusion.Success,
        "failure" => CheckConclusion.Failure,
        "timed_out" => CheckConclusion.TimedOut,
        "cancelled" => CheckConclusion.Cancelled,
        "action_required" => CheckConclusion.ActionRequired,
        "skipped" => CheckConclusion.Skipped,
        "neutral" => CheckConclusion.Neutral,
        "stale" => CheckConclusion.Stale,
        "startup_failure" => CheckConclusion.StartupFailure,
        _ => null, // null/empty/unknown completed conclusion → no positive/negative signal
    };
}
