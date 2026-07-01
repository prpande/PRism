// Shared Octicon comment-16. Single source for the inbox PR-row comment-count
// glyph (#501) and the file-tree per-file comment indicator (#513) so the two
// sites cannot drift in shape. State-agnostic: colour comes from the consumer
// via currentColor; the consumer attaches sizing/layout through className.
interface CommentGlyphProps {
  /** Layout/sizing class for the host (e.g. the inbox pill-icon class). */
  className?: string;
}

export function CommentGlyph({ className }: CommentGlyphProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-9.5C0 1.784.784 1 1.75 1ZM1.5 2.75v8.5a.25.25 0 0 0 .25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25Z" />
    </svg>
  );
}
