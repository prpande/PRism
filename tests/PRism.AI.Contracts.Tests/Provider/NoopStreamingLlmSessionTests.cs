using FluentAssertions;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.Contracts.Tests.Provider;

public sealed class NoopStreamingLlmSessionTests
{
    private static IStreamingLlmSession StartSession() =>
        new NoopStreamingLlmProvider().StartSession(new StreamingSessionOptions());

    [Fact]
    public async Task Events_completes_empty()
    {
        await using var session = StartSession();

        var events = new List<LlmEvent>();
        await foreach (var e in session.Events)
        {
            events.Add(e);
        }

        events.Should().BeEmpty();
    }

    [Fact]
    public async Task SendUserTurnAsync_does_not_throw()
    {
        await using var session = StartSession();

        var act = async () => await session.SendUserTurnAsync("hello", CancellationToken.None);

        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task ProviderSessionId_is_a_stable_nonempty_value()
    {
        await using var session = StartSession();

        session.ProviderSessionId.Should().NotBeNullOrEmpty();
        session.ProviderSessionId.Should().Be(session.ProviderSessionId);
    }

    [Fact]
    public async Task EndCleanlyAsync_reports_clean_end_with_the_session_id()
    {
        await using var session = StartSession();

        var end = await session.EndCleanlyAsync(TimeSpan.FromSeconds(1), CancellationToken.None);

        end.LastTurnEndedCleanly.Should().BeTrue();
        end.ProviderSessionId.Should().Be(session.ProviderSessionId);
        end.ProviderSessionId.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task DisposeAsync_is_idempotent_and_does_not_throw()
    {
        var session = StartSession();

        var act = async () =>
        {
            await session.DisposeAsync();
            await session.DisposeAsync();
        };

        await act.Should().NotThrowAsync();
    }
}
