namespace PRism.Web.TestHooks;

// Companion to TestFailureInjectionHandler (sibling file). Stores one-shot failure
// arms keyed on the top-level GraphQL selection-field name (e.g. "addPullRequestReviewThread").
// Engaged only when both ASPNETCORE_ENVIRONMENT=Test and PRISM_E2E_REAL_INJECT=1 are set
// — registration site is Program.cs.
//
// Why field-name key (not C# method name like the fake-side FakeReviewSubmitter): this
// injector sits at the HTTP transport layer below GitHubReviewService, where the C# method
// boundary is not visible — only the outgoing GraphQL request body is. The key space is
// intentionally different from the fake-side because the layers are different.
internal sealed class RealTransportFailureInjector
{
    private readonly object _gate = new();
    private readonly Dictionary<string, (Exception Ex, bool AfterEffect)> _armed = new(StringComparer.Ordinal);

    public void InjectFailure(string graphQLFieldName, Exception ex, bool afterEffect)
    {
        ArgumentException.ThrowIfNullOrEmpty(graphQLFieldName);
        ArgumentNullException.ThrowIfNull(ex);
        lock (_gate) _armed[graphQLFieldName] = (ex, afterEffect);
    }

    // Returns true (and the exception) iff a one-shot is armed for graphQLFieldName whose
    // afterEffect flag equals afterEffectWanted; consumes the arm in that case.
    public bool TryConsume(string graphQLFieldName, bool afterEffectWanted, out Exception ex)
    {
        lock (_gate)
        {
            if (_armed.TryGetValue(graphQLFieldName, out var entry) && entry.AfterEffect == afterEffectWanted)
            {
                _armed.Remove(graphQLFieldName);
                ex = entry.Ex;
                return true;
            }
        }
        ex = null!;
        return false;
    }

    public void Reset()
    {
        lock (_gate) _armed.Clear();
    }
}
