import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Snackbar } from './Snackbar';

describe('Snackbar', () => {
  it('renders message and action', async () => {
    const onClick = vi.fn();
    render(
      <Snackbar
        tone="danger"
        message="boom"
        action={{ label: 'Fix', onClick }}
        role="status"
        ariaLive="polite"
      />,
    );
    expect(screen.getByText('boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fix' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('renders dismiss only when onDismiss is provided', () => {
    const { rerender } = render(
      <Snackbar tone="warning" message="m" role="status" ariaLive="polite" />,
    );
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    rerender(
      <Snackbar tone="warning" message="m" onDismiss={() => {}} role="status" ariaLive="polite" />,
    );
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('applies the tone class', () => {
    // This project hashes CSS-module class names (e.g. `_danger_40f9fd`), so we
    // assert the tone is reflected in the className rather than matching the raw
    // token. A different tone must produce a different class.
    const { container } = render(
      <Snackbar tone="danger" message="m" role="status" ariaLive="polite" />,
    );
    const danger = container.firstChild as HTMLElement;
    expect(danger.className).toMatch(/danger/);

    const { container: warnContainer } = render(
      <Snackbar tone="warning" message="m" role="status" ariaLive="polite" />,
    );
    const warning = warnContainer.firstChild as HTMLElement;
    expect(warning.className).toMatch(/warning/);
    expect(warning.className).not.toBe(danger.className);
  });
});
