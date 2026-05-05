namespace PRism.Core.Config;

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
        new InboxConfig(true),
        new ReviewConfig(true, true),
        new IterationsConfig(60),
        new LoggingConfig("info", true, 30),
        new UiConfig("system", "indigo", false),
        new GithubConfig("https://github.com", null),
        new LlmConfig());
}

public sealed record PollingConfig(int ActivePrSeconds, int InboxSeconds);
public sealed record InboxConfig(bool ShowHiddenScopeFooter);
public sealed record ReviewConfig(bool BlockSubmitOnStaleDrafts, bool RequireVerdictReconfirmOnNewIteration);
public sealed record IterationsConfig(int ClusterGapSeconds);
public sealed record LoggingConfig(string Level, bool StateEvents, int StateEventsRetentionFiles);
public sealed record UiConfig(string Theme, string Accent, bool AiPreview);
public sealed record GithubConfig(string Host, string? LocalWorkspace);
public sealed record LlmConfig();
