using System.Diagnostics.CodeAnalysis;

using PRism.Core.Contracts;

namespace PRism.Core;

// Capability sub-interface from the ADR-S5-1 split of IReviewService.
// See docs/specs/2026-05-11-s5-submit-pipeline-design.md § 3.
public interface IPrDiscovery
{
    Task<InboxSection[]> GetInboxAsync(CancellationToken ct);

    [SuppressMessage("Design", "CA1054:URI-like parameters should not be strings",
        Justification = "URL is parsed by callers from user input; conversion to Uri is exactly what this method does.")]
    bool TryParsePrUrl(string url, out PrReference? reference);
}
