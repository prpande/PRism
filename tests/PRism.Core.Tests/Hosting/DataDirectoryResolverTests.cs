using PRism.Core.Hosting;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class DataDirectoryResolverTests
{
    [Fact]
    public void Resolve_returns_PRism_subfolder_under_LocalApplicationData()
    {
        var path = DataDirectoryResolver.Resolve();

        path.Should().NotBeNullOrWhiteSpace();
        path.Should().EndWith("PRism");
        Path.IsPathFullyQualified(path).Should().BeTrue();
    }

    [Fact]
    public void Resolve_creates_the_directory_if_it_does_not_exist()
    {
        var path = DataDirectoryResolver.Resolve();
        Directory.Exists(path).Should().BeTrue();
    }

    [Fact]
    public void Resolve_with_explicit_root_uses_the_passed_root()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), $"PRism-test-{Guid.NewGuid():N}");
        try
        {
            var path = DataDirectoryResolver.Resolve(tempRoot);
            path.Should().Be(Path.Combine(tempRoot, "PRism"));
            Directory.Exists(path).Should().BeTrue();
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }
}
