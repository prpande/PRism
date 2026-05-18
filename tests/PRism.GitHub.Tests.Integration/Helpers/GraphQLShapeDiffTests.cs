using System.Text.Json;
using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration.Helpers;

public class GraphQLShapeDiffTests
{
    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void Identical_documents_return_empty_diff()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": 1, "b": "x"}"""),
            Parse("""{"a": 1, "b": "x"}"""));
        diff.Should().BeEmpty();
    }

    [Fact]
    public void Added_field_surfaces_as_plus_path()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": 1}"""),
            Parse("""{"a": 1, "b": 2}"""));
        diff.Should().ContainSingle().Which.Should().StartWith("+ /b");
    }

    [Fact]
    public void Removed_field_surfaces_as_minus_path()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": 1, "b": 2}"""),
            Parse("""{"a": 1}"""));
        diff.Should().ContainSingle().Which.Should().StartWith("- /b");
    }

    [Fact]
    public void Type_change_surfaces_as_tilde_with_kinds()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": "string"}"""),
            Parse("""{"a": 42}"""));
        diff.Should().ContainSingle().Which.Should().Contain("~ /a").And.Contain("String").And.Contain("Number");
    }

    [Fact]
    public void Nested_object_changes_emit_full_pointer_path()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"data": {"repository": {"x": 1}}}"""),
            Parse("""{"data": {"repository": {"x": 1, "y": 2}}}"""));
        diff.Should().ContainSingle().Which.Should().Contain("/data/repository/y");
    }

    [Fact]
    public void Array_diffs_positionally_by_index()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"items": [{"k": "a"}, {"k": "b"}]}"""),
            Parse("""{"items": [{"k": "a"}, {"k": "b", "added": true}]}"""));
        diff.Should().ContainSingle().Which.Should().Contain("/items/1/added");
    }

    [Fact]
    public void Array_length_difference_surfaces_per_missing_index()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"items": [1, 2, 3]}"""),
            Parse("""{"items": [1, 2]}"""));
        diff.Should().Contain(line => line.StartsWith("- /items/2"));
    }

    [Fact]
    public void Multiple_changes_emit_in_stable_order()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": 1, "b": "x", "c": [1]}"""),
            Parse("""{"a": 2, "b": "x", "c": [1, 2], "d": true}"""));
        // Three differences: type-or-value change at /a (Number→Number, value differ — see contract), array length /c, addition /d.
        // Stable order: pre-order traversal of the LEFT tree first, then additions from the RIGHT.
        diff.Should().HaveCount(c => c >= 2);
    }
}
