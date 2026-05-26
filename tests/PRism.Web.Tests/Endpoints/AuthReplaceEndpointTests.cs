using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Web.Middleware;
using PRism.Web.Submit;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// S6 PR2 — endpoint contract tests for POST /api/auth/replace. Covers spec § 3.8:
// happy-path same-login (case-insensitive), happy-path different-login (Node IDs
// cleared, draft bodies preserved), structured-log forensic emission, PAT-not-
// logged discipline, validation failure rollback, submit-in-flight 409 with prRef,
// logger-failure isolation (§ 14 OQ 4), NoReposSelected warning treated as success.
public class AuthReplaceEndpointTests
{
    private const string DefaultPat = "ghp_test_new";
    private const string SamplePr = "octocat/Hello-World/1";

    private sealed class HarnessFactory : WebApplicationFactory<Program>
    {
        public PRismWebApplicationFactory Base { get; }
        public Func<Task<AuthValidationResult>>? Validate { get; set; }
        public ListLoggerProvider Logs { get; } = new();
        public Action<IServiceCollection>? ExtraServiceConfig { get; set; }

        public HarnessFactory()
        {
            Base = new PRismWebApplicationFactory();
        }

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            ArgumentNullException.ThrowIfNull(builder);
            // Reuse PRismWebApplicationFactory's DataDir + Test env wiring, then replace
            // the IReviewAuth binding so the test scripts what GitHub "validation" returns.
            builder.UseSetting("DataDir", Base.DataDir);
            builder.UseEnvironment("Test");
            var webRoot = System.IO.Path.Combine(Base.DataDir, "wwwroot");
            System.IO.Directory.CreateDirectory(webRoot);
            if (!System.IO.File.Exists(System.IO.Path.Combine(webRoot, "index.html")))
                System.IO.File.WriteAllText(System.IO.Path.Combine(webRoot, "index.html"),
                    "<!DOCTYPE html><html><body>stub</body></html>");
            builder.UseWebRoot(webRoot);

            builder.ConfigureServices(services =>
            {
                // Forward through the field so tests can flip the validator mid-flight
                // (e.g., a happy-path connect followed by a failing-validation replace).
                services.RemoveAll<IReviewAuth>();
                services.AddSingleton<IReviewAuth>(new StubReviewAuth(() =>
                    (Validate ?? (() => Task.FromResult(new AuthValidationResult(
                        Ok: true, Login: "default", Scopes: null,
                        Error: AuthValidationError.None, ErrorDetail: null))))()));
                services.AddSingleton<ILoggerProvider>(Logs);
                ExtraServiceConfig?.Invoke(services);
            });
        }

        protected override void ConfigureClient(System.Net.Http.HttpClient client)
        {
            ArgumentNullException.ThrowIfNull(client);
            base.ConfigureClient(client);
            // Mirror PRismWebApplicationFactory's auto-credential injection so tests don't
            // each have to add Origin / X-PRism-Session.
            var token = Services.GetRequiredService<SessionTokenProvider>().Current;
            client.DefaultRequestHeaders.Add("X-PRism-Session", token);
            client.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
            var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
            if (!string.IsNullOrEmpty(origin))
                client.DefaultRequestHeaders.Add("Origin", origin);
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            Base.Dispose();
        }
    }

    private sealed class StubReviewAuth : IReviewAuth
    {
        private readonly Func<Task<AuthValidationResult>> _validate;
        public StubReviewAuth(Func<Task<AuthValidationResult>> validate) { _validate = validate; }
        public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct) => _validate();
    }

    private static async Task SeedPriorLoginAsync(HarnessFactory f, string login)
    {
        var config = f.Services.GetRequiredService<IConfigStore>();
        await config.InitAsync(default);
        await config.SetDefaultAccountLoginAsync(login, default);
    }

    private static async Task SeedSessionAsync(HarnessFactory f, string prRefKey, ReviewSessionState session)
    {
        var stateStore = f.Services.GetRequiredService<IAppStateStore>();
        await stateStore.UpdateAsync(state =>
        {
            var newSessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions, StringComparer.Ordinal)
            {
                [prRefKey] = session,
            };
            return state.WithDefaultReviews(state.Reviews with { Sessions = newSessions });
        }, default);
    }

    private static ReviewSessionState SessionWithNodeIds(
        string? pendingReviewId = "PR_PENDING_1",
        string draftBody = "draft-body-preserved",
        string replyBody = "reply-body-preserved",
        string? threadId = "PRRT_thread_1",
        string? replyCommentId = "PRRC_reply_1") =>
        new(
            TabStamps: new Dictionary<string, TabStamp>(StringComparer.Ordinal)
            {
                ["tab-a"] = new TabStamp("head1", DateTime.UtcNow),
            },
            LastSeenCommentId: null,
            PendingReviewId: pendingReviewId,
            PendingReviewCommitOid: "oid-pending",
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>
            {
                new("d1", "src/Foo.cs", 1, "RIGHT", null, null, draftBody, DraftStatus.Draft, false, ThreadId: threadId),
            },
            DraftReplies: new List<DraftReply>
            {
                new("r1", "PRRT_thread_existing", replyCommentId, replyBody, DraftStatus.Draft, false),
            },
            DraftSummaryMarkdown: "summary",
            DraftVerdict: DraftVerdict.Comment,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

    private static async Task<HttpResponseMessage> PostReplaceAsync(HttpClient client, string pat = DefaultPat) =>
        await client.PostAsJsonAsync("/api/auth/replace", new { pat });

    [Fact]
    public async Task Same_login_returns_identityChanged_false_and_does_not_mutate_session()
    {
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "alice", Scopes: new[] { "repo" },
                Error: AuthValidationError.None, ErrorDetail: null)),
        };
        await SeedPriorLoginAsync(f, "alice");
        var session = SessionWithNodeIds();
        await SeedSessionAsync(f, SamplePr, session);

        using var client = f.CreateClient();
        using var resp = await PostReplaceAsync(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<ReplaceResponseDto>();
        body.Should().NotBeNull();
        body!.Ok.Should().BeTrue();
        body.Login.Should().Be("alice");
        body.IdentityChanged.Should().BeFalse();

        var loaded = await f.Services.GetRequiredService<IAppStateStore>().LoadAsync(default);
        var s = loaded.Reviews.Sessions[SamplePr];
        s.PendingReviewId.Should().Be("PR_PENDING_1");
        s.DraftComments[0].ThreadId.Should().Be("PRRT_thread_1");
        s.DraftReplies[0].ReplyCommentId.Should().Be("PRRC_reply_1");
    }

    [Fact]
    public async Task Same_login_case_insensitive_returns_identityChanged_false()
    {
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "alice", Scopes: null,
                Error: AuthValidationError.None, ErrorDetail: null)),
        };
        await SeedPriorLoginAsync(f, "Alice");  // capitalized

        using var client = f.CreateClient();
        using var resp = await PostReplaceAsync(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<ReplaceResponseDto>();
        body!.IdentityChanged.Should().BeFalse("login compare is OrdinalIgnoreCase");
    }

    [Fact]
    public async Task Different_login_clears_NodeIds_preserves_draft_bodies_and_publishes_event()
    {
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "bob", Scopes: null,
                Error: AuthValidationError.None, ErrorDetail: null)),
        };
        await SeedPriorLoginAsync(f, "alice");
        var session = SessionWithNodeIds(draftBody: "preserve-me-draft", replyBody: "preserve-me-reply");
        await SeedSessionAsync(f, SamplePr, session);

        // Capture identity-changed event via the real bus (subscribe before driving the
        // endpoint so we don't race the publish).
        var bus = f.Services.GetRequiredService<IReviewEventBus>();
        IdentityChanged? captured = null;
        using var sub = bus.Subscribe<IdentityChanged>(e => captured = e);

        using var client = f.CreateClient();
        using var resp = await PostReplaceAsync(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<ReplaceResponseDto>();
        body!.IdentityChanged.Should().BeTrue();
        body.Login.Should().Be("bob");

        var loaded = await f.Services.GetRequiredService<IAppStateStore>().LoadAsync(default);
        var s = loaded.Reviews.Sessions[SamplePr];
        s.PendingReviewId.Should().BeNull("identity change clears server-issued review id");
        s.PendingReviewCommitOid.Should().BeNull();
        s.DraftComments.Should().HaveCount(1);
        s.DraftComments[0].ThreadId.Should().BeNull("identity change clears thread id");
        s.DraftComments[0].BodyMarkdown.Should().Be("preserve-me-draft", "draft text is preserved verbatim");
        s.DraftReplies.Should().HaveCount(1);
        s.DraftReplies[0].ReplyCommentId.Should().BeNull("identity change clears reply comment id");
        s.DraftReplies[0].ParentThreadId.Should().Be("PRRT_thread_existing", "ParentThreadId is preserved");
        s.DraftReplies[0].BodyMarkdown.Should().Be("preserve-me-reply", "reply text is preserved verbatim");

        captured.Should().NotBeNull("SSE bus must receive IdentityChanged on different login");
        captured!.PriorLogin.Should().Be("alice");
        captured.NewLogin.Should().Be("bob");
    }

    [Fact]
    public async Task Structured_log_emits_identity_changed_record()
    {
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "bob", Scopes: null,
                Error: AuthValidationError.None, ErrorDetail: null)),
        };
        await SeedPriorLoginAsync(f, "alice");
        var session = SessionWithNodeIds();
        await SeedSessionAsync(f, SamplePr, session);

        using var client = f.CreateClient();
        using var resp = await PostReplaceAsync(client);
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        f.Logs.Records.Should().Contain(r =>
            r.FormattedMessage.Contains("Identity changed", StringComparison.Ordinal)
            && r.FormattedMessage.Contains("priorLogin=alice", StringComparison.Ordinal)
            && r.FormattedMessage.Contains("newLogin=bob", StringComparison.Ordinal)
            && r.FormattedMessage.Contains("sessions=1", StringComparison.Ordinal)
            && r.FormattedMessage.Contains("drafts=1", StringComparison.Ordinal)
            && r.FormattedMessage.Contains("replies=1", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Secret_PAT_is_never_present_in_log_output()
    {
        const string secret = "ghp_super_secret_xyz123";
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "bob", Scopes: null,
                Error: AuthValidationError.None, ErrorDetail: null)),
        };
        await SeedPriorLoginAsync(f, "alice");

        using var client = f.CreateClient();
        using var resp = await PostReplaceAsync(client, pat: secret);
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        f.Logs.Records.Should().NotContain(r => r.FormattedMessage.Contains(secret, StringComparison.Ordinal),
            "PAT discipline: the secret must not appear in any log line");
    }

    [Fact]
    public async Task Validation_failure_rolls_back_transient_and_returns_400()
    {
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: false, Login: null, Scopes: null,
                Error: AuthValidationError.InvalidToken, ErrorDetail: "GitHub rejected this token.")),
        };
        await SeedPriorLoginAsync(f, "alice");

        using var client = f.CreateClient();

        // First write a known-good transient via /api/auth/connect so HasToken=true,
        // mimicking the realistic state when Replace is called.
        f.Validate = () => Task.FromResult(new AuthValidationResult(
            Ok: true, Login: "alice", Scopes: null,
            Error: AuthValidationError.None, ErrorDetail: null));
        var connectResp = await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_initial" });
        connectResp.StatusCode.Should().Be(HttpStatusCode.OK);

        // Now flip the validator to fail and call Replace — endpoint must roll back
        // the transient so the old PAT is unaffected.
        f.Validate = () => Task.FromResult(new AuthValidationResult(
            Ok: false, Login: null, Scopes: null,
            Error: AuthValidationError.InvalidToken, ErrorDetail: "rejected"));

        using var resp = await PostReplaceAsync(client, pat: "ghp_bad");
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Old PAT is still committed and readable.
        var tokens = f.Services.GetRequiredService<ITokenStore>();
        (await tokens.HasTokenAsync(default)).Should().BeTrue();
        (await tokens.ReadAsync(default)).Should().Be("ghp_initial");

        f.Logs.Records.Should().NotContain(r =>
            r.FormattedMessage.Contains("Identity changed", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Submit_in_flight_returns_409_with_prRef()
    {
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "bob", Scopes: null,
                Error: AuthValidationError.None, ErrorDetail: null)),
        };
        await SeedPriorLoginAsync(f, "alice");

        // Acquire a submit lock so AnyHeld() reports held=true.
        var locks = f.Services.GetRequiredService<SubmitLockRegistry>();
        var heldRef = new PrReference("acme", "api", 7);
        var handle = await locks.TryAcquireAsync(heldRef, TimeSpan.FromSeconds(1), default);
        handle.Should().NotBeNull();

        try
        {
            using var client = f.CreateClient();
            using var resp = await PostReplaceAsync(client);

            resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
            var raw = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(raw);
            doc.RootElement.GetProperty("ok").GetBoolean().Should().BeFalse();
            doc.RootElement.GetProperty("error").GetString().Should().Be("submit-in-flight");
            doc.RootElement.GetProperty("prRef").GetString().Should().Be("acme/api/7");
        }
        finally
        {
            await handle!.DisposeAsync();
        }
    }

    [Fact]
    public async Task Logger_failure_isolates_endpoint_state_writes()
    {
        // Spec § 14 OQ 4: forensic-log loss must NOT leave the system half-reconciled.
        // Inject a throwing logger provider for the AuthEndpoints category. State
        // mutation, cache wipe, registry wipe, and SSE publish must still run; the
        // response must still be 200 OK.
        var throwingLogs = new ThrowingLoggerProvider();
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "bob", Scopes: null,
                Error: AuthValidationError.None, ErrorDetail: null)),
            ExtraServiceConfig = s => s.AddSingleton<ILoggerProvider>(throwingLogs),
        };
        await SeedPriorLoginAsync(f, "alice");
        var session = SessionWithNodeIds();
        await SeedSessionAsync(f, SamplePr, session);

        var bus = f.Services.GetRequiredService<IReviewEventBus>();
        IdentityChanged? captured = null;
        using var sub = bus.Subscribe<IdentityChanged>(e => captured = e);

        using var client = f.CreateClient();
        using var resp = await PostReplaceAsync(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK,
            "response stays 200 OK even when LogIdentityChanged throws");
        var body = await resp.Content.ReadFromJsonAsync<ReplaceResponseDto>();
        body!.IdentityChanged.Should().BeTrue();

        var loaded = await f.Services.GetRequiredService<IAppStateStore>().LoadAsync(default);
        var s = loaded.Reviews.Sessions[SamplePr];
        s.PendingReviewId.Should().BeNull("state.json mutation persisted despite logger failure");
        s.DraftComments[0].ThreadId.Should().BeNull();

        captured.Should().NotBeNull("SSE publish still ran after logger throw");
    }

    [Fact]
    public async Task No_repos_selected_warning_treated_as_success()
    {
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "bob", Scopes: null,
                Error: AuthValidationError.None, ErrorDetail: null,
                Warning: AuthValidationWarning.NoReposSelected)),
        };
        await SeedPriorLoginAsync(f, "alice");

        using var client = f.CreateClient();
        using var resp = await PostReplaceAsync(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<ReplaceResponseDto>();
        body!.Ok.Should().BeTrue();
        body.IdentityChanged.Should().BeTrue();
    }

#pragma warning disable CA1812 // System.Text.Json instantiates via reflection — analyzer can't see the use.
    private sealed record ReplaceResponseDto(bool Ok, string? Login, string? Host, bool IdentityChanged);
#pragma warning restore CA1812

    private sealed class ThrowingLoggerProvider : ILoggerProvider
    {
        public ILogger CreateLogger(string categoryName) =>
            categoryName.Contains("AuthEndpoints", StringComparison.Ordinal)
                ? new ThrowingLogger()
                : NullLogger.Instance;

        public void Dispose() { }

        private sealed class ThrowingLogger : ILogger
        {
            public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
            public bool IsEnabled(LogLevel logLevel) => true;
            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            {
                ArgumentNullException.ThrowIfNull(formatter);
                var msg = formatter(state, exception);
                // Throw only on LogIdentityChanged, not on every log call (which would
                // mask noise from the other handlers in the request pipeline).
                if (msg.Contains("Identity changed", StringComparison.Ordinal))
                    throw new IOException("disk full");
            }
            private sealed class NullScope : IDisposable
            {
                public static readonly NullScope Instance = new();
                public void Dispose() { }
            }
        }
    }
}
