using FluentAssertions;
using PRism.Core.Inbox;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxEnrichmentContentTests
{
    [Fact]
    public void Token_is_stable_for_same_content()
        => InboxEnrichmentContent.Token("Add X", "desc")
            .Should().Be(InboxEnrichmentContent.Token("Add X", "desc"));

    [Fact]
    public void Token_changes_when_description_changes()
        => InboxEnrichmentContent.Token("Add X", "v1")
            .Should().NotBe(InboxEnrichmentContent.Token("Add X", "v2"));

    [Fact]
    public void Token_treats_null_description_distinctly_from_empty()
        => InboxEnrichmentContent.Token("T", null)
            .Should().NotBe(InboxEnrichmentContent.Token("T", ""));

    [Fact]
    public void Token_distinguishes_literal_null_string_from_null_reference()
        => InboxEnrichmentContent.Token("T", "null")
            .Should().NotBe(InboxEnrichmentContent.Token("T", null));

    [Fact]
    public void Token_has_no_field_boundary_collision()
        => InboxEnrichmentContent.Token("a b", "c")
            .Should().NotBe(InboxEnrichmentContent.Token("a", "b c"));
}
