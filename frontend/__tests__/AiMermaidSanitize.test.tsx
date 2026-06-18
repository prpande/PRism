import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MarkdownRenderer } from '../src/components/Markdown/MarkdownRenderer';

// Bypass the global setup-mermaid mock so the real mermaid library runs.
vi.unmock('mermaid');

describe('AI body coerces a mermaid fence — real mermaid, no live markup', () => {
  it('renders the safe error fallback (jsdom cannot lay out SVG), never a live <script>', async () => {
    const { container } = render(
      <MarkdownRenderer source={'```mermaid\n<script>alert(1)</script>\n```'} className="ai-markdown" />,
    );
    // Real mermaid initializes with securityLevel:'strict' then throws on layout
    // under jsdom (no getBBox) → MermaidBlock's catch renders .mermaid-error. The
    // worst case for an AI-coerced fence in our runtime is this inert fallback.
    await waitFor(() =>
      expect(container.querySelector('.mermaid-error, .mermaid-diagram')).not.toBeNull(),
    );
    expect(document.querySelector('script')).toBeNull();
  });
});
