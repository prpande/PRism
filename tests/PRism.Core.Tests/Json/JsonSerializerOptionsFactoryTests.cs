using System.Text.Json;
using PRism.Core.Json;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Json;

public class JsonSerializerOptionsFactoryTests
{
    public enum TestVerdict { Approve, RequestChanges, Comment }
    public sealed record TestPayload(TestVerdict Verdict, string AiSummary);

    [Fact]
    public void Storage_options_serialize_property_names_as_kebab_case_and_enums_as_kebab_case()
    {
        var options = JsonSerializerOptionsFactory.Storage;
        var payload = new TestPayload(TestVerdict.RequestChanges, "hi");

        var json = JsonSerializer.Serialize(payload, options);

        json.Should().Contain("\"verdict\":\"request-changes\"");
        json.Should().Contain("\"ai-summary\":\"hi\"");
    }

    [Fact]
    public void Storage_options_deserialize_kebab_case_property_names_and_enums()
    {
        var options = JsonSerializerOptionsFactory.Storage;
        var json = "{\"verdict\":\"request-changes\",\"ai-summary\":\"hi\"}";

        var payload = JsonSerializer.Deserialize<TestPayload>(json, options)!;

        payload.Verdict.Should().Be(TestVerdict.RequestChanges);
        payload.AiSummary.Should().Be("hi");
    }

    [Fact]
    public void Storage_options_skip_comments_and_allow_trailing_commas()
    {
        var options = JsonSerializerOptionsFactory.Storage;
        var json = "{ /* note */ \"verdict\": \"approve\", \"ai-summary\": \"x\", }";

        var payload = JsonSerializer.Deserialize<TestPayload>(json, options)!;
        payload.Verdict.Should().Be(TestVerdict.Approve);
    }

    [Fact]
    public void Api_options_serialize_property_names_as_camelCase_with_kebab_case_enums()
    {
        var options = JsonSerializerOptionsFactory.Api;
        var payload = new TestPayload(TestVerdict.RequestChanges, "hi");

        var json = JsonSerializer.Serialize(payload, options);

        json.Should().Contain("\"verdict\":\"request-changes\"");
        json.Should().Contain("\"aiSummary\":\"hi\"");                  // camelCase NOT kebab-case
    }

    [Fact]
    public void Default_is_an_alias_for_Storage()
    {
        JsonSerializerOptionsFactory.Default.Should().BeSameAs(JsonSerializerOptionsFactory.Storage);
    }
}
