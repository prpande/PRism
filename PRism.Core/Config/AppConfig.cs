using System.Diagnostics.CodeAnalysis;
using PRism.Core.State;

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
        new GithubConfig(new[]
        {
            new GithubAccountConfig(
                Id: AccountKeys.Default,
                Host: "https://github.com",
                Login: null,
                LocalWorkspace: null)
        }),
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

public sealed record GithubConfig(IReadOnlyList<GithubAccountConfig> Accounts)
{
    // Read delegate properties — preserved so existing AppConfig.Github.Host /
    // AppConfig.Github.LocalWorkspace call sites compile unchanged. v2 removes these when
    // host-dependent DI registrations gain per-account awareness.
    //
    // NB: not marked [Obsolete] in v1 (spec § 11, plan-time decision 3). There is nothing
    // for callers to migrate to until v2 ships the parameterized interfaces; [Obsolete]
    // would flood the build with warnings under TreatWarningsAsErrors at zero benefit.
    public string Host => Accounts[0].Host;
    public string? LocalWorkspace => Accounts[0].LocalWorkspace;
}

public sealed record LlmConfig();
