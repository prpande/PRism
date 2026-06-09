using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Json;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class CiStatusSerializationTests
{
    [Theory]
    [InlineData(CiStatus.None, "\"none\"")]
    [InlineData(CiStatus.Pending, "\"pending\"")]
    [InlineData(CiStatus.Failing, "\"failing\"")]
    [InlineData(CiStatus.Passing, "\"passing\"")]
    public void CiStatus_serializes_kebab_case(CiStatus s, string expected)
    {
        // The frontend union mirror (frontend/src/api/types.ts) depends on these
        // exact lowercase wire strings — 'passing' must match the React literal.
        var json = JsonSerializer.Serialize(s, JsonSerializerOptionsFactory.Api);
        json.Should().Be(expected);
    }
}
