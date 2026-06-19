using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Json;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class ReviewStateSerializationTests
{
    [Theory]
    [InlineData(ReviewState.Approved, "\"approved\"")]
    [InlineData(ReviewState.ChangesRequested, "\"changes-requested\"")]
    [InlineData(ReviewState.Commented, "\"commented\"")]
    public void ReviewState_serializes_kebab_on_the_api_options(ReviewState state, string expected)
        => Assert.Equal(expected, JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Api));
}
