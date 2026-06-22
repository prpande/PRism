import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

// #583: markdown links in the Overview body / comments must open externally rather
// than navigating the app window away. On desktop, target="_blank" routes the click
// through Electron's setWindowOpenHandler → shell.openExternal (OS browser); in the
// browser-tab build it opens a new tab, leaving the SPA in place. rel guards against
// reverse-tabnabbing / referrer leakage in the browser build.
describe('MarkdownRenderer links (#583)', () => {
  it('renders an https link as target="_blank" with rel="noopener noreferrer"', () => {
    render(<MarkdownRenderer source={'[PR](https://github.com/o/r/pull/1)'} />);
    const a = screen.getByRole('link', { name: 'PR' });
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(a).toHaveAttribute('href', 'https://github.com/o/r/pull/1');
  });

  it('applies target/rel to a bare autolink too', () => {
    render(<MarkdownRenderer source={'<https://example.com/x>'} />);
    const a = screen.getByRole('link');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(a).toHaveAttribute('href', 'https://example.com/x');
  });

  it("does not leak react-markdown's non-DOM `node` prop onto the anchor", () => {
    const { container } = render(
      <MarkdownRenderer source={'[PR](https://github.com/o/r/pull/1)'} />,
    );
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a).not.toHaveAttribute('node');
  });

  it('leaves an in-page fragment link inert (urlTransform strips the href, so _blank is harmless)', () => {
    // GFM footnotes and #section links carry a `#...` href that the renderer's
    // https?:/mailto:-only urlTransform strips, so they render hrefless — adding
    // target="_blank" cannot pop a new tab. Locks in that the blanket `a` override
    // does not regress in-page navigation.
    const { container } = render(<MarkdownRenderer source={'[frag](#section)'} />);
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a).not.toHaveAttribute('href');
  });
});
