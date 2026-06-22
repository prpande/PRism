// tests/PRism.AI.ClaudeCode.Tests/ClaudeProviderDescriptorTests.cs
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;
using Xunit;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeProviderDescriptorTests
{
    [Fact]
    public void Descriptor_lists_the_providers_disabled_states_with_plain_text_labels()
    {
        var d = ClaudeProviderDescriptor.Create();

        d.DisabledStates.Should().Contain(s => s.ReasonCode == ClaudeReasonCodes.CliNotInstalled);
        d.DisabledStates.Should().Contain(s => s.ReasonCode == ClaudeReasonCodes.CliDiscoveryFailed);
        d.DisabledStates.Should().Contain(s => s.ReasonCode == ClaudeReasonCodes.NotLoggedIn);
        d.DisabledStates.Should().Contain(s => s.ReasonCode == ClaudeReasonCodes.IdentityMismatch);
        d.DisabledStates.Should().Contain(s => s.ReasonCode == ClaudeReasonCodes.Unknown);
        d.DisabledStates.Should().OnlyContain(s => !string.IsNullOrWhiteSpace(s.DisplayLabel) && s.DisplayLabel.Length <= 200);
        d.SupportsStructuredOutput.Should().BeTrue(); // CLI has --json-schema
    }
}
