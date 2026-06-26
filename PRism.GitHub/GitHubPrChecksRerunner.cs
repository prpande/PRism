using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.GitHub;

/// <summary>Write path for the Checks tab: SHA-guard then rerequest a check-run.
/// Mirrors GitHubPrChecksReader's HTTP/token substrate but owns its status→outcome
/// map (do NOT reuse the reader's DegradedFor — rerequest's 403/422 are overloaded).</summary>
public sealed class GitHubPrChecksRerunner : IPrChecksRerunner
{
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
            // 1) SHA guard — GET the check-run, compare head_sha. A stale-but-completed id
            //    would otherwise 2xx-rerun the superseded commit's check (a silent wrong-action).
            var getUrl = $"repos/{pr.Owner}/{pr.Repo}/check-runs/{checkRunId}";
            using var getResp = await GitHubHttp.SendAsync(http, HttpMethod.Get, getUrl, token, ct).ConfigureAwait(false);
            GitHubHttp.ThrowIfRateLimited(getResp);
            if (!getResp.IsSuccessStatusCode)
                return new RerunResultDto(OutcomeFor(getResp.StatusCode));

            var body = await getResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            var headSha = doc.RootElement.TryGetProperty("head_sha", out var hs)
                && hs.ValueKind == JsonValueKind.String ? hs.GetString() : null;
            if (!string.Equals(headSha, expectedHeadSha, StringComparison.OrdinalIgnoreCase))
                return new RerunResultDto(RerunOutcome.Superseded);

            // 2) Rerequest — no body (GitHub takes no parameters).
            var postUrl = $"repos/{pr.Owner}/{pr.Repo}/check-runs/{checkRunId}/rerequest";
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

    // Write-path mapping (distinct from the reader's DegradedFor): 401 = auth;
    // 403/404/422 = not-rerunnable (overloaded — scope OR not-rerunnable state);
    // everything else = transient.
    private static RerunOutcome OutcomeFor(HttpStatusCode code) => code switch
    {
        HttpStatusCode.Unauthorized => RerunOutcome.Auth,
        HttpStatusCode.Forbidden => RerunOutcome.NotRerunnable,
        HttpStatusCode.NotFound => RerunOutcome.NotRerunnable,
        HttpStatusCode.UnprocessableEntity => RerunOutcome.NotRerunnable,
        _ => RerunOutcome.Transient,
    };
}
