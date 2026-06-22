using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class FakeClaudeCliLocator : IClaudeCliLocator
{
    private readonly ClaudeCliResolution _resolution;
    public int InvalidateCount { get; private set; }

    public FakeClaudeCliLocator(ClaudeCliResolution resolution) => _resolution = resolution;

    public Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct) => Task.FromResult(_resolution);
    public ClaudeCliResolution? CurrentResolved => _resolution as ResolvedCli;
    public void InvalidateResolved() => InvalidateCount++;
}
