namespace PRism.AI.ClaudeCode;

/// <summary>
/// The persisted discovery record. Holds ONLY what is needed to rebuild the allowlisted child env
/// (<see cref="Path"/> + <see cref="ManagerVars"/>) plus diagnostics — never the full captured env,
/// so the on-disk file can never carry a value that was not reviewed for on-disk storage.
/// </summary>
public sealed record ClaudeCliStateRecord(
    int SchemaVersion,
    string Platform,
    string ExecutablePath,
    string Path,
    IReadOnlyDictionary<string, string> ManagerVars,
    string? CliVersion,
    DateTimeOffset DiscoveredAt,
    string DiscoverySource);
