namespace PRism.GitHub.Feedback;

// The public feedback repo (#211). Compile-time constant — not user-configurable,
// not in state.json. Mirrored by the frontend FEEDBACK_REPO_SLUG.
public static class FeedbackRepo
{
    public const string Owner = "prpande";
    public const string Name = "PRism-feedback";
    public const string Slug = Owner + "/" + Name;
}
