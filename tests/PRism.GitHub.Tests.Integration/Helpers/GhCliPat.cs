using System.Diagnostics;

namespace PRism.GitHub.Tests.Integration.Helpers;

[DebuggerDisplay("[REDACTED]")]
public readonly struct RedactedSecret : IFormattable, IEquatable<RedactedSecret>
{
    private readonly string _value;

    public RedactedSecret(string value)
    {
        _value = value ?? throw new ArgumentNullException(nameof(value));
    }

    /// <summary>Exposes the raw value for use at the single sink that needs it (HTTP Authorization header).</summary>
    /// <remarks>
    /// Intentionally a METHOD, not a property — properties get auto-enumerated by FluentAssertions'
    /// object-graph formatter and by IDE debugger visualizers, which would leak the value through
    /// the "redacting" wrapper. Reflection-based property enumeration returns nothing for a method.
    /// </remarks>
    public string Reveal() => _value;

    public override string ToString() => "[REDACTED]";

    public string ToString(string? format, IFormatProvider? formatProvider) => "[REDACTED]";

    // Equality members satisfy CA1815 (struct value-type contract). Comparison is by underlying value;
    // PRism does not require constant-time comparison for PATs (no other code path in this repo defends
    // against timing side channels on secrets), so ordinary string equality is acceptable here.
    public bool Equals(RedactedSecret other) => string.Equals(_value, other._value, StringComparison.Ordinal);

    public override bool Equals(object? obj) => obj is RedactedSecret other && Equals(other);

    public override int GetHashCode() => _value?.GetHashCode(StringComparison.Ordinal) ?? 0;

    public static bool operator ==(RedactedSecret left, RedactedSecret right) => left.Equals(right);

    public static bool operator !=(RedactedSecret left, RedactedSecret right) => !left.Equals(right);
}
