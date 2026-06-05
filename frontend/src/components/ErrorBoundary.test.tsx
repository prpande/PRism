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

  it('renders the fallback message inside a role="alert" node', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. The error has been logged.');
  });

  it('keeps the "Reload" button OUTSIDE the alert region', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    // a11y guarantee: the action button must not be announced as part of the alert.
    expect(alert.textContent).not.toContain('Reload');
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });
});
