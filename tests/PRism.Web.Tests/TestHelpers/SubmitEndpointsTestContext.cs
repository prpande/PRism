using System.Net.Http;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

using PRism.Core;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;

namespace PRism.Web.Tests.TestHelpers;

// Per-test harness for the S5 PR3 submit endpoints. Builds a PRismWebApplicationFactory-derived
// server (so DataDir / wwwroot stub / Test env / session token are all set up) with the four
// touchpoints replaced by controllable doubles: IReviewSubmitter (TestReviewSubmitter),
// IPrReader (TestPrReader), IReviewEventBus (FakeReviewEventBus — records published events),
// IActivePrCache (AllSubscribedActivePrCache). State is seeded through the real file-backed
// IAppStateStore. New one per test; dispose deletes the temp DataDir.
internal sealed class SubmitEndpointsTestContext : IDisposable
{
    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;

    public TestReviewSubmitter Submitter { get; } = new();
    public TestPrReader PrReader { get; } = new();
    public FakeReviewEventBus Bus { get; } = new();
    public AllSubscribedActivePrCache ActivePrCache { get; } = new();
    public ListLoggerProvider Logs { get; } = new();

    private SubmitEndpointsTestContext()
    {
        _base = new PRismWebApplicationFactory();
        _derived = _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IReviewSubmitter>();
            s.AddSingleton<IReviewSubmitter>(Submitter);
            s.RemoveAll<IPrReader>();
            s.AddSingleton<IPrReader>(PrReader);
            s.RemoveAll<IReviewEventBus>();
            s.AddSingleton<IReviewEventBus>(Bus);
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(ActivePrCache);
            s.AddSingleton<ILoggerProvider>(Logs);
        }));
        // Force server (and DataDir/state.json) creation.
        _ = _derived.Services;
    }

    public static SubmitEndpointsTestContext Create() => new();

    public IAppStateStore StateStore => _derived.Services.GetRequiredService<IAppStateStore>();

    // Default tabId matches the "tab-test" key used in ValidSession() / EmptySession() so the
    // submit-gate per-tab lookup (TabStamps[callerTabId]) finds the seeded stamp. Tests that
    // exercise the tab-id-missing path pass `tabId: null` (NOT `""`) to suppress the header
    // entirely — empty-string was tried first but DefaultRequestHeaders.Add behavior on empty
    // values is brittle across HttpClient versions; an explicit null is cleaner.
    public HttpClient CreateClient(string? tabId = "tab-test") =>
        _derived.CreateAuthenticatedClient(tabId);

    public async Task SeedSessionAsync(string owner, string repo, int number, ReviewSessionState session)
    {
        var key = $"{owner}/{repo}/{number}";
        await StateStore.UpdateAsync(state =>
        {
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [key] = session };
            return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
        }, CancellationToken.None).ConfigureAwait(false);
    }

    public async Task<ReviewSessionState?> LoadSessionAsync(string owner, string repo, int number)
    {
        var state = await StateStore.LoadAsync(CancellationToken.None).ConfigureAwait(false);
        return state.Reviews.Sessions.TryGetValue($"{owner}/{repo}/{number}", out var s) ? s : null;
    }

    // A valid in-flight session: one line-anchored draft, a Comment verdict, head sha matching
    // TestPrReader.HeadSha so rule (f) passes when ActivePrCache.Current is set. V7 unification —
    // the legacy `DraftSummaryMarkdown: "summary"` is gone; rule (e) is satisfied by the line-
    // anchored draft alone, so dropping the summary preserves intent for the broad sweep of tests
    // that don't read the PR-level body.
    public static ReviewSessionState ValidSession(string headSha = "head1") => new(
        TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp(headSha, DateTime.UtcNow.AddMinutes(-1)) }, LastSeenCommentId: null,
        PendingReviewId: null, PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: new List<DraftComment>
        {
            new("d1", "src/Foo.cs", 42, "RIGHT", new string('a', 40), "the line", "body", DraftStatus.Draft, false),
        },
        DraftReplies: Array.Empty<DraftReply>(),
        DraftVerdict: DraftVerdict.Comment,
        DraftVerdictStatus: DraftVerdictStatus.Draft);

    public static ReviewSessionState EmptySession(string headSha = "head1") => new(
        TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp(headSha, DateTime.UtcNow.AddMinutes(-1)) }, LastSeenCommentId: null,
        PendingReviewId: null, PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: Array.Empty<DraftComment>(),
        DraftReplies: Array.Empty<DraftReply>(),
        DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);

    public void Dispose()
    {
        _derived.Dispose();
        _base.Dispose();
    }
}
