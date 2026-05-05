using System.Net.Http.Json;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Errors;

public class ProblemDetailsTests
{
    [Fact]
    public async Task Unhandled_exception_returns_problem_details_with_traceId()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/test/boom", UriKind.Relative));
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.InternalServerError);
        resp.Content.Headers.ContentType!.MediaType.Should().Be("application/problem+json");
        var problem = await resp.Content.ReadFromJsonAsync<ProblemResponse>();
        problem.Should().NotBeNull();
        problem!.TraceId.Should().NotBeNullOrEmpty();
    }

    public sealed record ProblemResponse(string? Title, string? TraceId);
}
