using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.GitHub;

/// <summary>Write path for the Checks tab: SHA-guard then re-run a check-run.
/// GitHub Actions check-runs do NOT support <c>check-runs/{id}/rerequest</c> — that endpoint
/// 404s for an Actions run (it is for check-runs created by third-party GitHub Apps). Actions
/// runs re-run via the Actions jobs API; the check-run maps to its job through
/// <c>details_url</c> (<c>.../runs/{run}/job/{job}</c>, and the job id equals the check-run id).
/// So we GET the check-run once (also the SHA guard), then dispatch by the creating app:
/// Actions → <c>actions/jobs/{job}/rerun</c>, any other App → <c>check-runs/{id}/rerequest</c>.
/// Owns its own status→outcome map (do NOT reuse the reader's DegradedFor — 403/422 are overloaded).</summary>
public sealed partial class GitHubPrChecksRerunner : IPrChecksRerunner
{
    private const string GitHubActionsAppSlug = "github-actions";

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;

    public GitHubPrChecksRerunner(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<RerunResultDto> RerunAsync(
        PrReference pr, long checkRunId, string expectedHeadSha, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(pr);
        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");

        try
        {
            // 1) SHA guard + dispatch info — GET the check-run. A stale-but-completed id would
            //    otherwise re-run the superseded commit's check (a silent wrong-action). The same
            //    payload tells us which re-run API to call (app slug + details_url → job id).
            var getUrl = $"repos/{pr.Owner}/{pr.Repo}/check-runs/{checkRunId}";
            using var getResp = await GitHubHttp.SendAsync(http, HttpMethod.Get, getUrl, token, ct).ConfigureAwait(false);
            GitHubHttp.ThrowIfRateLimited(getResp);
            if (!getResp.IsSuccessStatusCode)
                return new RerunResultDto(OutcomeFor(getResp.StatusCode));

            var body = await getResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;

            var headSha = root.TryGetProperty("head_sha", out var hs) && hs.ValueKind == JsonValueKind.String
                ? hs.GetString() : null;
            if (!string.Equals(headSha, expectedHeadSha, StringComparison.OrdinalIgnoreCase))
                return new RerunResultDto(RerunOutcome.Superseded);

            var appSlug = root.TryGetProperty("app", out var app)
                && app.ValueKind == JsonValueKind.Object
                && app.TryGetProperty("slug", out var slug) && slug.ValueKind == JsonValueKind.String
                ? slug.GetString() : null;

            // 2) Re-run. GitHub Actions check-runs 404 on rerequest; re-run the underlying job.
            string postUrl;
            if (string.Equals(appSlug, GitHubActionsAppSlug, StringComparison.OrdinalIgnoreCase))
            {
                var detailsUrl = root.TryGetProperty("details_url", out var du) && du.ValueKind == JsonValueKind.String
                    ? du.GetString() : null;
                var jobId = JobIdFrom(detailsUrl) ?? checkRunId; // Actions: check-run id == job id
                postUrl = $"repos/{pr.Owner}/{pr.Repo}/actions/jobs/{jobId}/rerun";
            }
            else
            {
                // Third-party GitHub App check-run — rerequest forwards a check_run webhook to it.
                postUrl = $"repos/{pr.Owner}/{pr.Repo}/check-runs/{checkRunId}/rerequest";
            }

            using var postResp = await GitHubHttp.SendAsync(http, HttpMethod.Post, postUrl, token, ct).ConfigureAwait(false);
            GitHubHttp.ThrowIfRateLimited(postResp);
            return new RerunResultDto(
                postResp.IsSuccessStatusCode ? RerunOutcome.Accepted : OutcomeFor(postResp.StatusCode));
        }
        catch (HttpRequestException)
        {
            return new RerunResultDto(RerunOutcome.Transient);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new RerunResultDto(RerunOutcome.Transient); // request timeout, not a user cancel
        }
    }

    // Actions check-run details_url is https://github.com/{o}/{r}/actions/runs/{run}/job/{job}.
    // The trailing job id is the Actions jobs-API target. Returns null when absent/unparseable;
    // the caller then falls back to the check-run id (equal to the job id for Actions check-runs).
    private static long? JobIdFrom(string? detailsUrl)
    {
        if (string.IsNullOrEmpty(detailsUrl)) return null;
        var m = JobUrlRegex().Match(detailsUrl);
        return m.Success && long.TryParse(m.Groups[1].Value, out var id) ? id : null;
    }

    [GeneratedRegex(@"/job/(\d+)", RegexOptions.CultureInvariant)]
    private static partial Regex JobUrlRegex();

    // Write-path mapping (distinct from the reader's DegradedFor): 401 = auth;
    // 403/404/422 = not-rerunnable (overloaded — scope OR not-rerunnable state, e.g. an Actions
    // run too old to re-run); everything else = transient.
    private static RerunOutcome OutcomeFor(HttpStatusCode code) => code switch
    {
        HttpStatusCode.Unauthorized => RerunOutcome.Auth,
        HttpStatusCode.Forbidden or HttpStatusCode.NotFound or HttpStatusCode.UnprocessableEntity
            => RerunOutcome.NotRerunnable,
        _ => RerunOutcome.Transient,
    };
}
