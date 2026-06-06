import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MermaidBlock } from '../src/components/Markdown/MermaidBlock';

// Issue #191: invalid Mermaid diagrams leak Mermaid's built-in "Syntax error in
// text" bomb SVG into `document.body`, where it accumulates at the bottom of the
// page across every route. The fix is `suppressErrorRendering: true` in
// MermaidBlock's single `mermaid.initialize({...})` call.
//
// This file runs against the REAL Mermaid library — the rest of the suite mocks
// it globally via `__tests__/setup-mermaid.ts`, so we unmock here. A dedicated
// file gives a fresh module graph (Vitest per-file isolation): MermaidBlock's
// module-level `mermaidInitialized` guard starts false, so the component's own
// `initialize({ … suppressErrorRendering: true })` actually runs and the
// component's bare `import('mermaid')` resolves the real library, not the mock.
//
// Inputs here MUST be invalid Mermaid syntax only: real Mermaid cannot lay out a
// valid SVG under jsdom (no getBBox), and the parse-failure path is what leaks.
//
// `vi.unmock` is NOT hoisted (unlike `vi.mock`), so it sits below the imports —
// which is safe ONLY because MermaidBlock loads mermaid via a dynamic
// `import('mermaid')` inside useEffect that resolves at render time, after this
// unmock has run. If that dynamic import is ever converted to a static top-level
// import, this test would silently bind to the global mock instead of the real
// library (a false green); move the unmock into a hoisted setup if so.
vi.unmock('mermaid');

// The bomb is uniquely identified by Mermaid's error-graphic classes and caption,
// none of which our own `.mermaid-error` fallback emits — so these select the
// leaked node specifically, not our fallback.
function bombNodeCount(): number {
  return document.querySelectorAll('.error-icon, .error-text').length;
}

// Invalid Mermaid sources that fail to parse. None contains the strings we assert
// on ("Syntax error in text", "error-icon"), so a match means a real leak.
const INVALID_DIAGRAMS = [
  'graph TD;\n  A--<<<>>B not valid',
  'sequenceDiagram\n  >>> totally broken <<<',
  'flowchart LR\n  ??? %%% invalid %%%',
];

describe('MermaidBlock — issue #191: no error/bomb graphic leaks into document.body', () => {
  it('shows the .mermaid-error fallback and leaks no bomb node on a single invalid diagram', async () => {
    const { container } = render(<MermaidBlock code={INVALID_DIAGRAMS[0]} />);

    // The component's catch fires (render still throws) → our quiet fallback renders.
    await waitFor(() => {
      expect(container.querySelector('.mermaid-error')).not.toBeNull();
    });

    // The actual bug: nothing leaked into document.body.
    expect(bombNodeCount()).toBe(0);
    expect(document.body.textContent ?? '').not.toContain('Syntax error in text');
  });

  it('leaves document.body clean after several invalid diagrams (no accumulation)', async () => {
    // The issue's defining symptom is that "multiple failures accumulate" at the
    // bottom of the page. Render several invalid diagrams in sequence and assert
    // the body never collects a single bomb node.
    for (const code of INVALID_DIAGRAMS) {
      const { container } = render(<MermaidBlock code={code} />);
      await waitFor(() => {
        expect(container.querySelector('.mermaid-error')).not.toBeNull();
      });
    }

    expect(bombNodeCount()).toBe(0);
    expect(document.body.textContent ?? '').not.toContain('Syntax error in text');
  });
});
