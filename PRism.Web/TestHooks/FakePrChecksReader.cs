using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.Web.TestHooks;

/// <summary>Deterministic mixed check list for e2e / integration (mirrors FakePrBatchReader).
/// INTERNAL — accessible from PRism.Web.Tests via the assembly's InternalsVisibleTo attribute.
/// Used by the xUnit ChecksEndpointTests in a WithWebHostBuilder swap and by Playwright e2e
/// when PRISM_E2E_FAKE_REVIEW=1 (registered in Program.cs).</summary>
internal sealed class FakePrChecksReader : IPrChecksReader
{
    public Task<ChecksResponseDto> ReadAsync(PrReference pr, string headSha, CancellationToken ct)
    {
        var checks = new List<CheckDto>
        {
            new("build", CheckRunStatus.Completed, CheckConclusion.Failure, "check-run",
                DateTimeOffset.Parse("2026-06-25T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
                DateTimeOffset.Parse("2026-06-25T10:02:10Z", System.Globalization.CultureInfo.InvariantCulture),
                "https://github.com/o/r/runs/1",
                Summary: "2 errors, 0 warnings", AppName: "GitHub Actions"),
            new("lint", CheckRunStatus.InProgress, null, "check-run",
                DateTimeOffset.Parse("2026-06-25T10:00:05Z", System.Globalization.CultureInfo.InvariantCulture),
                null,
                "https://github.com/o/r/runs/2",
                Summary: "Running eslint...", AppName: "GitHub Actions"),
            new("test", CheckRunStatus.Completed, CheckConclusion.Success, "check-run",
                DateTimeOffset.Parse("2026-06-25T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
                DateTimeOffset.Parse("2026-06-25T10:00:45Z", System.Globalization.CultureInfo.InvariantCulture),
                "https://github.com/o/r/runs/3",
                Summary: "128 passed", AppName: "CircleCI"),
        };
        return Task.FromResult(new ChecksResponseDto(checks, headSha, DegradedReason.None));
    }
}
