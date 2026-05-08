using FluentAssertions;
using PRism.Web.Logging;

namespace PRism.Web.Tests.Logging;

public class SensitiveFieldScrubberTests
{
    [Fact]
    public void Redacts_subscriberId_field()
    {
        SensitiveFieldScrubber.Scrub("subscriberId", "abc123").Should().Be("[REDACTED]");
    }

    [Fact]
    public void Redacts_pat_field()
    {
        SensitiveFieldScrubber.Scrub("pat", "ghp_xxxxxxxxxxxxxxxxxxxx").Should().Be("[REDACTED]");
    }

    [Fact]
    public void Redacts_token_field()
    {
        SensitiveFieldScrubber.Scrub("token", "Bearer eyJ...").Should().Be("[REDACTED]");
    }

    [Fact]
    public void Field_match_is_case_insensitive()
    {
        SensitiveFieldScrubber.Scrub("SubscriberID", "abc").Should().Be("[REDACTED]");
        SensitiveFieldScrubber.Scrub("PAT", "ghp_x").Should().Be("[REDACTED]");
        SensitiveFieldScrubber.Scrub("Token", "Bearer x").Should().Be("[REDACTED]");
    }

    [Fact]
    public void Keeps_body_field_unredacted_for_debuggability()
    {
        // P2.8: `body` is intentionally NOT blocked. mark-viewed / files/viewed
        // failures need the body for debugging. Same for `content`.
        SensitiveFieldScrubber.Scrub("body", "{\"prRef\":...}").Should().Be("{\"prRef\":...}");
        SensitiveFieldScrubber.Scrub("content", "diff text").Should().Be("diff text");
    }

    [Fact]
    public void Keeps_other_fields_untouched()
    {
        SensitiveFieldScrubber.Scrub("headSha", "abc123").Should().Be("abc123");
        SensitiveFieldScrubber.Scrub("PrRef", "owner/repo/123").Should().Be("owner/repo/123");
    }

    [Fact]
    public void Truncates_strings_longer_than_1024_chars_with_original_length_suffix()
    {
        var twoKb = new string('x', 2048);
        var result = SensitiveFieldScrubber.Scrub("anyField", twoKb) as string;

        result.Should().NotBeNull();
        result!.Should().StartWith(new string('x', 1024));
        result.Should().EndWith("[truncated, original-length: 2048]");
    }

    [Fact]
    public void Does_not_truncate_strings_at_or_below_1024_chars()
    {
        var exactly1024 = new string('x', 1024);
        SensitiveFieldScrubber.Scrub("anyField", exactly1024).Should().Be(exactly1024);
    }

    [Fact]
    public void Truncation_does_not_apply_when_field_is_already_redacted()
    {
        // Redaction beats truncation — a 2 KiB pat should show [REDACTED], not
        // a truncated form (truncating a secret is still leaking 1 KiB of it).
        var bigPat = new string('p', 2048);
        SensitiveFieldScrubber.Scrub("pat", bigPat).Should().Be("[REDACTED]");
    }

    [Fact]
    public void Returns_null_when_value_is_null()
    {
        SensitiveFieldScrubber.Scrub("headSha", null).Should().BeNull();
    }

    [Fact]
    public void Returns_non_string_values_untouched_when_not_in_blocklist()
    {
        SensitiveFieldScrubber.Scrub("count", 42).Should().Be(42);
        SensitiveFieldScrubber.Scrub("flag", true).Should().Be(true);
    }
}
