using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Json;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class PrStatesTests
{
    [Theory]
    // REST: lowercase state + separate merged flag (a merged PR reports REST state "closed").
    [InlineData("open", false, PrState.Open)]
    [InlineData("closed", false, PrState.Closed)]
    [InlineData("closed", true, PrState.Merged)]
    [InlineData("open", true, PrState.Merged)]
    // GraphQL: uppercase state, literal "MERGED", merged flag derived from mergedAt.HasValue.
    [InlineData("OPEN", false, PrState.Open)]
    [InlineData("CLOSED", false, PrState.Closed)]
    [InlineData("MERGED", false, PrState.Merged)]
    // Tolerant: case-insensitive, unknown/null → Open (matches today's fall-through).
    [InlineData("Merged", false, PrState.Merged)]
    [InlineData("garbage", false, PrState.Open)]
    [InlineData(null, false, PrState.Open)]
    public void FromGitHub_maps_rest_and_graphql_states(string? rawState, bool merged, PrState expected)
    {
        PrStates.FromGitHub(rawState, merged).Should().Be(expected);
    }

    [Theory]
    [InlineData(PrState.Open, "\"open\"")]
    [InlineData(PrState.Closed, "\"closed\"")]
    [InlineData(PrState.Merged, "\"merged\"")]
    public void Serializes_kebab_case_on_api_options(PrState value, string expectedJson)
    {
        JsonSerializer.Serialize(value, JsonSerializerOptionsFactory.Api).Should().Be(expectedJson);
    }

    [Fact]
    public void Serializes_kebab_case_on_storage_options()
    {
        JsonSerializer.Serialize(PrState.Merged, JsonSerializerOptionsFactory.Storage).Should().Be("\"merged\"");
    }
}
