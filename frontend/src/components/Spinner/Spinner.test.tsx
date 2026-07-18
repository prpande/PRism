import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Spinner } from './';

describe('Spinner', () => {
  it('renders a status live region announcing the default label', () => {
    render(<Spinner />);
    const status = screen.getByRole('status');
    // The `status` role names from author, not content, so the announceable
    // signal lives in the live region's text content (sr-only). Assert that
    // content directly — guards against a silently-dropped label.
    expect(within(status).getByText(/loading/i)).toBeInTheDocument();
  });

  it('honors a custom non-empty label', () => {
    render(<Spinner label="Loading whole file…" />);
    const status = screen.getByRole('status');
    expect(within(status).getByText(/loading whole file/i)).toBeInTheDocument();
    expect(status.textContent?.trim()).not.toBe('');
  });

  it('applies the size class to the ring and hides it from assistive tech', () => {
    const { container } = render(<Spinner size="lg" />);
    const ring = container.querySelector('[aria-hidden="true"]');
    expect(ring).not.toBeNull();
    // CSS-module class names are hashed; assert the size token is present in the class list.
    expect(ring?.className).toMatch(/lg/);
  });

  it('forwards a layout className to the root without dropping the status role', () => {
    render(<Spinner className="my-layout" />);
    const status = screen.getByRole('status');
    expect(status.className).toMatch(/my-layout/);
  });
});
