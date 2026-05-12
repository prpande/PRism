using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using FluentAssertions;

using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// Spec § 4 / § 17 #28 — PUT /draft rejects user bodies containing the literal
// `<!-- prism:client-id:` substring outside fenced code blocks (it would confuse the submit
// pipeline's lost-response adoption matcher); a marker inside a fence renders as literal text
// and is accepted.
public class PrDraftEndpointsMarkerCollisionTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public PrDraftEndpointsMarkerCollisionTests(PRismWebApplicationFactory factory) { _factory = factory; }

    private System.Net.Http.HttpClient Client()
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", "tab-marker");
        return c;
    }

    private static object NewComment(string body) => new
    {
        newDraftComment = new
        {
            filePath = "src/Foo.cs",
            lineNumber = 1,
            side = "right",
            anchoredSha = new string('a', 40),
            anchoredLineContent = "x",
            bodyMarkdown = body,
        },
    };

    [Fact]
    public async Task PutDraft_body_with_marker_prefix_outside_fence_returns_400_marker_prefix_collision()
    {
        var resp = await Client().PutAsJsonAsync("/api/pr/o/r/1/draft", NewComment("before <!-- prism:client-id:fake --> after"));

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("code").GetString().Should().Be("marker-prefix-collision");
        body.GetProperty("message").GetString().Should().ContainEquivalentOf("internal marker");
    }

    [Fact]
    public async Task PutDraft_body_with_marker_inside_fence_is_accepted()
    {
        var resp = await Client().PutAsJsonAsync("/api/pr/o/r/2/draft", NewComment("```\n<!-- prism:client-id:literal -->\n```"));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task PutDraft_summary_with_marker_prefix_returns_400()
    {
        var resp = await Client().PutAsJsonAsync("/api/pr/o/r/3/draft", new { draftSummaryMarkdown = "see <!-- prism:client-id:x --> for details" });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("marker-prefix-collision");
    }

    [Fact]
    public async Task PutDraft_reply_with_marker_prefix_returns_400()
    {
        var resp = await Client().PutAsJsonAsync("/api/pr/o/r/4/draft", new
        {
            newDraftReply = new { parentThreadId = "PRRT_abc", bodyMarkdown = "<!-- prism:client-id:y -->" },
        });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("marker-prefix-collision");
    }
}
