using System.Diagnostics;
using System.Text;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// Real login-shell capture. Spawns <c>$SHELL -ilc</c> with a CLEARED env block carrying only the
/// minimum to locate the shell + its rc files (HOME, USER/LOGNAME, TMPDIR) plus three per-invocation
/// random sentinels; the rc files reconstruct the user's full environment from scratch, and that
/// reconstruction IS the signal. The process spawn is validated MANUALLY in P1 (not CI — same posture
/// as <see cref="SystemCliProcessRunner"/>); the pure <see cref="ParseCapture"/> logic is unit-tested.
/// </summary>
public sealed class SystemLoginShellEnvironmentReader : ILoginShellEnvironmentReader
{
    public async Task<LoginShellCapture?> CaptureAsync(TimeSpan timeout, CancellationToken ct)
    {
        if (OperatingSystem.IsWindows()) return null;   // discovery is Unix-only

        var shell = ResolveShell();
        var s1 = "PRISM_S1_" + Guid.NewGuid().ToString("N");
        var s2 = "PRISM_S2_" + Guid.NewGuid().ToString("N");
        var s3 = "PRISM_S3_" + Guid.NewGuid().ToString("N");
        var snippet =
            "printf '%s\\n' \"$S1\"; command -v claude; printf '%s\\n' \"$S2\"; " +
            "/usr/bin/env; printf '%s\\n' \"$S3\"";

        var psi = new ProcessStartInfo
        {
            FileName = shell,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-ilc");
        psi.ArgumentList.Add(snippet);

        psi.Environment.Clear();   // do NOT inherit the sidecar's env into the rc execution
        CopyIfSet(psi, "HOME");
        CopyIfSet(psi, "USER");
        CopyIfSet(psi, "LOGNAME");
        CopyIfSet(psi, "TMPDIR");
        psi.Environment["S1"] = s1;
        psi.Environment["S2"] = s2;
        psi.Environment["S3"] = s3;

        using var process = new Process { StartInfo = psi };
        var stdout = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { /* rc noise to stderr is discarded */ };

        try
        {
            process.Start();
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;   // shell not launchable → ladder
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);
        try
        {
            await process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Kill the child shell on EITHER cancellation source — a timeout (pathological rc hang)
            // or a caller-cancel (shutdown) — so neither path strands a zombie process tree.
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            if (ct.IsCancellationRequested) throw;   // caller cancelled → propagate
            return null;                             // timeout → fall to the ladder
        }
#pragma warning disable CA1849 // sync drain after WaitForExitAsync returns immediately post-exit
        process.WaitForExit();
#pragma warning restore CA1849

        return ParseCapture(stdout.ToString(), s1, s2, s3);
    }

    private static string ResolveShell()
    {
        // Reads the SIDECAR's $SHELL (not the cleared child env) — this selects which shell binary to spawn.
        var shell = Environment.GetEnvironmentVariable("SHELL");
        if (!string.IsNullOrEmpty(shell) && File.Exists(shell)) return shell;
        foreach (var candidate in new[] { "/bin/zsh", "/bin/bash", "/bin/sh" })
            if (File.Exists(candidate)) return candidate;
        return "/bin/sh";
    }

    private static void CopyIfSet(ProcessStartInfo psi, string key)
    {
        var value = Environment.GetEnvironmentVariable(key);
        if (value is not null) psi.Environment[key] = value;
    }

    /// <summary>Pure parse of the snippet's stdout. Extracts the <c>command -v claude</c> line
    /// between <paramref name="s1"/> and <paramref name="s2"/> and the <c>KEY=VALUE</c> env lines
    /// between <paramref name="s2"/> and <paramref name="s3"/>. Banner/MOTD noise outside the
    /// sentinel-delimited regions is ignored. Returns <c>null</c> when the sentinels are missing or
    /// out of order.</summary>
    internal static LoginShellCapture? ParseCapture(string stdout, string s1, string s2, string s3)
    {
        var lines = stdout.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        int i1 = Array.IndexOf(lines, s1);
        int i2 = Array.IndexOf(lines, s2);
        int i3 = Array.IndexOf(lines, s3);
        if (i1 < 0 || i2 <= i1 || i3 <= i2) return null;

        // command -v claude: the (single) non-empty line between s1 and s2.
        string? commandV = null;
        for (var i = i1 + 1; i < i2; i++)
        {
            if (!string.IsNullOrWhiteSpace(lines[i])) { commandV = lines[i].Trim(); break; }
        }

        var env = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = i2 + 1; i < i3; i++)
        {
            var line = lines[i];
            var eq = line.IndexOf('=', StringComparison.Ordinal);
            if (eq <= 0) continue;                       // not a KEY=VALUE line
            var key = line[..eq];
            // Require a valid POSIX env-var NAME before '='. This rejects interleaved rc output that
            // happens to contain '=' — a prompt-framework status line, a `clear` escape sequence, a
            // colorized banner — from injecting a bogus key or corrupting PATH (spec §8 / P1 noise).
            if (!IsValidEnvKey(key)) continue;
            env[key] = line[(eq + 1)..];                 // value may contain '='
        }

        return new LoginShellCapture(env, commandV);
    }

    private static bool IsValidEnvKey(string key)
    {
        if (key.Length == 0) return false;
        if (!(char.IsAsciiLetter(key[0]) || key[0] == '_')) return false;
        foreach (var c in key)
            if (!(char.IsAsciiLetterOrDigit(c) || c == '_')) return false;
        return true;
    }
}
