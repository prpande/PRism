using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Hosting;

public interface IBrowserLauncher
{
    [SuppressMessage("Design", "CA1054:URI-like parameters should not be strings",
        Justification = "Launch accepts a string URL because callers build the URL via composition (host + port) and the underlying OS shell APIs (open, xdg-open, ShellExecute) all consume strings.")]
    void Launch(string url);
}
