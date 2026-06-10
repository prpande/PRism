namespace PRism.Core.Submit;

// #302 — a single NEW inline review comment posted directly (REST POST /pulls/{n}/comments). Side is
// the GitHub REST value ("LEFT" | "RIGHT"); the endpoint upper-cases DraftComment.Side before building.
public sealed record ReviewCommentRequest(
    string CommitOid,
    string FilePath,
    int LineNumber,
    string Side,
    string BodyMarkdown);
