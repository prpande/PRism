using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PRism.Core.Ai;

namespace PRism.Web.Ai;

/// <summary>
/// Eagerly resolves <see cref="IAiSeamSelector"/> at host startup so the
/// <c>realSeams</c> dictionary (shared between <see cref="IAiSeamSelector"/> and
/// <see cref="PRism.Core.Ai.AiCapabilityResolver"/>) is populated before any HTTP
/// request can reach <c>/api/capabilities</c>.
///
/// <para>
/// <see cref="IAiSeamSelector"/> is registered as a singleton with a factory that
/// populates <c>realSeams[typeof(IPrSummarizer)]</c> on first resolution. In
/// production the factory runs via the InboxPoller hosted-service startup chain
/// (InboxPoller → IInboxRefreshOrchestrator → IAiSeamSelector), but that chain is
/// implicit: a future refactor could silently re-open the race and make
/// <c>/api/capabilities</c> report <c>summary=false</c> in Live mode until
/// something else first resolves the selector. This warm-up makes the dependency
/// explicit and order-independent.
/// </para>
/// </summary>
internal sealed class AiSeamWarmup : IHostedService
{
    private readonly IServiceProvider _serviceProvider;

    public AiSeamWarmup(IServiceProvider serviceProvider)
    {
        ArgumentNullException.ThrowIfNull(serviceProvider);
        _serviceProvider = serviceProvider;
    }

    /// <summary>
    /// Resolves <see cref="IAiSeamSelector"/>, triggering the DI factory that
    /// populates <c>realSeams</c> — so <c>AiCapabilityResolver</c> can report
    /// <c>summary=true</c> before the first <c>/api/capabilities</c> request arrives.
    /// </summary>
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _serviceProvider.GetRequiredService<IAiSeamSelector>();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
