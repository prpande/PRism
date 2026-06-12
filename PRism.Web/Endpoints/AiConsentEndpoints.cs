using PRism.Core.Ai;
using PRism.Core.Config;

namespace PRism.Web.Endpoints;

internal static class AiConsentEndpoints
{
    internal sealed record ConsentRequest(string DisclosureVersion);

    public static IEndpointRouteBuilder MapAiConsent(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/ai/egress-disclosure", (AiConsentState consent) =>
            Results.Ok(new
            {
                recipient = EgressDisclosure.Recipient,
                dataCategories = EgressDisclosure.DataCategories,
                disclosureVersion = EgressDisclosure.CurrentVersion,
                alreadyConsented = consent.IsConsented(AiProviderIds.Claude, EgressDisclosure.CurrentVersion),
            }));

        app.MapPost("/api/ai/consent", async (
            ConsentRequest body, IConfigStore config, CancellationToken ct) =>
        {
            if (body is null || body.DisclosureVersion != EgressDisclosure.CurrentVersion)
                return Results.StatusCode(StatusCodes.Status409Conflict);
            await config.RecordAiConsentAsync(AiProviderIds.Claude, EgressDisclosure.CurrentVersion, ct).ConfigureAwait(false);
            return Results.NoContent();
        });

        return app;
    }
}
