using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class AppConfigDefaultsTests
{
    [Fact]
    public void Default_ai_provider_timeout_is_240_seconds() =>
        AppConfig.Default.Ui.Ai.ProviderTimeoutSeconds.Should().Be(240);

    [Fact]
    public void Default_ai_hunk_annotation_cap_is_10() =>
        AppConfig.Default.Ui.Ai.HunkAnnotationCap.Should().Be(10);
}
