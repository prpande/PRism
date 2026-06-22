import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MarkdownRenderer } from '../src/components/Markdown/MarkdownRenderer';

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
});
