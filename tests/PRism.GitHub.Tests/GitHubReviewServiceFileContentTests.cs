using System.Net;
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceFileContentTests
{
    private static IReviewService NewService(HttpMessageHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    private static FakeHttpMessageHandler RawHandler(byte[] bytes, HttpStatusCode status = HttpStatusCode.OK) =>
        new(_ => new HttpResponseMessage(status) { Content = new ByteArrayContent(bytes) });

    [Fact]
    public async Task GetFileContentAsync_returns_ok_with_text_content_under_size_cap()
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes("hello world\nline 2\n");
        var sut = NewService(RawHandler(bytes));

        var result = await sut.GetFileContentAsync(
            new PrReference("o", "r", 1), "src/Foo.cs", "abc123", CancellationToken.None);

        result.Status.Should().Be(FileContentStatus.Ok);
        result.Content.Should().Be("hello world\nline 2\n");
        result.ByteSize.Should().Be(bytes.Length);
    }

    [Fact]
    public async Task GetFileContentAsync_returns_not_found_on_404()
    {
        var sut = NewService(RawHandler(Array.Empty<byte>(), HttpStatusCode.NotFound));

        var result = await sut.GetFileContentAsync(
            new PrReference("o", "r", 1), "src/Missing.cs", "abc", CancellationToken.None);

        result.Status.Should().Be(FileContentStatus.NotFound);
        result.Content.Should().BeNull();
        result.ByteSize.Should().Be(0);
    }

    [Fact]
    public async Task GetFileContentAsync_returns_too_large_above_5MB_cap()
    {
        // 5MB cap; one byte over.
        var bytes = new byte[(5 * 1024 * 1024) + 1];
        Array.Fill<byte>(bytes, (byte)'x');
        var sut = NewService(RawHandler(bytes));

        var result = await sut.GetFileContentAsync(
            new PrReference("o", "r", 1), "huge.txt", "abc", CancellationToken.None);

        result.Status.Should().Be(FileContentStatus.TooLarge);
        result.Content.Should().BeNull();
        result.ByteSize.Should().Be(bytes.Length);
    }

    [Fact]
    public async Task GetFileContentAsync_returns_binary_when_first_8KB_contains_null_byte()
    {
        var bytes = new byte[100];
        bytes[42] = 0x00;   // null byte in the first 8KB → binary heuristic fires.
        var sut = NewService(RawHandler(bytes));

        var result = await sut.GetFileContentAsync(
            new PrReference("o", "r", 1), "build.exe", "abc", CancellationToken.None);

        result.Status.Should().Be(FileContentStatus.Binary);
        result.Content.Should().BeNull();
    }
}
