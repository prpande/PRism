using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using PRism.GitHub;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration;

/// <summary>
/// xUnit collection definition that pins every test class touching live GitHub into one
/// non-parallel collection. xUnit's default parallelizes test classes within the same
/// assembly on separate threads; for the live-GitHub suite that means four classes
/// (FrozenPrismPrTests + PatScopeContractTests + ShaktimaanAiValidationTests +
/// CanonicalIterationCountTests) hitting GitHub concurrently with four separate DI
/// containers, each amplifying rate-limit pressure and quadrupling DI startup cost.
/// Disabling parallelization at the collection level forces sequential execution + lets the
/// single LiveGitHubFixture instance be reused (via ICollectionFixture on each class) instead
/// of being re-instantiated per class.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
[System.Diagnostics.CodeAnalysis.SuppressMessage("Naming", "CA1711:Identifiers should not have incorrect suffix",
    Justification = "xUnit convention — types implementing ICollectionFixture<T> are named *Collection and matched by name by the [Collection(...)] attribute.")]
public sealed class LiveGitHubCollection : ICollectionFixture<LiveGitHubFixture>
{
    public const string Name = "LiveGitHub";
}

/// <summary>
/// xUnit class fixture that builds a DI container mirroring production wiring
/// (<see cref="ServiceCollectionExtensions.AddPrismGitHub"/> plus the iteration-clustering
/// chain registered in <c>PRism.Core.ServiceCollectionExtensions</c>), and overrides only
/// the token source to point at the locally-cached <c>gh auth token</c> via
/// <see cref="GhCliPat"/>. One container is shared across the test class so DI startup
/// and the named-HttpClient pool amortize across the corpus tests.
///
/// Spec §§ 6.1 + 8 — the fixture lives at the boundary that calls live GitHub; nothing
/// inside the SUT is faked. Any drift between this composition and production wiring is
/// itself a bug the contract suite exists to catch.
/// </summary>
public sealed class LiveGitHubFixture : IDisposable
{
    private readonly ServiceProvider _sp;
    public PrDetailLoader Loader { get; }
    public IPrReader Reader { get; }
    public IReviewAuth Auth { get; }

    public LiveGitHubFixture()
    {
        var services = new ServiceCollection();
        services.AddLogging();

        services.AddSingleton<IConfigStore>(new InMemoryConfigStoreForIntegrationTests());
        services.AddSingleton<ITokenStore>(new GhCliBackedTokenStore());

        // Mirrors PRism.Core/ServiceCollectionExtensions.cs lines 103-108 exactly. Registering
        // WeightedDistanceClusteringStrategy without the two multipliers silently produces
        // neutral 1.0 multipliers on every edge — degenerate clustering with no failure signal.
        services.AddSingleton<IDistanceMultiplier, FileJaccardMultiplier>();
        services.AddSingleton<IDistanceMultiplier, ForcePushMultiplier>();
        services.AddSingleton<IIterationClusteringStrategy>(sp =>
            new WeightedDistanceClusteringStrategy(sp.GetServices<IDistanceMultiplier>()));
        services.AddSingleton(new IterationClusteringCoefficients());
        // PrDetailLoader subscribes to ActivePrUpdated for per-PR cache eviction (#116),
        // so the bus must be registered before the loader resolves.
        services.AddSingleton<IReviewEventBus, ReviewEventBus>();
        services.AddSingleton<PrDetailLoader>();

        services.AddPrismGitHub();

        _sp = services.BuildServiceProvider();
        Loader = _sp.GetRequiredService<PrDetailLoader>();
        Reader = _sp.GetRequiredService<IPrReader>();
        Auth = _sp.GetRequiredService<IReviewAuth>();
    }

    /// <summary>Convenience wrapper for tests that want the parsed DTO, not the snapshot envelope.</summary>
    public async Task<PrDetailDto> LoadPrDetailAsync(FrozenPrEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        var snap = await Loader.LoadAsync(
            new PrReference("prpande", "PRism", entry.PrNumber),
            CancellationToken.None);
        if (snap is null)
        {
            throw new InvalidOperationException(
                $"PrDetailLoader returned null for PR #{entry.PrNumber} — token expired or PR inaccessible.");
        }
        return snap.Detail;
    }

    /// <summary>
    /// Issues the SAME GraphQL query that <see cref="GitHubReviewService.GetPrDetailAsync"/>
    /// issues — using the production <c>PrDetailGraphQLQuery</c> constant (visible here via
    /// InternalsVisibleTo) — and returns the raw response as a <see cref="JsonElement"/>.
    /// Used by test 7g (Frozen_pr_graphql_shape_unchanged) to detect GraphQL schema drift.
    /// </summary>
    /// <remarks>
    /// Uses the same named <c>github</c> <see cref="HttpClient"/> the production code resolves
    /// via <c>AddPrismGitHub</c> — same <c>BaseAddress</c>, same connection pool, same
    /// host resolution. The absolute GraphQL endpoint URL is computed from
    /// <see cref="HostUrlResolver.GraphQlEndpoint"/> (matches the production
    /// <c>PostGraphQLAsync</c> path) to keep parity with how the SUT reaches GitHub.
    /// </remarks>
    public async Task<JsonElement> LoadRawGraphQLResponseAsync(int prNumber, CancellationToken ct = default)
    {
        var factory = _sp.GetRequiredService<IHttpClientFactory>();
        var config = _sp.GetRequiredService<IConfigStore>();
        using var http = factory.CreateClient("github");

        var token = GhCliPat.Get().Reveal();
        var endpoint = HostUrlResolver.GraphQlEndpoint(config.Current.Github.Host);
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint);
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        // Header parity with production PostGraphQLAsync, which sends via GitHubHttp.ApplyHeaders:
        // reference the same GitHubHttp.UserAgent / GitHubHttp.AcceptJson constants the SUT uses so
        // this fixture can never drift to a stale literal. The shape-drift suite must replay those
        // exact headers — otherwise we'd be testing a different request shape than production
        // issues, and GitHub's response-header-driven shape variations (per-Accept content
        // negotiation) would slip past 7g.
        req.Headers.UserAgent.ParseAdd(GitHubHttp.UserAgent);
        req.Headers.Accept.ParseAdd(GitHubHttp.AcceptJson);
        req.Content = JsonContent.Create(new
        {
            query = GitHubReviewService.PrDetailGraphQLQuery,
            variables = new { owner = "prpande", repo = "PRism", number = prNumber }
        });

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            // Sanitized — never echo the Authorization header value back through the exception.
            throw new InvalidOperationException(
                $"GraphQL request to GitHub failed with {(int)resp.StatusCode} for PR #{prNumber}. " +
                "(Authorization header omitted.)");
        }
        var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        return doc.RootElement.Clone();
    }

    public void Dispose() => _sp.Dispose();
}

internal sealed class InMemoryConfigStoreForIntegrationTests : IConfigStore
{
    public AppConfig Current { get; } = AppConfig.Default;
    // Live-GitHub integration tests never read ConfigPath, but the interface requires it (S6 PR1).
    public string ConfigPath { get; } = "/integration/config.json";
    public Exception? LastLoadError => null;
    public Task InitAsync(CancellationToken ct) => Task.CompletedTask;
    public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not patch config.");
    public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) =>
        Task.CompletedTask;
#pragma warning disable CS0067 // Event is never used — the integration fixture never patches config, so the Changed handler is unreachable; PrDetailLoader subscribes to it at construction and we accept the dead handler rather than fire fake events.
    public event EventHandler<ConfigChangedEventArgs>? Changed;
#pragma warning restore CS0067
}

internal sealed class GhCliBackedTokenStore : ITokenStore
{
    public Task<bool> HasTokenAsync(CancellationToken ct) => Task.FromResult(true);
    public Task<string?> ReadAsync(CancellationToken ct) =>
        Task.FromResult<string?>(GhCliPat.Get().Reveal());

    public Task WriteTransientAsync(string token, CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not write transient tokens.");
    public Task SetTransientLoginAsync(string login, CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not set transient logins.");
    public Task<string?> ReadTransientLoginAsync(CancellationToken ct) =>
        Task.FromResult<string?>(null);
    public Task CommitAsync(CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not commit tokens.");
    public Task RollbackTransientAsync(CancellationToken ct) =>
        Task.CompletedTask;
    public Task ClearAsync(CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not clear tokens.");
}
