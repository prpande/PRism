import { useEffect, useRef, useState } from 'react';

let mermaidInitialized = false;
let mermaidIdCounter = 0;

export interface MermaidBlockProps {
  code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${++mermaidIdCounter}`;

    import('mermaid').then(async (mod) => {
      const mermaid = mod.default;
      if (!mermaidInitialized) {
        mermaid.initialize({
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          startOnLoad: false,
        });
        mermaidInitialized = true;
      }

      try {
        const result = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(result.svg);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Mermaid render failed');
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-error">
        <p className="muted">Mermaid render failed</p>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-loading muted">Loading diagram…</div>;
  }

  return (
    <div ref={containerRef} className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}
