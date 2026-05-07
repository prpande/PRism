using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Config;

[SuppressMessage("Naming", "CA1724:Type names should not match namespaces",
    Justification = "Conflict is with Microsoft.Identity.Client.AppConfig — an internal MSAL namespace not exposed at PRism boundaries; renaming PRism's AppConfig domain type is not warranted.")]
public sealed record AppConfig(
    PollingConfig Polling,
    InboxConfig Inbox,
    ReviewConfig Review,
    IterationsConfig Iterations,
    LoggingConfig Logging,
    UiConfig Ui,
    GithubConfig Github,
    LlmConfig Llm)
{
    public static AppConfig Default => new(
        new PollingConfig(30, 120),
        new InboxConfig(true, new InboxSectionsConfig(true, true, true, true, true), true),
        new ReviewConfig(true, true),
        new IterationsConfig(60, ClusteringDisabled: false),
        new LoggingConfig("info", true, 30),
        new UiConfig("system", "indigo", false),
        new GithubConfig("https://github.com", null),
        new LlmConfig());
}

public sealed record PollingConfig(int ActivePrSeconds, int InboxSeconds);
public sealed record InboxConfig(
    bool Deduplicate,
    InboxSectionsConfig Sections,
    bool ShowHiddenScopeFooter);
public sealed record InboxSectionsConfig(
    bool ReviewRequested,
    bool AwaitingAuthor,
    bool AuthoredByMe,
    bool Mentioned,
    bool CiFailing);
public sealed record ReviewConfig(bool BlockSubmitOnStaleDrafts, bool RequireVerdictReconfirmOnNewIteration);
public sealed record IterationsConfig(int ClusterGapSeconds, bool ClusteringDisabled = false);
public sealed record LoggingConfig(string Level, bool StateEvents, int StateEventsRetentionFiles);
public sealed record UiConfig(string Theme, string Accent, bool AiPreview);
public sealed record GithubConfig(string Host, string? LocalWorkspace);
public sealed record LlmConfig();
