using System.Net;

namespace PRism.GitHub.Tests.TestHelpers;

/// <summary>
/// Routes requests by path-prefix to scripted responses. Each rule can yield
/// successive pages; on each match, the next page is returned and a Link
/// <c>rel="next"</c> header is emitted for non-last pages so the caller's
/// pagination loop terminates correctly.
/// </summary>
internal sealed class PaginatedFakeHandler : HttpMessageHandler
{
    private readonly List<Rule> _rules = new();

    public PaginatedFakeHandler RouteJson(string pathPrefix, params string[] pages)
    {
        _rules.Add(new Rule(pathPrefix, pages.Select(p => (HttpStatusCode.OK, p)).ToList()));
        return this;
    }

    public PaginatedFakeHandler RouteStatus(string pathPrefix, HttpStatusCode status, string body = "{}")
    {
        _rules.Add(new Rule(pathPrefix, new List<(HttpStatusCode, string)> { (status, body) }));
        return this;
    }

    public int CallCountFor(string pathPrefix) =>
        _rules.FirstOrDefault(r => r.PathPrefix == pathPrefix)?.Index ?? 0;

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(req);
        var path = req.RequestUri!.AbsolutePath;
        // Match by longest prefix so e.g. "/pulls/1/files" wins over "/pulls/1".
        var rule = _rules
            .Where(r => path.StartsWith(r.PathPrefix, StringComparison.Ordinal))
            .OrderByDescending(r => r.PathPrefix.Length)
            .FirstOrDefault();
        if (rule is null) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json"),
        });

        if (rule.Index >= rule.Pages.Count)
        {
            // Over-call: returning an empty 200 here would mask pagination bugs (e.g.,
            // a caller that ignores Link rel="next" exhaustion and keeps requesting
            // would silently see []). 500 makes the bug loud at test time. If a test
            // genuinely needs "infinite empty pages," it should script enough explicit
            // pages or call ResetIndices() between phases.
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError)
            {
                Content = new StringContent(
                    $"{{\"error\":\"PaginatedFakeHandler: route '{rule.PathPrefix}' has no more scripted pages (index {rule.Index} >= {rule.Pages.Count}).\"}}",
                    System.Text.Encoding.UTF8, "application/json"),
            });
        }

        var (status, body) = rule.Pages[rule.Index];
        var hasNext = rule.Index + 1 < rule.Pages.Count && status == HttpStatusCode.OK;
        rule.Index++;

        var resp = new HttpResponseMessage(status)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
        };
        if (hasNext)
        {
            resp.Headers.TryAddWithoutValidation("Link",
                $"<https://api.github.com{rule.PathPrefix}?page={rule.Index + 1}>; rel=\"next\"");
        }
        return Task.FromResult(resp);
    }

    private sealed class Rule
    {
        public string PathPrefix { get; }
        public List<(HttpStatusCode, string)> Pages { get; }
        public int Index { get; set; }
        public Rule(string prefix, List<(HttpStatusCode, string)> pages) { PathPrefix = prefix; Pages = pages; }
    }
}
