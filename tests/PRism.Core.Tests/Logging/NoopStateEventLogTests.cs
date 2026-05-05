using PRism.Core.Logging;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Logging;

public class NoopStateEventLogTests
{
    [Fact]
    public async Task AppendAsync_returns_completed_task_without_side_effects()
    {
        using var dir = new TempDataDir();
        IStateEventLog sut = new NoopStateEventLog();
        await sut.AppendAsync(new StateEvent("draft.create", DateTime.UtcNow, new Dictionary<string, object?> { ["id"] = "x" }), CancellationToken.None);
        Directory.GetFiles(dir.Path).Should().BeEmpty();
    }
}
