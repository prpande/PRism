namespace PRism.Web.Endpoints;

// Request shapes for the PR-detail mutating endpoints (spec § 8). Response shapes are
// the contract DTOs (PrDetailDto, DiffDto, FileContentResult) defined in PRism.Core.Contracts.

internal sealed record MarkViewedRequest(string HeadSha, string? MaxCommentId);

internal sealed record FileViewedRequest(string Path, string HeadSha, bool Viewed);
