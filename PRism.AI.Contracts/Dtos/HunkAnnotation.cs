namespace PRism.AI.Contracts.Dtos;

public sealed record HunkAnnotation(string Path, int HunkIndex, string Body, AnnotationTone Tone);

public enum AnnotationTone
{
    Calm,
    HeadsUp,
    Concern,
}
