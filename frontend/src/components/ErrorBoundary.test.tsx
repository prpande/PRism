import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

// A child that throws during render to trip the boundary's
// getDerivedStateFromError / componentDidCatch path.
function Boom(): never {
  throw new Error('kaboom');
}

describe('ErrorBoundary fallback', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs the caught error to console.error during the throwing render;
    // silence the expected noise so the test output stays clean.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders the fallback as an alertdialog containing the message', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Something went wrong');
    expect(dialog).toHaveTextContent('The error has been logged.');
  });

  it('renders the "Reload" button INSIDE the alertdialog (message + action as one unit)', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const dialog = screen.getByRole('alertdialog');
    const reload = screen.getByRole('button', { name: /reload/i });
    // The recovery action is a legitimate control within the labelled dialog.
    expect(dialog).toContainElement(reload);
  });
});
