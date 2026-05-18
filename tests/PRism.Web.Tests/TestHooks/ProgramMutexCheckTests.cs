using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

[Collection("EnvVarMutating")]
public class ProgramMutexCheckTests
{
    [Fact]
    public void Startup_RejectsBothEnvVarsSetSimultaneously()
    {
        Environment.SetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW", "1");
        Environment.SetEnvironmentVariable("PRISM_E2E_REAL_INJECT", "1");
        try
        {
            var factory = new WebApplicationFactory<Program>();
            // WebApplicationFactory may wrap the startup exception (TargetInvocationException,
            // host-bootstrap aggregation). Use ThrowsAny and walk inner exceptions.
            var ex = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
            var found = false;
            for (var e = (Exception?)ex; e is not null; e = e.InnerException)
            {
                if (e is InvalidOperationException
                    && e.Message.Contains("mutually exclusive", StringComparison.OrdinalIgnoreCase))
                {
                    found = true;
                    break;
                }
            }
            Assert.True(found, $"Expected InvalidOperationException with 'mutually exclusive' message in chain; got: {ex}");
        }
        finally
        {
            Environment.SetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW", null);
            Environment.SetEnvironmentVariable("PRISM_E2E_REAL_INJECT", null);
        }
    }
}
