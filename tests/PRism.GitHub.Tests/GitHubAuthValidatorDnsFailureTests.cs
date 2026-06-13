using System.Net;
using System.Net.Sockets;
using PRism.Core.Contracts;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests;

// #321 PR2 fold-in 1 — IsDnsFailure must read the message off the inner SocketException
// (se.Message), not the HttpRequestException wrapper (ex.Message). The "Name or service not
// known" / "No such host" strings originate on the inner SocketException; on platforms where
// the wrapper message differs, reading ex.Message misclassifies a DNS failure as a generic
// NetworkError. The existing Returns_dns_error_when_handler_throws_dns_exception test passes via
// the SocketErrorCode == HostNotFound branch regardless of which message is read, so it does NOT
// pin this fix — case 2 below does.
public class GitHubAuthValidatorDnsFailureTests
{
    private static GitHubAuthValidator BuildSut(HttpMessageHandler handler, string token = "ghp_test", string host = "https://github.com")
    {
        var factory = new FakeHttpClientFactory(handler, HostUrlResolver.ApiBase(host));
        return new GitHubAuthValidator(factory, () => Task.FromResult<string?>(token), host);
    }

    [Fact]
    public async Task HostNotFound_socket_error_is_dns_error_regardless_of_message()
    {
        // Primary-path guard: SocketErrorCode == HostNotFound classifies as DnsError even with a
        // neutral message on both the wrapper and the inner exception.
        var handler = FakeHttpMessageHandler.Throws(
            new HttpRequestException("transport failed", new SocketException((int)SocketError.HostNotFound)));
        var sut = BuildSut(handler);

        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);

        result.Error.Should().Be(AuthValidationError.DnsError);
    }

    [Fact]
    public async Task NonHostNotFound_code_with_dns_message_only_on_inner_exception_is_dns_error()
    {
        // The fix-pinning case: SocketErrorCode is NOT HostNotFound (so the code branch can't
        // classify it), and the "No such host" string lives ONLY on the inner SocketException's
        // message — the HttpRequestException wrapper carries a neutral message. This is DnsError
        // only when IsDnsFailure reads se.Message; reading ex.Message yields NetworkError.
        var inner = new SocketException((int)SocketError.TryAgain, "No such host is known");
        var handler = FakeHttpMessageHandler.Throws(new HttpRequestException("connection failed", inner));
        var sut = BuildSut(handler);

        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);

        result.Error.Should().Be(AuthValidationError.DnsError);
    }
}
