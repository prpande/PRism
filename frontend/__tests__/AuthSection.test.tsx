import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthSection } from '../src/components/Settings/AuthSection';

vi.mock('../src/hooks/useSubmitInFlight', () => ({
  useSubmitInFlight: vi.fn(),
}));

import { useSubmitInFlight } from '../src/hooks/useSubmitInFlight';

const mockedUseSubmitInFlight = vi.mocked(useSubmitInFlight);

describe('AuthSection Replace link', () => {
  beforeEach(() => {
    mockedUseSubmitInFlight.mockReset();
  });

  it('renders an enabled Replace token link when no submit is in flight', () => {
    mockedUseSubmitInFlight.mockReturnValue({ inFlight: false, prRef: null });
    render(
      <MemoryRouter>
        <AuthSection />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /replace token/i });
    expect(link).toHaveAttribute('href', '/setup?replace=1');
    expect(link).not.toHaveAttribute('aria-disabled', 'true');
    expect(link).not.toHaveAttribute('tabindex', '-1');
  });

  it('disables the link with prRef tooltip when a submit is in flight', () => {
    mockedUseSubmitInFlight.mockReturnValue({
      inFlight: true,
      prRef: 'octocat/Hello-World/42',
    });
    render(
      <MemoryRouter>
        <AuthSection />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /replace token/i });
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link).toHaveAttribute('tabindex', '-1');
    // Pointer-tooltip (title=) AND SR descriptor span both carry the prRef.
    expect(link).toHaveAttribute('title', 'Submit on octocat/Hello-World/42 in progress');
    expect(screen.getByText(/Submit on octocat\/Hello-World\/42 in progress/)).toBeInTheDocument();
  });

  it('falls back to a generic message when prRef is null in the in-flight state', () => {
    // Defensive: backend should always populate prRef when InFlight=true, but the
    // hook tolerates partials so the UI must not crash on null prRef + inFlight=true.
    mockedUseSubmitInFlight.mockReturnValue({ inFlight: true, prRef: null });
    render(
      <MemoryRouter>
        <AuthSection />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /replace token/i });
    expect(link).toHaveAttribute('title', 'Submit on a pull request in progress');
  });
});
