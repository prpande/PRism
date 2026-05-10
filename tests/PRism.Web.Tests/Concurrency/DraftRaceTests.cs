using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Core.Json;
using PRism.Web.Endpoints;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Concurrency;

public class DraftRaceTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public DraftRaceTests(PRismWebApplicationFactory f) { _factory = f; }

    [Fact]
    public async Task Two_parallel_update_draft_comments_last_writer_wins()
    {
        // Spec § 4.6 says the AppStateStore _gate serializes UpdateAsync so two parallel
        // updates each observe each other's persisted writes (last-writer-wins; no torn
        // reads, no lost writes). This test exercises the integration: two HTTP clients
        // race the same updateDraftComment patch with different bodies. Both should
        // succeed (200), and a subsequent GET must show one of the two body values
        // (whichever wrote last under the gate).
        var setup = MakeClient("tab-setup");
        var newPatch = new ReviewSessionPatch(
            null, null,
            new NewDraftCommentPayload("src/Foo.cs", 42, "right",
                new string('a', 40), "line content", "initial body"),
            null, null, null, null, null, null, null, null, null);
        var newResp = await setup.PutAsJsonAsync("/api/pr/acme/api/2001/draft", newPatch);
        newResp.IsSuccessStatusCode.Should().BeTrue();
        var assigned = await newResp.Content.ReadFromJsonAsync<AssignedIdResponse>(JsonSerializerOptionsFactory.Api);
        var draftId = assigned!.AssignedId;

        var clientA = MakeClient("tab-A");
        var clientB = MakeClient("tab-B");
        var taskA = clientA.PutAsJsonAsync("/api/pr/acme/api/2001/draft",
            new ReviewSessionPatch(null, null, null, null,
                new UpdateDraftCommentPayload(draftId, "body from A"),
                null, null, null, null, null, null, null));
        var taskB = clientB.PutAsJsonAsync("/api/pr/acme/api/2001/draft",
            new ReviewSessionPatch(null, null, null, null,
                new UpdateDraftCommentPayload(draftId, "body from B"),
                null, null, null, null, null, null, null));

        var responses = await Task.WhenAll(taskA, taskB);
        responses[0].IsSuccessStatusCode.Should().BeTrue();
        responses[1].IsSuccessStatusCode.Should().BeTrue();

        var getResp = await clientA.GetAsync(new Uri("/api/pr/acme/api/2001/draft", UriKind.Relative));
        var dto = await getResp.Content.ReadFromJsonAsync<ReviewSessionDto>(JsonSerializerOptionsFactory.Api);
        var draft = dto!.DraftComments.Single(d => d.Id == draftId);
        draft.BodyMarkdown.Should().BeOneOf("body from A", "body from B");
    }

    private HttpClient MakeClient(string tabId)
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", tabId);
        return c;
    }
}
