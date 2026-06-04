import { render, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MarkdownRenderer } from '../src/components/Markdown/MarkdownRenderer';
import { getHighlighterAsync } from '../src/components/Markdown/shikiInstance';

describe('MarkdownRenderer syntax highlighting', () => {
  it('highlights a fenced code block with a known language', async () => {
    await getHighlighterAsync();
    const { container } = render(<MarkdownRenderer source={'```ts\nconst x = 1;\n```'} />);
    await waitFor(() => {
      expect(container.querySelector('.codeToken')).not.toBeNull();
    });
    expect(container.querySelector('code')!.textContent).toContain('const x = 1;');
  });

  it('renders an unknown fence language as plain code (no tokens)', async () => {
    await getHighlighterAsync();
    const { container } = render(<MarkdownRenderer source={'```nope\nplain text\n```'} />);
    expect(container.querySelector('code')!.textContent).toContain('plain text');
    expect(container.querySelector('.codeToken')).toBeNull();
  });

  it('leaves mermaid fences to MermaidBlock (no token spans)', async () => {
    await getHighlighterAsync();
    const { container } = render(<MarkdownRenderer source={'```mermaid\ngraph TD; A-->B;\n```'} />);
    expect(container.querySelector('.codeToken')).toBeNull();
  });
});
