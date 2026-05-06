using System.Diagnostics.CodeAnalysis;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.Web.Endpoints;

internal sealed record InboxResponse(
    IReadOnlyList<InboxSectionDto> Sections,
    IReadOnlyDictionary<string, InboxItemEnrichment> Enrichments,
    DateTimeOffset LastRefreshedAt,
    bool TokenScopeFooterEnabled);

internal sealed record InboxSectionDto(
    string Id,
    string Label,
    IReadOnlyList<PrInboxItem> Items);

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "Wire-shape DTO: Url is a raw user-supplied string that may not be a valid URI; it is validated in the endpoint.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "Wire-shape DTO: Url is deserialized from JSON as a raw string.")]
internal sealed record ParsePrUrlRequest(string? Url);

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "Wire-shape DTO: UrlHost carries the host-only string extracted from a URL for structured error reporting.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "Wire-shape DTO: UrlHost is a plain host string in the JSON error payload.")]
internal sealed record ParsePrUrlResponse(
    bool Ok,
    PrReference? Ref,
    string? Error,
    string? ConfiguredHost,
    string? UrlHost);
