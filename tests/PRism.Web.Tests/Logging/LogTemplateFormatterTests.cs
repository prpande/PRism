using System.Collections.Generic;

using FluentAssertions;
using PRism.Web.Logging;

namespace PRism.Web.Tests.Logging;

public class LogTemplateFormatterTests
{
    [Fact]
    public void Simple_named_placeholder_substitutes()
    {
        var result = LogTemplateFormatter.Format(
            "hello {Name}",
            new Dictionary<string, object?> { ["Name"] = "world" });

        result.Should().Be("hello world");
    }

    [Fact]
    public void Missing_key_renders_empty_string()
    {
        var result = LogTemplateFormatter.Format(
            "hello {Name}",
            new Dictionary<string, object?>());

        result.Should().Be("hello ");
    }

    [Fact]
    public void Format_specifier_applied_to_formattable()
    {
        var result = LogTemplateFormatter.Format(
            "count={Count:N0}",
            new Dictionary<string, object?> { ["Count"] = 1234 });

        result.Should().Be("count=1,234");
    }

    [Fact]
    public void Alignment_specifier_applies_width()
    {
        var result = LogTemplateFormatter.Format(
            "[{Code,5}]",
            new Dictionary<string, object?> { ["Code"] = "foo" });

        result.Should().Be("[  foo]");
    }

    [Fact]
    public void Alignment_and_format_specifier_combined()
    {
        var result = LogTemplateFormatter.Format(
            "[{Code,8:N0}]",
            new Dictionary<string, object?> { ["Code"] = 1234 });

        result.Should().Be("[   1,234]");
    }

    [Fact]
    public void Escaped_braces_render_literal_braces()
    {
        var result = LogTemplateFormatter.Format(
            "literal {{Name}} not a placeholder",
            new Dictionary<string, object?> { ["Name"] = "world" });

        result.Should().Be("literal {Name} not a placeholder");
    }

    [Fact]
    public void Null_value_renders_as_empty_string()
    {
        var result = LogTemplateFormatter.Format(
            "value={X}",
            new Dictionary<string, object?> { ["X"] = null });

        result.Should().Be("value=");
    }

    [Fact]
    public void Multiple_occurrences_of_same_name_all_substituted()
    {
        // Template grammar permits the same name twice; both positional rewrites resolve
        // to the same dictionary entry.
        var result = LogTemplateFormatter.Format(
            "a={X} b={X}",
            new Dictionary<string, object?> { ["X"] = 42 });

        result.Should().Be("a=42 b=42");
    }

    [Fact]
    public void Value_containing_placeholder_shape_does_NOT_recurse_into_second_substitution()
    {
        // Pinning the single-pass invariant: a scrubbed value of "{Login}" (literal string)
        // substituted into the first position renders verbatim; the second positional
        // substitution operates on a fresh segment. A naive .Replace impl would recurse and
        // leak adjacent arg values — explicitly forbidden by the design (§ 4.4).
        var result = LogTemplateFormatter.Format(
            "first={First} second={Login}",
            new Dictionary<string, object?>
            {
                ["First"] = "{Login}",
                ["Login"] = "[REDACTED]",
            });

        result.Should().Be("first={Login} second=[REDACTED]");
    }

    [Fact]
    public void Malformed_template_returns_verbatim_and_does_not_throw()
    {
        // Unbalanced brace — string.Format throws FormatException; the formatter catches
        // broadly and returns the template verbatim.
        var result = LogTemplateFormatter.Format(
            "unbalanced {Name",
            new Dictionary<string, object?> { ["Name"] = "x" });

        result.Should().Be("unbalanced {Name");
    }

    [Fact]
    public void Value_whose_ToString_throws_returns_template_verbatim_and_does_not_propagate()
    {
        // ADV2-3: string.Format does NOT wrap value-formatter throws as FormatException on
        // .NET 10. The formatter catches Exception broadly so the request thread doesn't see
        // the throw (which would land in the file sink's outer catch and fall back to the
        // unscrubbed formatter — but the test pins the formatter-level behavior).
        var result = LogTemplateFormatter.Format(
            "throws={X}",
            new Dictionary<string, object?> { ["X"] = new ThrowingToString() });

        result.Should().Be("throws={X}");  // template verbatim
    }

    private sealed class ThrowingToString
    {
        public override string ToString() => throw new InvalidOperationException("kaboom");
    }
}
