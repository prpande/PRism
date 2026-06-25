using System;
using System.Collections.Generic;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Json;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class ChecksDtoSerializationTests
{
    private static readonly JsonSerializerOptions Api = JsonSerializerOptionsFactory.Api;

    [Fact]
    public void Enums_roundtrip_kebab_case()
    {
        Assert.Equal("\"in-progress\"", JsonSerializer.Serialize(CheckRunStatus.InProgress, Api));
        Assert.Equal("\"timed-out\"", JsonSerializer.Serialize(CheckConclusion.TimedOut, Api));
        Assert.Equal("\"action-required\"", JsonSerializer.Serialize(CheckConclusion.ActionRequired, Api));
        Assert.Equal("\"transient\"", JsonSerializer.Serialize(DegradedReason.Transient, Api));
    }

    [Fact]
    public void ChecksResponse_roundtrips()
    {
        var dto = new ChecksResponseDto(
            new List<CheckDto>
            {
                new("build", CheckRunStatus.Completed, CheckConclusion.Success, "check-run",
                    DateTimeOffset.Parse("2026-06-25T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
                    DateTimeOffset.Parse("2026-06-25T10:01:30Z", System.Globalization.CultureInfo.InvariantCulture),
                    "https://github.com/o/r/runs/1"),
            },
            "0123456789abcdef0123456789abcdef01234567",
            DegradedReason.None);

        var json = JsonSerializer.Serialize(dto, Api);
        var back = JsonSerializer.Deserialize<ChecksResponseDto>(json, Api)!;

        Assert.Single(back.Checks);
        Assert.Equal("build", back.Checks[0].Name);
        Assert.Equal(CheckRunStatus.Completed, back.Checks[0].Status);
        Assert.Equal(CheckConclusion.Success, back.Checks[0].Conclusion);
        Assert.Equal("check-run", back.Checks[0].Source);
        Assert.Equal("0123456789abcdef0123456789abcdef01234567", back.HeadSha);
        Assert.Equal(DegradedReason.None, back.Degraded);
        Assert.Contains("\"status\":\"completed\"", json, System.StringComparison.Ordinal);
        Assert.Contains("\"degraded\":\"none\"", json, System.StringComparison.Ordinal);
    }

    [Fact]
    public void CheckDto_with_all_null_optionals_roundtrips()
    {
        // A legacy-status / in-progress check carries null Conclusion/StartedAt/CompletedAt/DetailsUrl.
        var dto = new CheckDto("ci/legacy", CheckRunStatus.InProgress, null, "status", null, null, null);
        var back = JsonSerializer.Deserialize<CheckDto>(JsonSerializer.Serialize(dto, Api), Api)!;
        Assert.Equal("ci/legacy", back.Name);
        Assert.Equal(CheckRunStatus.InProgress, back.Status);
        Assert.Null(back.Conclusion);
        Assert.Null(back.StartedAt);
        Assert.Null(back.CompletedAt);
        Assert.Null(back.DetailsUrl);
    }
}
