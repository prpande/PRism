using System.Diagnostics;
using System.Text;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// Runs a <see cref="ProcessSpec"/> via <see cref="Process"/>. Builds the child env from the spec's
/// ALLOWLIST only (clears the inherited block first), feeds stdin CONCURRENTLY (so a prompt larger
/// than the OS pipe buffer cannot deadlock the timeout), captures stdout/stderr, and enforces the
/// timeout by killing the process tree. This is the only class that touches System.Diagnostics;
/// real `claude` invocation is validated manually in P1, not here.
/// </summary>
public sealed class SystemCliProcessRunner : ICliProcessRunner
{
    public async Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(spec);

        var psi = new ProcessStartInfo
        {
            FileName = spec.FileName,
            WorkingDirectory = spec.WorkingDirectory,
            RedirectStandardInput = spec.StdinText is not null,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in spec.Arguments)
        {
            psi.ArgumentList.Add(arg);
        }

        psi.Environment.Clear();                 // do not inherit the parent block
        foreach (var (k, v) in spec.Environment)
        {
            psi.Environment[k] = v;
        }

        using var process = new Process { StartInfo = psi };
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) { stdout.AppendLine(e.Data); } };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) { stderr.AppendLine(e.Data); } };

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        // Write stdin CONCURRENTLY — do NOT await before WaitForExit. A prompt larger than the OS
        // pipe buffer (~64 KB) would otherwise block this write until the child drains stdin (which
        // may never happen), and the timeout could not fire.
        // CA2025: `process` (whose StandardInput is IDisposable) is captured by writeTask. The
        // finally below awaits DrainWriteAsync(writeTask) on EVERY exit (normal return, timeout
        // return, AND any propagated exception such as caller cancellation) BEFORE `using var
        // process` disposes — so the task never touches a disposed stream. The analyzer's flow
        // analysis can't prove that across the branching, so suppress with this justification.
#pragma warning disable CA2025
        var writeTask = spec.StdinText is null
            ? Task.CompletedTask
            : WriteStdinAsync(process, spec.StdinText);
#pragma warning restore CA2025

        try
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(spec.Timeout);
            try
            {
                await process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { /* already exited */ }
                return new ProcessResult(-1, stdout.ToString(), stderr.ToString(), TimedOut: true);
            }
            catch (OperationCanceledException)
            {
                // Caller cancelled (ct, not the timeout). Kill the child so an abandoned `claude`
                // call doesn't keep running and consuming credit until a broken pipe, then propagate.
                try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { /* already exited */ }
                throw;
            }

            // Ensure the async stdout/stderr readers have flushed their final lines before we read the
            // builders. The synchronous WaitForExit() returns immediately (the process already exited)
            // but blocks until the redirected-stream readers complete — the documented idiom.
#pragma warning disable CA1849 // Intentional sync drain after WaitForExitAsync; returns immediately post-exit.
            process.WaitForExit();
#pragma warning restore CA1849

            return new ProcessResult(process.ExitCode, stdout.ToString(), stderr.ToString(), TimedOut: false);
        }
        finally
        {
            await DrainWriteAsync(writeTask).ConfigureAwait(false);
        }
    }

    private static async Task WriteStdinAsync(Process process, string text)
    {
        try
        {
            await process.StandardInput.WriteAsync(text).ConfigureAwait(false);
        }
        finally
        {
            process.StandardInput.Close();
        }
    }

    // The child may be killed (timeout) or exit before stdin is fully written, breaking the pipe.
    // That surfaces as IOException on the write/close — swallow it; the process result already
    // reflects the real outcome.
    private static async Task DrainWriteAsync(Task writeTask)
    {
        try { await writeTask.ConfigureAwait(false); }
        catch (IOException) { /* broken pipe — child exited/killed before stdin drained */ }
    }
}
