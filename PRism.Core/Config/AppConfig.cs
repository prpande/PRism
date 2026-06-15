using System.Diagnostics.CodeAnalysis;
using PRism.Core.Ai;
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
        new InboxConfig(true, new InboxSectionsConfig(true, true, true, true, true), true, 14),
        new ReviewConfig(true, true),
        new IterationsConfig(60, ClusteringDisabled: false),
        new LoggingConfig("info", true, 30),
        // #283 flipped the out-of-the-box AI default Off → Preview (preview summaries on,
        // zero egress). P1 keeps consent unrecorded (None) and every per-feature gate on
        // (AllOn): Live egress still demands explicit opt-in + per-provider consent on top
        // of this default. ContentScale "m" (#135) carried in from the merged base.
        new UiConfig("system", "indigo", new AiConfig(AiMode.Preview, AiConsentConfig.None, AiFeaturesConfig.AllOn), "comfortable", "m"),
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
    bool ShowHiddenScopeFooter,
    int RecentlyClosedWindowDays = 14,
    string DefaultSort = "updated",
    // #275 user-customizable order of the four WORK sections. recently-closed is
    // deliberately absent — it is an archive pinned to the bottom in the frontend,
    // never part of the reorderable/persisted order. Validated as a permutation of
    // these four ids in ConfigStore.PatchAsync.
    string SectionOrder = "review-requested,awaiting-author,authored-by-me,mentioned",
    // #283 the activity rail (a non-AI inbox panel) was previously gated on the
    // AI-preview toggle (useAiGate('inboxRanking')); #283 decoupled it onto this
    // dedicated flag, default OFF. #137 then wired it to the real /api/activity
    // endpoint and surfaced it as a Settings toggle (InboxPane). A trailing-defaulted
    // param, so the positional `new InboxConfig(true, …, 14)` default construction
    // stays valid.
    bool ShowActivityRail = false,
    // #219 user toggle to switch the Inbox between grouped-by-repo (default) and flat
    // rendering. A pure frontend-render preference — it does NOT reshape the backend
    // feed. A trailing-defaulted param so the positional
    // `new InboxConfig(true, …, 14)` default construction stays valid.
    bool GroupByRepo = true,
    // #137 additive extra bot logins for the activity rail, comma-separated, matched
    // case-insensitively on top of the built-in `Copilot` baseline and the `[bot]`
    // suffix. Default empty. Settings UI tracked separately in #316. Appended LAST so
    // the positional `new InboxConfig(true, …, 14)` default construction stays valid.
    string KnownBots = "");
public sealed record InboxSectionsConfig(
    bool ReviewRequested,
    bool AwaitingAuthor,
    bool AuthoredByMe,
    bool Mentioned,
    bool RecentlyClosed = true);
public sealed record ReviewConfig(bool BlockSubmitOnStaleDrafts, bool RequireVerdictReconfirmOnNewIteration);
public sealed record IterationsConfig(int ClusterGapSeconds, bool ClusteringDisabled = false);
public sealed record LoggingConfig(string Level, bool StateEvents, int StateEventsRetentionFiles);
public sealed record UiConfig(string Theme, string Accent, AiConfig Ai, string Density = "comfortable", string ContentScale = "m");

/// <summary>AI mode config (spec §4). Persisted at <c>ui.ai.mode</c>. <paramref name="HunkAnnotationCap"/>
/// (#414) bounds the per-PR hunk-annotation count. <paramref name="ProviderTimeoutSeconds"/> (#496) is the
/// user-configurable Claude CLI provider timeout, read hot per AI call and clamped to
/// <see cref="AiConfigBounds"/>. Both are trailing-defaulted params so existing positional
/// <c>new AiConfig(Mode, Consent, Features)</c> call sites (AppConfig.Default + test fixtures) keep
/// compiling. STJ-net10 honors the constructor default for a missing key (proven by
/// ConfigStoreHunkAnnotationCapTests.Missing_cap_key_binds_to_the_constructor_default). The annotator
/// clamps a non-positive cap to 10 on read.</summary>
public sealed record AiConfig(
    AiMode Mode,
    AiConsentConfig Consent,
    AiFeaturesConfig Features,
    int HunkAnnotationCap = 10,
    int ProviderTimeoutSeconds = 240);

public sealed record GithubConfig(IReadOnlyList<GithubAccountConfig> Accounts)
{
    // Read delegate properties — preserved so existing AppConfig.Github.Host /
    // AppConfig.Github.LocalWorkspace call sites compile unchanged. v2 removes these when
    // host-dependent DI registrations gain per-account awareness.
    //
    // NB: not marked [Obsolete] in v1 (spec § 11, plan-time decision 3). There is nothing
    // for callers to migrate to until v2 ships the parameterized interfaces; [Obsolete]
    // would flood the build with warnings under TreatWarningsAsErrors at zero benefit.
    //
    // Empty-Accounts guard: production load paths backfill the default account
    // (ConfigStore.ReadFromDiskAsync's null/empty-Accounts check + AppConfig.Default's
    // seeded entry), so Accounts[0] is safe in v1's runtime. Test code or future v2 code
    // constructing `new GithubConfig([])` directly would otherwise propagate an
    // IndexOutOfRangeException — surface a clear InvalidOperationException at the call
    // site instead. Caught by claude[bot] post-open code review on PR #53.
    public string Host => RequireDefaultAccount().Host;
    public string? LocalWorkspace => RequireDefaultAccount().LocalWorkspace;

    private GithubAccountConfig RequireDefaultAccount() =>
        Accounts.Count > 0
            ? Accounts[0]
            : throw new InvalidOperationException(
                "GithubConfig has no accounts; v1 requires at least one entry under " +
                "AccountKeys.Default. Use AppConfig.Default.Github or supply a populated " +
                "Accounts list.");
}

public sealed record LlmConfig();
