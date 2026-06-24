namespace PRism.Core.Contracts;

// Precedence-resolved merge-readiness of a PR, derived server-side from GitHub's
// mergeable / mergeStateStatus / reviewDecision signals (see MergeReadinessRule).
// Serializes kebab-case ("behind-base", "ready-with-changes-requested", ...) via the
// global JsonStringEnumConverter(KebabCaseJsonNamingPolicy) on JsonSerializerOptionsFactory.Api.
// `None` is the zero value: Draft / Unknown / null / unrecognized / no-push-access all map
// here, and the frontend renders NO badge for None/Merged/Closed (open-PR-only badge, D5).
public enum MergeReadiness
{
    None,
    Merged,
    Closed,
    Conflicts,
    BehindBase,
    ChangesRequested,
    ReviewRequired,
    BlockedByProtection,
    Unstable,
    ReadyWithChangesRequested,
    Ready,
}
