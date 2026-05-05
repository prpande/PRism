using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Json;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class VerdictSerializationTests
{
    [Theory]
    [InlineData(Verdict.Approve, "\"approve\"")]
    [InlineData(Verdict.RequestChanges, "\"request-changes\"")]
    [InlineData(Verdict.Comment, "\"comment\"")]
    public void Verdict_serializes_kebab_case(Verdict v, string expected)
    {
        var json = JsonSerializer.Serialize(v, JsonSerializerOptionsFactory.Storage);
        json.Should().Be(expected);
    }
}
