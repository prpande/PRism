namespace PRism.AI.ClaudeCode;

/// <summary>Testable shell-out seam. The provider builds a <see cref="ProcessSpec"/> and never
/// touches <c>System.Diagnostics</c> directly, so tests can assert the spec without spawning.</summary>
public interface ICliProcessRunner
{
    Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken ct);
}
