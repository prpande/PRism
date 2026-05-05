using PRism.Core.Json;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Json;

public class KebabCaseJsonNamingPolicyTests
{
    private readonly KebabCaseJsonNamingPolicy _policy = new();

    [Theory]
    [InlineData("RequestChanges", "request-changes")]
    [InlineData("PrismCreated", "prism-created")]
    [InlineData("AiPreview", "ai-preview")]
    [InlineData("LocalApplicationData", "local-application-data")]
    [InlineData("A", "a")]
    [InlineData("AB", "a-b")]
    [InlineData("URLPath", "u-r-l-path")]
    [InlineData("approve", "approve")]
    [InlineData("", "")]
    public void ConvertName_lowercases_and_inserts_hyphens_before_uppercase(string input, string expected)
    {
        _policy.ConvertName(input).Should().Be(expected);
    }
}
