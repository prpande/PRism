using System.Diagnostics;
using System.Reflection;
using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration.Helpers;

public class RedactedSecretTests
{
    [Fact]
    public void ToString_returns_REDACTED()
    {
        var s = new RedactedSecret("ghp_abc123secretvalue");
        s.ToString().Should().Be("[REDACTED]");
    }

    [Fact]
    public void IFormattable_ToString_returns_REDACTED()
    {
        var s = new RedactedSecret("ghp_abc123secretvalue");
        // ILogger template expansion and FluentAssertions call the IFormattable overload
        ((IFormattable)s).ToString("anyformat", null).Should().Be("[REDACTED]");
    }

    [Fact]
    public void Reveal_is_a_method_not_a_property()
    {
        // Reflection-based property enumeration (FluentAssertions, debugger visualizers) must NOT
        // surface the raw value. Reveal must be a method, not a property.
        var type = typeof(RedactedSecret);
        type.GetMethod("Reveal", BindingFlags.Public | BindingFlags.Instance).Should().NotBeNull();
        type.GetProperty("Reveal", BindingFlags.Public | BindingFlags.Instance).Should().BeNull();
    }

    [Fact]
    public void Reveal_returns_the_raw_value()
    {
        var s = new RedactedSecret("ghp_abc123secretvalue");
        s.Reveal().Should().Be("ghp_abc123secretvalue");
    }

    [Fact]
    public void Has_DebuggerDisplay_attribute_with_REDACTED_text()
    {
        var attr = typeof(RedactedSecret)
            .GetCustomAttributes(typeof(DebuggerDisplayAttribute), inherit: false)
            .Cast<DebuggerDisplayAttribute>()
            .SingleOrDefault();
        attr.Should().NotBeNull("the wrapper must suppress IDE debugger auto-expand");
        attr!.Value.Should().Be("[REDACTED]");
    }
}
