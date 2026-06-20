using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Json;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class PrInboxItemSerializationTests
{
    [Fact]
    public void PrInboxItem_does_not_serialize_Description()
    {
        var item = new PrInboxItem(
            new PrReference("o", "r", 1), "T", "a", "o/r",
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch,
            1, 0, 0, 0, 0, "sha", CiStatus.None, null, null,
            IsDraft: false, Description: "SECRET BODY");

        var json = JsonSerializer.Serialize(item, JsonSerializerOptionsFactory.Api);

        json.Should().NotContain("SECRET BODY");
        json.Should().Contain("\"isDraft\"");
    }
}
