using System.Linq;
using System.Reflection;
using FluentAssertions;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using Xunit;

namespace PRism.Core.Tests.Ai;

// #283 egress guard. AI preview now ships ENABLED by default to every fresh install, so the
// "placeholder seams perform zero external egress" claim is load-bearing. This is the
// non-brittle form of a no-network test: GetReferencedAssemblies() only lists assemblies the
// compiler actually emitted a reference to (i.e. types that are USED). System.Net.Http appears
// only if someone deliberately wires HttpClient (or similar) into the placeholder/contracts
// assembly — which is exactly when this guard should fail. It does NOT run the network or
// assert at runtime; it fingerprints the compiled dependency graph.
public class PlaceholderEgressGuardTests
{
    [Fact]
    public void Placeholder_assembly_does_not_reference_System_Net_Http()
        => AssertNoHttpReference(typeof(PlaceholderPrSummarizer).Assembly);   // PRism.AI.Placeholder

    [Fact]
    public void Contracts_assembly_does_not_reference_System_Net_Http()
        => AssertNoHttpReference(typeof(IPrSummarizer).Assembly);             // PRism.AI.Contracts

    private static void AssertNoHttpReference(Assembly assembly)
    {
        var referenced = assembly
            .GetReferencedAssemblies()
            .Select(a => a.Name)
            .ToArray();

        referenced.Should().NotContain(
            "System.Net.Http",
            because: "the default-on placeholder AI seams must perform zero network egress; a " +
                     "reference to System.Net.Http means HttpClient (or similar) was wired in — " +
                     "which requires a privacy/egress review before it can ship default-on (#283).");
    }
}
