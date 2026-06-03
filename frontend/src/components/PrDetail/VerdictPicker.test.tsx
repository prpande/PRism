import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerdictPicker } from './VerdictPicker';

// Issue #123: the three verbs must carry semantic colors when selected
// (Approve→green, Request changes→red, Comment→neutral). The color is applied
// purely in CSS via a per-verb selector, so the seam under test is the
// `data-verdict` hook on each segment plus the `--selected` class landing only
// on the active verb. (The actual hue is asserted visually — Playwright — since
// jsdom doesn't resolve CSS custom properties.)
describe('VerdictPicker per-verb semantic hooks', () => {
  it('tags every segment with a data-verdict matching its value', () => {
    render(<VerdictPicker value={null} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute(
      'data-verdict',
      'approve',
    );
    expect(screen.getByRole('button', { name: 'Request changes' })).toHaveAttribute(
      'data-verdict',
      'request-changes',
    );
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveAttribute(
      'data-verdict',
      'comment',
    );
  });

  it('marks only the active verb selected so the per-verb color targets it alone', () => {
    render(<VerdictPicker value="request-changes" onChange={() => {}} />);
    const requestChanges = screen.getByRole('button', { name: 'Request changes' });
    expect(requestChanges).toHaveClass('verdict-picker__segment--selected');
    expect(requestChanges).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Approve' })).not.toHaveClass(
      'verdict-picker__segment--selected',
    );
    expect(screen.getByRole('button', { name: 'Comment' })).not.toHaveClass(
      'verdict-picker__segment--selected',
    );
  });
});
