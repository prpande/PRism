using System.Net;
using PRism.Core.Auth;

namespace PRism.GitHub;

/// <summary>
/// Observes responses on the named "github" HttpClient and feeds
/// <see cref="IGitHubCredentialHealth"/>: an authenticated github.com 401 records a
/// failure (flipping invalid at the threshold); an authenticated 2xx clears it.
/// Never alters the response. See spec §6.2. github.com-only this slice (§11).
/// </summary>
public sealed class GitHubAuthHealthHandler : DelegatingHandler
{
    public static readonly HttpRequestOptionsKey<bool> SkipHealthKey =
        new("prism-skip-credential-health");

    private readonly IGitHubCredentialHealth _health;

    public GitHubAuthHealthHandler(IGitHubCredentialHealth health) => _health = health;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var epochBefore = _health.Epoch;
        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

        // Candidate-token validation probes opt out (§6.3).
        if (request.Options.TryGetValue(SkipHealthKey, out var skip) && skip)
        {
            return response;
        }

        // Only an authenticated request speaks to the stored token's validity.
        if (request.Headers.Authorization is null)
        {
            return response;
        }

        // Detection is github.com-only this slice (§11).
        if (!HostUrlResolver.IsGitHubDotCom(request.RequestUri))
        {
            return response;
        }

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            // Ignore a 401 from a token already replaced mid-flight (epoch moved).
            if (_health.Epoch == epochBefore)
            {
                _health.RecordAuthFailure();
            }
        }
        else if (response.IsSuccessStatusCode)
        {
            // Not staleness-guarded: a 2xx that was in flight before the token was
            // revoked could briefly clear a latch two later 401s had set. This
            // self-heals — the next authenticated call with the now-bad token 401s
            // and re-accumulates toward the threshold within a poll cadence. Strict
            // monotonicity isn't worth the added sequencing on a self-correcting edge.
            _health.MarkValid();
        }

        return response;
    }
}
