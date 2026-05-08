import { useState } from 'react';
import { MarkdownRenderer } from '../../../Markdown/MarkdownRenderer';

export interface MarkdownFileViewProps {
  rawContent: string;
  isLoading: boolean;
}

export function MarkdownFileView({ rawContent, isLoading }: MarkdownFileViewProps) {
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered');

  if (isLoading) {
    return <div className="markdown-file-view muted">Loading file content…</div>;
  }

  return (
    <div className="markdown-file-view">
      <div className="markdown-file-view-toolbar">
        <button
          className={`toggle-btn ${mode === 'rendered' ? 'toggle-btn--active' : ''}`}
          onClick={() => setMode('rendered')}
          aria-pressed={mode === 'rendered'}
        >
          Rendered
        </button>
        <button
          className={`toggle-btn ${mode === 'raw' ? 'toggle-btn--active' : ''}`}
          onClick={() => setMode('raw')}
          aria-pressed={mode === 'raw'}
        >
          Raw diff
        </button>
      </div>
      <div className="markdown-file-view-content">
        {mode === 'rendered' ? (
          <MarkdownRenderer source={rawContent} />
        ) : (
          <pre className="markdown-raw"><code>{rawContent}</code></pre>
        )}
      </div>
    </div>
  );
}
