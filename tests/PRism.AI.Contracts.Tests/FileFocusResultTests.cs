using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using Xunit;

namespace PRism.AI.Contracts.Tests;

public sealed class FileFocusResultTests
{
    [Fact]
    public void FileFocus_carries_path_level_and_rationale()
    {
        var f = new FileFocus("src/Calc.cs", FocusLevel.High, "Core billing math.");
        f.Path.Should().Be("src/Calc.cs");
        f.Level.Should().Be(FocusLevel.High);
        f.Rationale.Should().Be("Core billing math.");
    }

    [Fact]
    public void FileFocusResult_defaults_fallback_false()
    {
        var r = new FileFocusResult(new[] { new FileFocus("a", FocusLevel.Low, "trivial") });
        r.Entries.Should().HaveCount(1);
        r.Fallback.Should().BeFalse();
    }

    [Fact]
    public void FileFocusResult_can_flag_fallback()
    {
        var r = new FileFocusResult(System.Array.Empty<FileFocus>(), Fallback: true);
        r.Fallback.Should().BeTrue();
    }
}
