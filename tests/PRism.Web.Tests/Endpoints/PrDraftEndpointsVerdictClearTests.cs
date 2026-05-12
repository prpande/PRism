using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;

using FluentAssertions;

using PRism.Core.Json;
using PRism.Core.State;
using PRism.Web.Endpoints;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// Spec § 10 — the JsonElement patch wire-shape makes present-null distinguishable from absent, so
// `{"draftVerdict":null}` clears the verdict (it 400'd under the historic typed-record binding)
// and the same distinction generalises to draftSummaryMarkdown.
public class PrDraftEndpointsVerdictClearTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public PrDraftEndpointsVerdictClearTests(PRismWebApplicationFactory factory) { _factory = factory; }

    private HttpClient Client()
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", "tab-verdict-clear");
        return c;
    }

    private static async Task<HttpResponseMessage> PutRawAsync(HttpClient c, string url, string json)
    {
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        return await c.PutAsync(new Uri(url, UriKind.Relative), content).ConfigureAwait(false);
    }

    private static async Task<ReviewSessionDto?> GetDraftAsync(HttpClient c, string url)
        => await (await c.GetAsync(new Uri(url, UriKind.Relative))).Content.ReadFromJsonAsync<ReviewSessionDto>(JsonSerializerOptionsFactory.Api);

    [Fact]
    public async Task PutDraft_verdict_present_null_clears_the_verdict()
    {
        var c = Client();
        const string url = "/api/pr/o/r/1/draft";
        (await c.PutAsJsonAsync(url, new { draftVerdict = "approve" })).StatusCode.Should().Be(HttpStatusCode.OK);
        (await GetDraftAsync(c, url))!.DraftVerdict.Should().Be(DraftVerdict.Approve);

        var resp = await PutRawAsync(c, url, """{"draftVerdict":null}""");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        (await GetDraftAsync(c, url))!.DraftVerdict.Should().BeNull();
    }

    [Fact]
    public async Task PutDraft_verdict_absent_does_not_change_the_verdict()
    {
        var c = Client();
        const string url = "/api/pr/o/r/2/draft";
        (await c.PutAsJsonAsync(url, new { draftVerdict = "approve" })).StatusCode.Should().Be(HttpStatusCode.OK);

        // Patch a different field — draftVerdict is absent from the body.
        (await c.PutAsJsonAsync(url, new { draftSummaryMarkdown = "new summary" })).StatusCode.Should().Be(HttpStatusCode.OK);

        (await GetDraftAsync(c, url))!.DraftVerdict.Should().Be(DraftVerdict.Approve);
    }

    [Fact]
    public async Task PutDraft_summary_present_null_clears_the_summary()
    {
        var c = Client();
        const string url = "/api/pr/o/r/3/draft";
        (await c.PutAsJsonAsync(url, new { draftSummaryMarkdown = "draft text" })).StatusCode.Should().Be(HttpStatusCode.OK);
        (await GetDraftAsync(c, url))!.DraftSummaryMarkdown.Should().Be("draft text");

        var resp = await PutRawAsync(c, url, """{"draftSummaryMarkdown":null}""");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        (await GetDraftAsync(c, url))!.DraftSummaryMarkdown.Should().BeNull();
    }

    [Fact]
    public async Task PutDraft_unknown_verdict_value_returns_400()
    {
        var resp = await PutRawAsync(Client(), "/api/pr/o/r/4/draft", """{"draftVerdict":"request-changes"}""");
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PutDraft_two_clear_candidates_returns_400()
    {
        // Both scalar kinds present-null and nothing else → ambiguous, rejected.
        var resp = await PutRawAsync(Client(), "/api/pr/o/r/5/draft", """{"draftVerdict":null,"draftSummaryMarkdown":null}""");
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
