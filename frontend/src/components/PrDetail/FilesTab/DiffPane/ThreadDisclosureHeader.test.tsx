import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ThreadDisclosureHeader } from './ThreadDisclosureHeader';

function props(over = {}) {
  return {
    collapsed: true,
    onToggle: () => {},
    bodyId: 'thread-body-t1',
    author: 'amelia.cho',
    avatarUrl: null,
    snippet: 'Looks like a race here',
    commentCount: 2,
    isResolved: true,
    filePath: 'src/Calc.cs',
    lineNumber: 5,
    ...over,
  };
}

describe('ThreadDisclosureHeader', () => {
  it('collapsed: shows author, snippet, count glyph, Resolved; aria-expanded=false', () => {
    render(<ThreadDisclosureHeader {...props()} />);
    const btn = screen.getByTestId('thread-disclosure');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-controls', 'thread-body-t1');
    expect(btn).toHaveAccessibleName(/expand thread on src\/Calc\.cs line 5/i);
    expect(screen.getByText('amelia.cho')).toBeInTheDocument();
    expect(screen.getByText(/Looks like a race here/)).toBeInTheDocument();
    // Count is a glyph + number labelled for assistive tech, not "N comments" prose.
    expect(screen.getByLabelText('2 comments')).toHaveTextContent('2');
    expect(screen.getByLabelText('Resolved thread')).toBeInTheDocument();
  });

  it('expanded: toggle + Resolved pill, but no author/snippet/count; aria-expanded=true', () => {
    render(<ThreadDisclosureHeader {...props({ collapsed: false })} />);
    const btn = screen.getByTestId('thread-disclosure');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveAccessibleName(/collapse thread on src\/Calc\.cs line 5/i);
    expect(screen.queryByText('amelia.cho')).not.toBeInTheDocument();
    expect(screen.queryByText(/Looks like a race here/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/comments?$/)).not.toBeInTheDocument();
    // The resolved pill stays visible after the thread is expanded.
    expect(screen.getByLabelText('Resolved thread')).toBeInTheDocument();
  });

  it('expanded + non-resolved: no Resolved pill', () => {
    render(<ThreadDisclosureHeader {...props({ collapsed: false, isResolved: false })} />);
    expect(screen.queryByLabelText('Resolved thread')).not.toBeInTheDocument();
  });

  it('count is singular for 1 and omitted for 0', () => {
    const { rerender } = render(<ThreadDisclosureHeader {...props({ commentCount: 1 })} />);
    expect(screen.getByLabelText('1 comment')).toHaveTextContent('1');
    rerender(<ThreadDisclosureHeader {...props({ commentCount: 0 })} />);
    expect(screen.queryByLabelText(/comments?$/)).not.toBeInTheDocument();
  });

  it('omits the snippet slot when snippet is empty (image-only/empty body)', () => {
    render(<ThreadDisclosureHeader {...props({ snippet: '' })} />);
    expect(screen.queryByTestId('thread-snippet')).not.toBeInTheDocument();
  });

  it('non-resolved: no Resolved badge', () => {
    render(<ThreadDisclosureHeader {...props({ isResolved: false })} />);
    expect(screen.queryByLabelText('Resolved thread')).not.toBeInTheDocument();
  });

  it('activating the button calls onToggle (click + keyboard)', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<ThreadDisclosureHeader {...props({ onToggle })} />);
    const btn = screen.getByTestId('thread-disclosure');
    await user.click(btn);
    btn.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(3);
  });

  it('truncated snippet carries a title for mouse hover', () => {
    render(<ThreadDisclosureHeader {...props({ snippet: 'full text here' })} />);
    expect(screen.getByTestId('thread-snippet')).toHaveAttribute('title', 'full text here');
  });

  it('omits the line fragment when the thread is unanchored (lineNumber null)', () => {
    render(<ThreadDisclosureHeader {...props({ lineNumber: null })} />);
    expect(screen.getByTestId('thread-disclosure')).toHaveAccessibleName(
      'Expand thread on src/Calc.cs',
    );
  });
});
