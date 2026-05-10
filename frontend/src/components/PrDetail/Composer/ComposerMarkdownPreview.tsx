import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';

export interface ComposerMarkdownPreviewProps {
  body: string;
}

// Per addendum A3: tabIndex={0} so Tab from the textarea reaches the
// preview pane when toggled on. role="region" + aria-label makes the
// preview a discoverable landmark for screen readers.
export function ComposerMarkdownPreview({ body }: ComposerMarkdownPreviewProps) {
  return (
    <div
      role="region"
      aria-label="Markdown preview"
      tabIndex={0}
      className="composer-markdown-preview"
    >
      {body.trim().length === 0 ? (
        <p className="muted">Nothing to preview yet.</p>
      ) : (
        <MarkdownRenderer source={body} />
      )}
    </div>
  );
}
