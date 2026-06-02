using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Web.Submit;
using Xunit;

namespace PRism.Web.Tests.Submit;

public class SubmitCancellationRegistryTests
{
    private static PrReference PrRef => new("acme", "api", 1);

    [Fact]
    public void Register_then_RequestCancel_trips_the_token()
    {
        var registry = new SubmitCancellationRegistry();
        using var cts = new CancellationTokenSource();
        using var registration = registry.Register(PrRef, cts);
        registry.RequestCancel(PrRef);
        cts.IsCancellationRequested.Should().BeTrue();
    }

    [Fact]
    public void RequestCancel_on_unknown_prRef_is_noop()
    {
        var registry = new SubmitCancellationRegistry();
        Action act = () => registry.RequestCancel(PrRef);
        act.Should().NotThrow();
    }

    [Fact]
    public void Register_while_prior_registration_alive_throws_InvalidOperationException()
    {
        var registry = new SubmitCancellationRegistry();
        using var ctsA = new CancellationTokenSource();
        using var registrationA = registry.Register(PrRef, ctsA);

        using var ctsB = new CancellationTokenSource();
        Action act = () => registry.Register(PrRef, ctsB);
        act.Should().Throw<InvalidOperationException>().WithMessage("*registration already exists*");
    }

    [Fact]
    public void Dispose_removes_entry_allows_re_register()
    {
        var registry = new SubmitCancellationRegistry();
        using (var ctsA = new CancellationTokenSource())
        {
            registry.Register(PrRef, ctsA).Dispose();
        }
        using var ctsB = new CancellationTokenSource();
        Action act = () => registry.Register(PrRef, ctsB);
        act.Should().NotThrow();
    }

    [Fact]
    public void Late_dispose_does_not_remove_fresh_registration()
    {
        var registry = new SubmitCancellationRegistry();
        using var ctsA = new CancellationTokenSource();
        var registrationA = registry.Register(PrRef, ctsA);
        registrationA.Dispose();

        using var ctsB = new CancellationTokenSource();
        var registrationB = registry.Register(PrRef, ctsB);

        // Late dispose of A must NOT remove ctsB.
        registrationA.Dispose();
        registry.RequestCancel(PrRef);
        ctsB.IsCancellationRequested.Should().BeTrue();
    }
}
