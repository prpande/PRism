using System.Diagnostics;

namespace PRism.GitHub.Tests.Integration.Helpers;

[DebuggerDisplay("[REDACTED]")]
public readonly struct RedactedSecret : IFormattable, IEquatable<RedactedSecret>
{
    private readonly string _value;

    public RedactedSecret(string value)
    {
        _value = value ?? throw new ArgumentNullException(nameof(value));
    }

    /// <summary>Exposes the raw value for use at the single sink that needs it (HTTP Authorization header).</summary>
    /// <remarks>
    /// Intentionally a METHOD, not a property — properties get auto-enumerated by FluentAssertions'
    /// object-graph formatter and by IDE debugger visualizers, which would leak the value through
    /// the "redacting" wrapper. Reflection-based property enumeration returns nothing for a method.
    /// </remarks>
    public string Reveal() => _value;

    public override string ToString() => "[REDACTED]";

    public string ToString(string? format, IFormatProvider? formatProvider) => "[REDACTED]";

    // Equality members satisfy CA1815 (struct value-type contract). Comparison is by underlying value;
    // PRism does not require constant-time comparison for PATs (no other code path in this repo defends
    // against timing side channels on secrets), so ordinary string equality is acceptable here.
    public bool Equals(RedactedSecret other) => string.Equals(_value, other._value, StringComparison.Ordinal);

    public override bool Equals(object? obj) => obj is RedactedSecret other && Equals(other);

    public override int GetHashCode() => _value?.GetHashCode(StringComparison.Ordinal) ?? 0;

    public static bool operator ==(RedactedSecret left, RedactedSecret right) => left.Equals(right);

    public static bool operator !=(RedactedSecret left, RedactedSecret right) => !left.Equals(right);
}

public static class GhCliPat
{
    private static readonly Lazy<RedactedSecret> _cached = new(Resolve);

    /// <summary>Returns the PAT for the test run. Cached for the test session.</summary>
    public static RedactedSecret Get() => _cached.Value;

    private static RedactedSecret Resolve()
    {
        // CI path: PRISM_INTEGRATION_PAT env var.
        var fromEnv = Environment.GetEnvironmentVariable("PRISM_INTEGRATION_PAT");
        if (!string.IsNullOrWhiteSpace(fromEnv)) return new RedactedSecret(fromEnv);

        // Local path: gh CLI.
        using var p = new Process
        {
            StartInfo = new ProcessStartInfo("gh", "auth token --hostname github.com")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            }
        };
        p.Start();
        var token = p.StandardOutput.ReadToEnd().Trim();
        p.WaitForExit(5_000);
        if (p.ExitCode != 0 || string.IsNullOrWhiteSpace(token))
        {
            throw new InvalidOperationException(
                "No PRISM_INTEGRATION_PAT env var and `gh auth token` failed. " +
                "Run `gh auth login --scopes \"repo,read:org\"` (or set the env var with a " +
                "fine-grained PAT scoped to prpande/PRism) and retry.");
        }
        return new RedactedSecret(token);
    }

    /// <summary>
    /// Activation predicate for capture mode. Spec § 7 — exact-string "1" equality, NOT
    /// IsNullOrEmpty negation. Pinning the predicate here so a future refactor that
    /// loosens the check (e.g. !string.IsNullOrEmpty) doesn't silently demote the
    /// CI write-protection layer 1 (the `PRISM_FROZEN_PR_CAPTURE_FIXTURE: ''` line in
    /// .github/workflows/integration-tests.yml relies on this exact-match semantics).
    /// </summary>
    public static bool IsCaptureModeEnabled(string? value) => value == "1";

    public static bool IsCaptureModeEnabled() =>
        IsCaptureModeEnabled(Environment.GetEnvironmentVariable("PRISM_FROZEN_PR_CAPTURE_FIXTURE"));

    /// <summary>
    /// Spec § 7 layer 2 — throws when capture mode is requested AND the process is running
    /// inside CI (GitHub Actions / Azure Pipelines / generic CI runners all set `CI`).
    /// Either layer is sufficient; together they're defence-in-depth.
    /// </summary>
    public static void EnsureCaptureModeNotInCi(string? captureValue, string? ciValue)
    {
        var captureRequested = IsCaptureModeEnabled(captureValue);
        var inCi = !string.IsNullOrWhiteSpace(ciValue);
        if (captureRequested && inCi)
        {
            throw new InvalidOperationException(
                "Capture mode is disabled in CI to prevent silent fixture rewrites. " +
                "Run locally with PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 to refresh.");
        }
    }

    public static void EnsureCaptureModeNotInCi() =>
        EnsureCaptureModeNotInCi(
            Environment.GetEnvironmentVariable("PRISM_FROZEN_PR_CAPTURE_FIXTURE"),
            Environment.GetEnvironmentVariable("CI"));
}
