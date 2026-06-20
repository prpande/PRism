using System.Runtime.Versioning;
using System.Security.Principal;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// §2.1 invariant: the sidecar must run as the interactive OS user whose credential store the CLI
/// reads — a service identity would have a different profile and could inherit a different login.
/// BCL-only (no P/Invoke): Windows rejects well-known service SIDs; POSIX best-effort rejects root.
/// Full owner-UID match against ~/.claude is a NAMED follow-up; the Electron+sidecar desktop model
/// runs as the logged-in user, so the residual gap is low-risk.
/// </summary>
public static class ClaudeIdentity
{
    /// <summary>True when the current process runs as an interactive (non-service, non-root) user.</summary>
    public static bool SameOsUserAsCredentialStore()
    {
        if (OperatingSystem.IsWindows())
            return IsInteractiveWindowsUser();
        return !string.Equals(Environment.UserName, "root", StringComparison.Ordinal);
    }

    /// <summary>Pure classifier: is this SID a Windows service / virtual-service account (vs an
    /// interactive user)? Exposed for direct unit testing without depending on the test host's
    /// identity.</summary>
    public static bool IsServiceSid(string sidValue)
    {
        ArgumentNullException.ThrowIfNull(sidValue);
        return sidValue is "S-1-5-18" or "S-1-5-19" or "S-1-5-20"
            || sidValue.StartsWith("S-1-5-82-", StringComparison.OrdinalIgnoreCase);
    }

    [SupportedOSPlatform("windows")]
    private static bool IsInteractiveWindowsUser()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User;
        return sid is not null && !IsServiceSid(sid.Value);
    }
}
