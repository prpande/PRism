import { lazy, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

const MermaidBlock = lazy(() =>
  import('./MermaidBlock').then((m) => ({ default: m.MermaidBlock })),
);

const ALLOWED_URL_SCHEMES = /^(https?|mailto):/i;

function urlTransform(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  try {
    const decoded = decodeURIComponent(trimmed);
    if (!ALLOWED_URL_SCHEMES.test(decoded)) return undefined;
  } catch {
    // decodeURIComponent failed — still test the raw url
  }
  if (!ALLOWED_URL_SCHEMES.test(trimmed)) return undefined;
  return trimmed;
}

export interface MarkdownRendererProps {
  source: string;
  className?: string;
}

export function MarkdownRenderer({ source, className }: MarkdownRendererProps) {
  const components: Components = {
    code({ className: codeClassName, children, ...props }) {
      const match = /language-(\w+)/.exec(codeClassName || '');
      const lang = match?.[1];
      const codeString = String(children).replace(/\n$/, '');

      if (lang === 'mermaid') {
        return (
          <Suspense fallback={<div className="mermaid-loading muted">Loading diagram…</div>}>
            <MermaidBlock code={codeString} />
          </Suspense>
        );
      }

      if (lang) {
        return (
          <code className={codeClassName} {...props}>
            {children}
          </code>
        );
      }

      return <code {...props}>{children}</code>;
    },
  };

  return (
    <div className={className ? `markdown-body ${className}` : 'markdown-body'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
