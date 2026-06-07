using FluentAssertions;
using PRism.Web.Endpoints;
using Xunit;

namespace PRism.Web.Tests;

public class AppVersionTests
{
    [Fact]
    public void Current_starts_with_the_csproj_informational_version()
    {
        // Pins that <InformationalVersion> propagates; tolerates the SDK's optional
        // +<git-sha> suffix.
        AppVersion.Current.Should().StartWith("0.2.0");
    }
}
