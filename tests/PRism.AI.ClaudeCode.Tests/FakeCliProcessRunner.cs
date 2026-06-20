using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

/// <summary>Captures the spec the provider built and returns a canned result, OR throws a
/// supplied exception (to simulate a missing CLI). Never spawns a process.</summary>
public sealed class FakeCliProcessRunner : ICliProcessRunner
{
    private readonly ProcessResult? _result;
    private readonly Exception? _throw;
    public ProcessSpec? Captured { get; private set; }

    public FakeCliProcessRunner(ProcessResult result) => _result = result;
    public FakeCliProcessRunner(Exception toThrow) => _throw = toThrow;

    public Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken ct)
    {
        Captured = spec;
        return _throw is not null
            ? Task.FromException<ProcessResult>(_throw)
            : Task.FromResult(_result!);
    }
}
