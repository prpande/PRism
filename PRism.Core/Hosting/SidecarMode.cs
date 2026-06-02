namespace PRism.Core.Hosting;

/// <summary>
/// Detects whether the backend is running as a managed sidecar of the Electron
/// desktop shell, signalled by environment variables (never CLI flags — env vars
/// are not inspectable via <c>ps</c>/<c>wmic</c> and not trivially spoofable).
/// </summary>
/// <param name="Enabled">True when <c>PRISM_SIDECAR=1</c> is set.</param>
/// <param name="ParentPid">
/// The Electron parent process id from <c>PRISM_PARENT_PID</c>, or null when not in
/// sidecar mode or the value is absent/unparseable.
/// </param>
public sealed record SidecarMode(bool Enabled, int? ParentPid)
{
    /// <summary>
    /// Resolves sidecar mode from an environment lookup. Mode is enabled only when
    /// <c>PRISM_SIDECAR</c> equals the literal <c>"1"</c>. When enabled, an
    /// unparseable or missing <c>PRISM_PARENT_PID</c> yields a null parent pid rather
    /// than throwing — the watchdog treats a null pid as "no parent to monitor."
    /// </summary>
    /// <param name="getEnv">Environment-variable accessor (returns null when unset).</param>
    public static SidecarMode Detect(Func<string, string?> getEnv)
    {
        ArgumentNullException.ThrowIfNull(getEnv);

        var enabled = string.Equals(getEnv("PRISM_SIDECAR"), "1", StringComparison.Ordinal);
        if (!enabled)
        {
            return new SidecarMode(false, null);
        }

        return int.TryParse(getEnv("PRISM_PARENT_PID"), out var pid)
            ? new SidecarMode(true, pid)
            : new SidecarMode(true, null);
    }
}
