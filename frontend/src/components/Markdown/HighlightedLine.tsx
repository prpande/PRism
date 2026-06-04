import type { LineToken } from './shikiInstance';

export interface MergedSpan extends LineToken {
  change?: 'insert' | 'delete';
}

export interface HighlightedLineProps {
  spans: MergedSpan[];
  fallback: string;
}

// Global class strings (defined in tokens.css) — NOT CSS-module imports, so the
// html[data-theme] dual-theme selector matches the rendered class.
export function HighlightedLine({ spans, fallback }: HighlightedLineProps) {
  if (spans.length === 0) {
    return (
      <span className="codeLine">
        <span>{fallback}</span>
      </span>
    );
  }
  return (
    <span className="codeLine">
      {spans.map((s, i) => {
        let cls = 'codeToken';
        if (s.change === 'insert') cls += ' wordDiffInsertBg';
        else if (s.change === 'delete') cls += ' wordDiffDeleteBg';
        return (
          <span key={i} className={cls} style={s.style}>
            {s.text}
          </span>
        );
      })}
    </span>
  );
}
