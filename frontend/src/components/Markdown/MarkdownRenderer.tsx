import { lazy, Suspense, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import {
  getHighlighterAsync,
  tokenizeLines,
  SHIKI_LANGS_SET,
  type ShikiLang,
} from './shikiInstance';
import { HighlightedLine } from './HighlightedLine';

const MermaidBlock = lazy(() =>
  import('./MermaidBlock').then((m) => ({ default: m.MermaidBlock })),
);

// Common fence-tag aliases (e.g. ```ts → typescript, ```py → python). The
// canonical names themselves come from SHIKI_LANGS_SET so the supported-fence
// list can't drift from the grammars actually loaded.
const FENCE_ALIASES: Record<string, ShikiLang> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  cs: 'csharp',
  sh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
};

function fenceLang(info: string | undefined): ShikiLang | null {
  const tag = (info ?? '').trim().toLowerCase();
  if (SHIKI_LANGS_SET.has(tag as ShikiLang)) return tag as ShikiLang;
  return FENCE_ALIASES[tag] ?? null;
}

function HighlightedCodeBlock({ code, lang }: { code: string; lang: ShikiLang }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void getHighlighterAsync()
      .then(() => {
        if (live) setReady(true);
      })
      .catch(() => {
        // Highlighter unavailable (e.g. WASM load failure): the bare-code
        // fallback rendered below is the correct graceful degradation, so we
        // intentionally stay un-ready rather than surfacing an error.
      });
    return () => {
      live = false;
    };
  }, []);

  if (!ready) {
    // Pre-resolve: existing bare-code DOM shape (no flash, stable for security tests).
    return <code className={`language-${lang}`}>{code}</code>;
  }
  const lines = tokenizeLines(code, lang);
  const rawLines = code.split('\n');
  return (
    <code className={`language-${lang}`}>
      {lines.map((tokens, i) => (
        <span key={i}>
          <HighlightedLine spans={tokens} fallback={rawLines[i] ?? ''} />
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </code>
  );
}

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

// Defined once at module scope (it closes over no props) so ReactMarkdown
// receives a stable `components.code` identity across renders — otherwise every
// parent re-render (theme toggle, status banner) would remount each
// HighlightedCodeBlock and re-flash its load state.
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

    const shikiLang = fenceLang(lang);
    if (shikiLang) {
      return <HighlightedCodeBlock code={codeString} lang={shikiLang} />;
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

export interface MarkdownRendererProps {
  source: string;
  className?: string;
}

export function MarkdownRenderer({ source, className }: MarkdownRendererProps) {
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
