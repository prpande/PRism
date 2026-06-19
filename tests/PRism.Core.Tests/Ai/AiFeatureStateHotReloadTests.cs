using System.Collections.Generic;
using System.Threading;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Ai;

public class AiFeatureStateHotReloadTests
{
    [Fact]
    public async Task Patching_a_feature_off_flips_the_runtime_AiFeatureState()
    {
        var dir = Directory.CreateTempSubdirectory("prism-feat-").FullName;
        var services = new ServiceCollection().AddPrismCore(dir).BuildServiceProvider();
        var config = services.GetRequiredService<IConfigStore>();
        var state = services.GetRequiredService<AiFeatureState>();

        state.IsEnabled("summary").Should().BeTrue();
        await config.PatchAsync(new Dictionary<string, object?> { ["ui.ai.features.summary"] = false }, CancellationToken.None);
        state.IsEnabled("summary").Should().BeFalse();
    }
}
