using System.IO;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Web.Tests.Endpoints;

namespace PRism.Web.Tests.TestHelpers;

public sealed class PRismWebApplicationFactory : WebApplicationFactory<Program>
{
    public string DataDir { get; } = Path.Combine(Path.GetTempPath(), $"PRism-test-{Guid.NewGuid():N}");
    public Func<Task<AuthValidationResult>>? ValidateOverride { get; set; }
    public FakeInboxRefreshOrchestrator? FakeOrchestrator { get; set; }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        Directory.CreateDirectory(DataDir);
        builder.UseSetting("DataDir", DataDir);
        builder.UseEnvironment("Test");

        builder.ConfigureServices(services =>
        {
            // Replace IReviewService with a stub when ValidateOverride is set.
            if (ValidateOverride is not null)
            {
                var existing = services.FirstOrDefault(d => d.ServiceType == typeof(IReviewService));
                if (existing is not null) services.Remove(existing);
                services.AddSingleton<IReviewService>(new StubReviewService(ValidateOverride));
            }

            // Replace IInboxRefreshOrchestrator with a fake when FakeOrchestrator is set.
            if (FakeOrchestrator is not null)
            {
                var existing = services.FirstOrDefault(d => d.ServiceType == typeof(IInboxRefreshOrchestrator));
                if (existing is not null) services.Remove(existing);
                services.AddSingleton<IInboxRefreshOrchestrator>(FakeOrchestrator);
            }
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        try { if (Directory.Exists(DataDir)) Directory.Delete(DataDir, recursive: true); }
#pragma warning disable CA1031 // best-effort cleanup of temp dir
        catch { }
#pragma warning restore CA1031
    }
}

internal sealed class StubReviewService : IReviewService
{
    private readonly Func<Task<AuthValidationResult>> _validate;
    public StubReviewService(Func<Task<AuthValidationResult>> validate) { _validate = validate; }

    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct) => _validate();
    public Task<InboxSection[]> GetInboxAsync(CancellationToken ct) => throw new NotImplementedException();
    public bool TryParsePrUrl(string url, out PrReference? reference) => throw new NotImplementedException();
    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotImplementedException();
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<string> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct) => throw new NotImplementedException();
    public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct) => throw new NotImplementedException();
}
