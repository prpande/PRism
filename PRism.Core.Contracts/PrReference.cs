namespace PRism.Core.Contracts;

public sealed record PrReference(string Owner, string Repo, int Number)
{
    /// <summary>
    /// Canonical PR identifier used as the key in enrichment maps and in
    /// AI-seam DTOs (InboxItemEnrichment.PrId). Format: "&lt;owner&gt;/&lt;repo&gt;#&lt;number&gt;".
    /// Distinct from ToString() which uses slash-slash for log readability.
    /// </summary>
    public string PrId => $"{Owner}/{Repo}#{Number}";

    public override string ToString() => $"{Owner}/{Repo}/{Number}";
}
