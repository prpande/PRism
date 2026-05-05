namespace PRism.Core.Contracts;

public sealed record PrReference(string Owner, string Repo, int Number)
{
    public override string ToString() => $"{Owner}/{Repo}/{Number}";
}
