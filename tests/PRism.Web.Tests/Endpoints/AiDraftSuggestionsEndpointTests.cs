using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Spec § 3.2 + § 5.4. The /ai/draft-suggestions endpoint resolves
// IDraftSuggester (existing seam, parallel to IFileFocusRanker /
// IHunkAnnotator). Noop → empty list → 204; Placeholder → canned
// DraftSuggestion[] → 200.
public class AiDraftSuggestionsEndpointTests
{
    [Fact]
    public async Task Get_ai_draft_suggestions_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/draft-suggestions", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_draft_suggestions_returns_200_with_placeholder_entries_when_aiPreview_is_on()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/draft-suggestions", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetArrayLength().Should().BeGreaterThan(0);
        var first = body[0];
        first.GetProperty("filePath").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("lineNumber").GetInt32().Should().BeGreaterThan(0);
        first.GetProperty("body").GetString().Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Get_ai_draft_suggestions_returns_401_without_session_token()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/draft-suggestions", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Get_ai_draft_suggestions_returns_anchor_from_PlaceholderData()
    {
        // Pins the cross-file invariant: PlaceholderData.DraftSuggestions[0]
        // must contain the canned PR's stale-draft anchor. If Task 1 forgets to
        // update PlaceholderDraftSuggester to delegate to PlaceholderData (or
        // forgets the lineNumber replacement), this test catches it before the
        // cohort demo silently breaks.
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/draft-suggestions", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var first = body[0];
        // The seam must return the path AND line number Task 1 set: src/Calc.cs:3.
        // - If filePath drifts: PlaceholderDraftSuggester is still emitting hardcoded
        //   data instead of reading PlaceholderData.
        // - If lineNumber drifts: the suggestionFor key lookup `src/Calc.cs:N` won't
        //   match the canned stale-draft fixture (anchored at line 3 in Calc.cs's
        //   `Add` method body — see FakeReviewBackingStore + parity-fixture.ts),
        //   silently breaking cohort demos + the Playwright sweep.
        first.GetProperty("filePath").GetString().Should().Be("src/Calc.cs");
        first.GetProperty("lineNumber").GetInt32().Should().Be(3);
    }
}
