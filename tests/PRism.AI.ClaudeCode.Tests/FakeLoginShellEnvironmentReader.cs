using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

/// <summary>Returns a canned <see cref="LoginShellCapture"/> (or null), and counts calls so a test
/// can assert single-flight (one capture under concurrent callers).</summary>
public sealed class FakeLoginShellEnvironmentReader : ILoginShellEnvironmentReader
{
    private readonly LoginShellCapture? _capture;
    public int CallCount { get; private set; }

    public FakeLoginShellEnvironmentReader(LoginShellCapture? capture) => _capture = capture;

    public Task<LoginShellCapture?> CaptureAsync(TimeSpan timeout, CancellationToken ct)
    {
        CallCount++;
        return Task.FromResult(_capture);
    }
}
