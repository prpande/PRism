import { useState } from 'react';
import { MarkdownRenderer } from '../../../Markdown/MarkdownRenderer';
import styles from './MarkdownFileView.module.css';

export interface MarkdownFileViewProps {
  rawContent: string;
  isLoading: boolean;
}

export function MarkdownFileView({ rawContent, isLoading }: MarkdownFileViewProps) {
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered');

  if (isLoading) {
    return (
      <div
        className={`markdown-file-view muted ${styles.markdownFileView}`}
        data-testid="markdown-file-view"
      >
        Loading file content…
      </div>
    );
  }

  return (
    <div
      className={`markdown-file-view ${styles.markdownFileView}`}
      data-testid="markdown-file-view"
    >
      <div className={`markdown-file-view-toolbar ${styles.markdownFileViewToolbar}`}>
        <button
          className={`toggle-btn ${mode === 'rendered' ? 'toggle-btn--active' : ''} ${styles.toggleBtn}${mode === 'rendered' ? ` ${styles.toggleBtnActive}` : ''}`}
          onClick={() => setMode('rendered')}
          aria-pressed={mode === 'rendered'}
        >
          Rendered
        </button>
        <button
          className={`toggle-btn ${mode === 'raw' ? 'toggle-btn--active' : ''} ${styles.toggleBtn}${mode === 'raw' ? ` ${styles.toggleBtnActive}` : ''}`}
          onClick={() => setMode('raw')}
          aria-pressed={mode === 'raw'}
        >
          Raw diff
        </button>
      </div>
      <div className={`markdown-file-view-content ${styles.markdownFileViewContent}`}>
        {mode === 'rendered' ? (
          <div data-testid="markdown-rendered">
            <MarkdownRenderer source={rawContent} />
          </div>
        ) : (
          <pre className={`markdown-raw ${styles.markdownRaw}`} data-testid="markdown-raw">
            <code>{rawContent}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
