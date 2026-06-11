namespace PRism.Core.Auth;

/// <summary>
/// Process-global health of the stored GitHub credential. Flips invalid after
/// <see cref="Threshold"/> consecutive authenticated 401s (so a lone transient
/// 401 cannot raise the non-dismissible re-auth banner) and clears on any
/// authenticated 2xx or an explicit (re)connect commit. Live process state — no
/// persistence; a restart re-validates on the first GitHub call. See
/// docs/specs/2026-06-10-312-github-reauth-surface-design.md §6.1.
/// </summary>
public interface IGitHubCredentialHealth
{
    bool IsInvalid { get; }
    int Epoch { get; }
    void RecordAuthFailure();
    void MarkValid();
    void BumpEpoch();
}

public sealed class GitHubCredentialHealth : IGitHubCredentialHealth
{
    private const int Threshold = 2;
    private readonly object _gate = new();
    private bool _invalid;
    private int _epoch;
    private int _consecutive401;

    public bool IsInvalid { get { lock (_gate) return _invalid; } }
    public int Epoch { get { lock (_gate) return _epoch; } }

    public void RecordAuthFailure()
    {
        lock (_gate)
        {
            if (_consecutive401 < Threshold) _consecutive401++;
            if (_consecutive401 >= Threshold) _invalid = true;
        }
    }

    public void MarkValid()
    {
        lock (_gate)
        {
            _consecutive401 = 0;
            _invalid = false;
        }
    }

    public void BumpEpoch()
    {
        lock (_gate) _epoch++;
    }
}
