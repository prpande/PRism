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
// `{"draftVerdict":null}` clears the verdict (it 400'd under the historic typed-record binding).
// V7 unification dropped draftSummaryMarkdown, so the summary-clear / two-clear-candidates cases
// the historic test file pinned are gone — only draftVerdict remains as a present-null clear kind.
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

        // Patch a different field — draftVerdict is absent from the body. confirmVerdict is a
        // safe stand-in for the dropped draftSummaryMarkdown scalar kind: it's an unrelated op
        // (NoOp here because DraftVerdictStatus is already Draft) that won't touch the verdict.
        (await c.PutAsJsonAsync(url, new { confirmVerdict = true })).StatusCode.Should().Be(HttpStatusCode.OK);

        (await GetDraftAsync(c, url))!.DraftVerdict.Should().Be(DraftVerdict.Approve);
    }

    [Fact]
    public async Task PutDraft_kebab_request_changes_is_accepted_and_round_trips()
    {
        var c = Client();
        const string url = "/api/pr/o/r/3/draft";
        (await c.PutAsJsonAsync(url, new { draftVerdict = "request-changes" })).StatusCode.Should().Be(HttpStatusCode.OK);
        (await GetDraftAsync(c, url))!.DraftVerdict.Should().Be(DraftVerdict.RequestChanges);
    }

    [Theory]
    // Legacy camelCase / PascalCase are rejected post-#318 (kebab is the single canonical form).
    [InlineData("""{"draftVerdict":"requestChanges"}""")]
    [InlineData("""{"draftVerdict":"RequestChanges"}""")]
    [InlineData("""{"draftVerdict":"Approve"}""")]
    [InlineData("""{"draftVerdict":"bogus"}""")]
    // A JSON-integer operand is rejected by the ValueKind==String guard — the converter is not
    // used, so numeric enum ordinals never sneak in.
    [InlineData("""{"draftVerdict":1}""")]
    public async Task PutDraft_non_kebab_verdict_value_returns_400(string body)
    {
        var resp = await PutRawAsync(Client(), "/api/pr/o/r/4/draft", body);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
