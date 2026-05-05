using System;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Hosting;

public enum OSPlatform { Windows, MacOS, Linux }

public sealed record ProcessStart(string FileName, string? Arguments = null, bool UseShellExecute = false);

public interface IProcessRunner
{
    void Start(ProcessStart spec);
}

public sealed class SystemProcessRunner : IProcessRunner
{
    public void Start(ProcessStart spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        var psi = new ProcessStartInfo(spec.FileName)
        {
            UseShellExecute = spec.UseShellExecute,
        };
        if (spec.Arguments is not null) psi.Arguments = spec.Arguments;
        Process.Start(psi);
    }
}

public sealed class BrowserLauncher : IBrowserLauncher
{
    private readonly IProcessRunner _runner;
    private readonly OSPlatform _platform;

    public BrowserLauncher(IProcessRunner runner, OSPlatform platform)
    {
        _runner = runner;
        _platform = platform;
    }

    public static OSPlatform CurrentPlatform()
        => OperatingSystem.IsWindows() ? OSPlatform.Windows
            : OperatingSystem.IsMacOS() ? OSPlatform.MacOS
            : OSPlatform.Linux;

    [SuppressMessage("Design", "CA1031:Do not catch general exception types",
        Justification = "Browser launch failures must not prevent app startup; the caller is expected to log the URL to stdout regardless of launch outcome.")]
    [SuppressMessage("Design", "CA1054:URI-like parameters should not be strings",
        Justification = "Launch accepts a string URL because callers build the URL via composition (host + port) and the underlying OS shell APIs (open, xdg-open, ShellExecute) all consume strings.")]
    public void Launch(string url)
    {
        try
        {
            switch (_platform)
            {
                case OSPlatform.Windows:
                    _runner.Start(new ProcessStart(url, UseShellExecute: true));
                    break;
                case OSPlatform.MacOS:
                    _runner.Start(new ProcessStart("open", Arguments: url));
                    break;
                case OSPlatform.Linux:
                    _runner.Start(new ProcessStart("xdg-open", Arguments: url));
                    break;
            }
        }
        catch (Exception)
        {
            // Caller is expected to log the URL to stdout regardless of launch outcome.
        }
    }
}
