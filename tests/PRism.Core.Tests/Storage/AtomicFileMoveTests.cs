using FluentAssertions;
using PRism.Core.Storage;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Storage;

public class AtomicFileMoveTests
{
    [Fact]
    public async Task MoveAsync_replaces_destination_with_source_contents()
    {
        using var dir = new TempDataDir();
        var source = Path.Combine(dir.Path, "source.tmp");
        var dest = Path.Combine(dir.Path, "dest.txt");
        await File.WriteAllTextAsync(source, "new-contents");
        await File.WriteAllTextAsync(dest, "old-contents");

        await AtomicFileMove.MoveAsync(source, dest, CancellationToken.None);

        File.Exists(source).Should().BeFalse();
        (await File.ReadAllTextAsync(dest)).Should().Be("new-contents");
    }

    [Fact]
    public async Task MoveAsync_creates_destination_when_it_did_not_exist()
    {
        using var dir = new TempDataDir();
        var source = Path.Combine(dir.Path, "source.tmp");
        var dest = Path.Combine(dir.Path, "dest.txt");
        await File.WriteAllTextAsync(source, "contents");

        await AtomicFileMove.MoveAsync(source, dest, CancellationToken.None);

        File.Exists(source).Should().BeFalse();
        File.Exists(dest).Should().BeTrue();
        (await File.ReadAllTextAsync(dest)).Should().Be("contents");
    }

    [Fact]
    public async Task MoveAsync_leaves_no_orphan_source_on_success_path()
    {
        // The retry loop's `finally` block best-effort-deletes the source on exhaustion or on
        // non-retried-exception path. On the success path, File.Move consumes the source so the
        // cleanup is a no-op. This test pins the happy-path no-orphan contract.
        using var dir = new TempDataDir();
        var source = Path.Combine(dir.Path, "source.tmp");
        var dest = Path.Combine(dir.Path, "dest.txt");
        await File.WriteAllTextAsync(source, "x");

        await AtomicFileMove.MoveAsync(source, dest, CancellationToken.None);

        Directory.GetFiles(dir.Path).Should().BeEquivalentTo(new[] { dest });
    }
}
