using PRism.Core.Hosting;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class CommandLineOptionsTests
{
    [Fact]
    public void GetValue_reads_space_separated_form()
    {
        var args = new[] { "--dataDir", @"C:\tmp\prism" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().Be(@"C:\tmp\prism");
    }

    [Fact]
    public void GetValue_reads_equals_form()
    {
        var args = new[] { @"--dataDir=C:\tmp\prism" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().Be(@"C:\tmp\prism");
    }

    // Regression for the sidecar-arg bug: the .NET command-line *configuration*
    // provider treats a bare "--no-browser" as a key needing a value and swallows
    // the following "--dataDir" token, dropping the override. Direct argv parsing
    // must be order-independent — value extracted whether the bare flag precedes
    // or follows the option.
    [Fact]
    public void GetValue_is_order_independent_when_a_bare_flag_precedes_the_option()
    {
        var args = new[] { "--no-browser", "--dataDir", @"C:\tmp\prism" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().Be(@"C:\tmp\prism");
    }

    [Fact]
    public void GetValue_is_order_independent_when_a_bare_flag_follows_the_option()
    {
        var args = new[] { "--dataDir", @"C:\tmp\prism", "--no-browser" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().Be(@"C:\tmp\prism");
    }

    [Fact]
    public void GetValue_matches_the_option_name_case_insensitively()
    {
        var args = new[] { "--DATADIR", @"C:\tmp\prism" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().Be(@"C:\tmp\prism");
    }

    [Fact]
    public void GetValue_returns_null_when_the_option_is_absent()
    {
        var args = new[] { "--no-browser", "--urls", "http://localhost:5180" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().BeNull();
    }

    [Fact]
    public void GetValue_returns_null_when_the_option_is_the_last_token_with_no_value()
    {
        var args = new[] { "--no-browser", "--dataDir" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().BeNull();
    }

    [Fact]
    public void GetValue_returns_null_when_the_next_token_is_another_flag()
    {
        // A missing value (another flag follows) must NOT be mistaken for the value.
        var args = new[] { "--dataDir", "--no-browser" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().BeNull();
    }

    [Fact]
    public void GetValue_returns_null_for_empty_args()
    {
        CommandLineOptions.GetValue(System.Array.Empty<string>(), "--dataDir").Should().BeNull();
    }

    [Fact]
    public void GetValue_returns_null_for_the_equals_form_with_an_empty_value()
    {
        // "--dataDir=" must fall through to the caller's fallback chain, not yield ""
        // which would poison Path.Combine into relative paths.
        var args = new[] { "--dataDir=" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().BeNull();
    }

    [Fact]
    public void GetValue_returns_null_for_the_space_form_with_an_empty_value()
    {
        var args = new[] { "--dataDir", "" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().BeNull();
    }

    [Fact]
    public void GetValue_returns_the_first_value_when_the_option_appears_twice()
    {
        var args = new[] { "--dataDir", @"C:\first", "--dataDir", @"C:\second" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().Be(@"C:\first");
    }

    [Fact]
    public void GetValue_skips_null_elements_without_throwing()
    {
        // The IReadOnlyList<string> signature permits null elements even though
        // Main(string[]) never produces one; a null must not NRE the scan.
        var args = new string[] { "--no-browser", null!, "--dataDir", @"C:\tmp\prism" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().Be(@"C:\tmp\prism");
    }

    [Fact]
    public void GetValue_keeps_subsequent_equals_signs_in_the_equals_form_value()
    {
        // Value contains '=' (e.g. a path with a "key=val" segment): only the first
        // '=' delimits name from value; the rest is part of the value.
        var args = new[] { @"--dataDir=C:\path\key=val" };

        CommandLineOptions.GetValue(args, "--dataDir").Should().Be(@"C:\path\key=val");
    }
}
