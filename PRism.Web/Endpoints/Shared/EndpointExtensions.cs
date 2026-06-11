using Microsoft.AspNetCore.Mvc;

namespace PRism.Web.Endpoints;

internal static class EndpointExtensions
{
    internal const int MutatingBodyCapBytes = 16 * 1024; // 16 KiB - single source of truth

    /// <summary>Attaches the body cap as routing metadata. NOTE: RequestSizeLimitAttribute does
    /// not fire pre-binding for minimal APIs (see RequestSizeLimitTests) - the Program.cs
    /// middleware predicate is the load-bearing cap. Defined for future use; NOT wired to any
    /// route in this PR.</summary>
    internal static RouteHandlerBuilder WithBodyCap(this RouteHandlerBuilder builder) =>
        builder.WithMetadata(new RequestSizeLimitAttribute(MutatingBodyCapBytes));
}
