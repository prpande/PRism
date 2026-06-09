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
    public void Placeholder_assembly_has_no_network_egress_reference()
        => AssertNoNetworkReference(typeof(PlaceholderPrSummarizer).Assembly);   // PRism.AI.Placeholder

    [Fact]
    public void Contracts_assembly_has_no_network_egress_reference()
        => AssertNoNetworkReference(typeof(IPrSummarizer).Assembly);             // PRism.AI.Contracts

    // The managed network-egress vectors, each in its own fine-grained assembly.
    // GetReferencedAssemblies only lists an assembly once a type from it is actually used,
    // so naming these is the non-brittle tripwire: it fires exactly when someone wires a
    // network client into the placeholder/contracts assembly — HttpClient (System.Net.Http),
    // a raw socket (System.Net.Sockets), WebRequest/HttpWebRequest (System.Net.Requests), or
    // WebClient (System.Net.WebClient — a DISTINCT assembly from Requests; flagged by Copilot
    // on PR #309). Not exhaustive (a transitive package could still hide egress), but it spans
    // the realistic ways a "real model" call gets bolted on.
    private static readonly string[] EgressAssemblies =
    {
        "System.Net.Http",
        "System.Net.Sockets",
        "System.Net.Requests",
        "System.Net.WebClient",
    };

    private static void AssertNoNetworkReference(Assembly assembly)
    {
        var referenced = assembly
            .GetReferencedAssemblies()
            .Select(a => a.Name)
            .ToArray();

        referenced.Should().NotIntersectWith(
            EgressAssemblies,
            because: "the default-on placeholder AI seams must perform zero network egress; a " +
                     "reference to a network assembly means HttpClient/sockets/WebRequest was " +
                     "wired in — which requires a privacy/egress review before it can ship " +
                     "default-on (#283).");
    }
}
