import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SetupForm } from '../src/components/Setup/SetupForm';

describe('SetupForm', () => {
  it('disables Continue when input is empty', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('renders the decorative GitHub mark inside the Connect to GitHub heading', () => {
    // #212: the mark is aria-hidden, so the heading's accessible name stays
    // "Connect to GitHub" (this getByRole matching it proves that).
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    const heading = screen.getByRole('heading', { name: /connect to github/i });
    expect(heading.querySelector('svg')).not.toBeNull();
  });

  it('toggles mask/unmask on click of the eye', async () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/personal access token/i) as HTMLInputElement;
    await userEvent.type(input, 'ghp_xx');
    expect(input.type).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: /show token/i }));
    expect(input.type).toBe('text');
  });

  it('renders the four fine-grained permission rows', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByText('Pull requests')).toBeInTheDocument();
    expect(screen.getByText(/^Read and write$/)).toBeInTheDocument();
    expect(screen.getByText('Contents')).toBeInTheDocument();
    expect(screen.getByText('Checks')).toBeInTheDocument();
    expect(screen.getByText('Commit statuses')).toBeInTheDocument();
  });

  it('mentions Metadata: Read as auto-included', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByText(/Metadata: Read is auto-included/i)).toBeInTheDocument();
  });

  it('shows a classic-PAT footnote', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByText(/Already have a classic PAT/i)).toBeInTheDocument();
    // The `repo` scope is referenced in inline code.
    const codeNodes = screen.getAllByText('repo');
    expect(codeNodes.some((n) => n.tagName === 'CODE')).toBe(true);
  });

  it('renders error pill when error prop is set', () => {
    render(
      <SetupForm
        host="https://github.com"
        onSubmit={vi.fn()}
        error="GitHub rejected this token."
      />,
    );
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
  });

  it('calls onSubmit with the typed PAT when submit is clicked', async () => {
    const onSubmit = vi.fn();
    render(<SetupForm host="https://github.com" onSubmit={onSubmit} />);
    const input = screen.getByLabelText(/personal access token/i);
    await userEvent.type(input, 'ghp_test_token');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onSubmit).toHaveBeenCalledWith('ghp_test_token');
  });

  it('does NOT render a Cancel link by default (spec § 3.1 — only in replace mode)', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.queryByRole('link', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it('renders a Cancel link pointing at /settings when isReplaceMode is true', () => {
    render(
      <MemoryRouter>
        <SetupForm host="https://github.com" onSubmit={vi.fn()} isReplaceMode />
      </MemoryRouter>,
    );
    const cancel = screen.getByRole('link', { name: /cancel/i });
    expect(cancel).toHaveAttribute('href', '/settings');
  });

  it('does NOT render a Back-to-welcome link by default', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.queryByRole('link', { name: /back/i })).not.toBeInTheDocument();
  });

  it('renders a Back link to /welcome when showBackToWelcome is true', () => {
    render(
      <MemoryRouter>
        <SetupForm host="https://github.com" onSubmit={vi.fn()} showBackToWelcome />
      </MemoryRouter>,
    );
    const back = screen.getByRole('link', { name: /back/i });
    expect(back).toHaveAttribute('href', '/welcome');
  });

  it('disables Cancel (renders as aria-disabled span with role=link, not a navigable link) while busy=true', () => {
    // Regression for code-review #1: a clickable Cancel during the in-flight
    // /api/auth/replace would navigate to /settings without aborting the fetch,
    // leading to a silent server-side commit the user thought they cancelled.
    // While busy the Cancel surface must NOT navigate, but it MUST still be
    // announced as a disabled link by screen readers (claude[bot] iter-5 F3 —
    // bare aria-disabled on a span without role has no semantics for AT).
    render(
      <MemoryRouter>
        <SetupForm host="https://github.com" onSubmit={vi.fn()} isReplaceMode busy />
      </MemoryRouter>,
    );
    // getByRole('link') finds BOTH <a href> AND role="link" spans — so a single
    // assertion confirms screen readers see exactly one link-role Cancel.
    const link = screen.getByRole('link', { name: /cancel/i });
    expect(link.tagName).toBe('SPAN');
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link).not.toHaveAttribute('href');
  });
});
