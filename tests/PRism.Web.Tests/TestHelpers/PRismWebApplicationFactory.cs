using System.IO;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.Web.Tests.TestHelpers;

public sealed class PRismWebApplicationFactory : WebApplicationFactory<Program>
{
    public string DataDir { get; } = Path.Combine(Path.GetTempPath(), $"PRism-test-{Guid.NewGuid():N}");
    public Func<Task<AuthValidationResult>>? ValidateOverride { get; set; }
    public FakeInboxRefreshOrchestrator? FakeOrchestrator { get; set; }
    public IReviewService? ReviewServiceOverride { get; set; }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        Directory.CreateDirectory(DataDir);

        // Provide a deterministic wwwroot/index.html so MapFallbackToFile("index.html")
        // can serve SPA routes during tests, regardless of whether the frontend bundle
        // has been built. The stub marker lets tests prove the fallback path served the
        // response. DataDir is deleted recursively in Dispose, so wwwroot/ goes with it.
        var webRoot = Path.Combine(DataDir, "wwwroot");
        Directory.CreateDirectory(webRoot);
        File.WriteAllText(
            Path.Combine(webRoot, "index.html"),
            "<!DOCTYPE html><html><body>PRism test stub</body></html>");
        builder.UseWebRoot(webRoot);

        builder.UseSetting("DataDir", DataDir);
        builder.UseEnvironment("Test");

        builder.ConfigureServices(services =>
        {
            // Replace IReviewService with a fully-scripted fake when ReviewServiceOverride
            // is set (PR-detail tests). Falls through to the validate-only stub branch when
            // ValidateOverride is set instead. ReviewServiceOverride takes precedence.
            if (ReviewServiceOverride is not null)
            {
                var existing = services.FirstOrDefault(d => d.ServiceType == typeof(IReviewService));
                if (existing is not null) services.Remove(existing);
                services.AddSingleton(ReviewServiceOverride);
            }
            else if (ValidateOverride is not null)
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

    // Legacy S0+S1 surface — unused.
    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<PRism.Core.Contracts.PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotImplementedException();
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();

    // S3 PR detail surface.
    public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct) => throw new NotImplementedException();
    public Task<PRism.Core.Iterations.ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct) => throw new NotImplementedException();
    public Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();

    public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct) => throw new NotImplementedException();
}
