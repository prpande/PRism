using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using PRism.Web.Endpoints;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// #666 — HttpJson.TryReadJsonAsync<T> single-sources the guard for the documented trap that
// ReadFromJsonAsync throws InvalidOperationException (→ unhandled 500), NOT JsonException, on a
// missing/wrong Content-Type. Two endpoints (parse-pr-url, merge) previously hand-rolled it.
public class HttpJsonTests
{
    // public so CA1812 doesn't flag it as an uninstantiated internal type — it's only ever
    // constructed by System.Text.Json deserialization, which the analyzer can't see.
    public sealed record Sample(string? Name);

    private static HttpRequest RequestWith(string? body, string? contentType)
    {
        var ctx = new DefaultHttpContext();
        if (body is not null)
            ctx.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        ctx.Request.ContentType = contentType;
        return ctx.Request;
    }

    [Fact]
    public async Task Reads_a_well_formed_json_body_with_no_error()
    {
        var result = await HttpJson.TryReadJsonAsync<Sample>(
            RequestWith("""{"name":"hi"}""", "application/json"), CancellationToken.None);

        result.Error.Should().Be(JsonReadError.None);
        result.Value.Should().NotBeNull();
        result.Value!.Name.Should().Be("hi");
    }

    [Theory]
    [InlineData("text/plain")]
    [InlineData(null)]
    [InlineData("application/x-www-form-urlencoded")]
    public async Task Reports_WrongContentType_without_reading_the_body(string? contentType)
    {
        var result = await HttpJson.TryReadJsonAsync<Sample>(
            RequestWith("""{"name":"hi"}""", contentType), CancellationToken.None);

        result.Error.Should().Be(JsonReadError.WrongContentType);
        result.Value.Should().BeNull();
    }

    [Fact]
    public async Task Reports_InvalidJson_on_a_malformed_body()
    {
        var result = await HttpJson.TryReadJsonAsync<Sample>(
            RequestWith("not json", "application/json"), CancellationToken.None);

        result.Error.Should().Be(JsonReadError.InvalidJson);
        result.Value.Should().BeNull();
    }

    [Fact]
    public async Task A_literal_null_body_is_a_null_value_not_an_error()
    {
        // A JSON `null` payload parses successfully to a null value — the caller's own null-guard
        // (not this helper) decides how to treat it, so Error stays None.
        var result = await HttpJson.TryReadJsonAsync<Sample>(
            RequestWith("null", "application/json"), CancellationToken.None);

        result.Error.Should().Be(JsonReadError.None);
        result.Value.Should().BeNull();
    }
}
