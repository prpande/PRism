using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using PRism.GitHub;
using PRism.GitHub.Tests.Integration.Helpers;

namespace PRism.GitHub.Tests.Integration;

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

    public void Dispose() => _sp.Dispose();
}

internal sealed class InMemoryConfigStoreForIntegrationTests : IConfigStore
{
    public AppConfig Current { get; } = AppConfig.Default;
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
