using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace PRism.Core.Auth;

[SuppressMessage("Naming", "CA1716:Identifiers should not match keywords",
    Justification = "Get/Set are idiomatic for this simple provider; the interface is internal-facing and not exposed to VB consumers.")]
public interface IViewerLoginProvider
{
    string Get();
    void Set(string login);
}

public sealed partial class ViewerLoginProvider : IViewerLoginProvider
{
    private string _login = string.Empty;
    private readonly ILogger<ViewerLoginProvider> _log;

    public ViewerLoginProvider(ILogger<ViewerLoginProvider>? log = null)
    {
        _log = log ?? NullLogger<ViewerLoginProvider>.Instance;
    }

    public string Get() => Volatile.Read(ref _login);

    public void Set(string login)
    {
        Volatile.Write(ref _login, login);
        Log.LoginSet(_log, string.IsNullOrEmpty(login) ? "(empty)" : login);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug, Message = "Viewer-login cache set to '{Login}'")]
        internal static partial void LoginSet(ILogger logger, string login);
    }
}
