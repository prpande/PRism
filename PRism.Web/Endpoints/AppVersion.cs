using System.Reflection;

namespace PRism.Web.Endpoints;

// Authoritative build version for the feedback context. Reads the
// InformationalVersion set in PRism.Web.csproj. SDK may append "+<git-sha>".
internal static class AppVersion
{
    public static string Current { get; } =
        typeof(AppVersion).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(AppVersion).Assembly.GetName().Version?.ToString()
        ?? "unknown";
}
