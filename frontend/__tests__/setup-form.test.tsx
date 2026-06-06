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

  const host = 'https://github.com';

  it('defaults to Classic: scopes, classic link, SSO callout, ghp_ placeholder', () => {
    render(<SetupForm host={host} onSubmit={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Classic' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('link', { name: /generate a classic token/i })).toHaveAttribute(
      'href',
      'https://github.com/settings/tokens/new',
    );
    expect(screen.getByText('repo')).toBeInTheDocument();
    expect(screen.getByText('read:org')).toBeInTheDocument();
    expect(screen.getByText(/Configure SSO/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('placeholder', 'ghp_…');
    // Inactive (fine-grained) panel must not be in the DOM / a11y tree.
    expect(screen.queryByText('Pull requests')).not.toBeInTheDocument();
  });

  it('switching to Fine-grained shows permissions, warning, fg link, github_pat_ placeholder', async () => {
    const user = userEvent.setup();
    render(<SetupForm host={host} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: 'Fine-grained' }));
    expect(screen.getByRole('link', { name: /generate a fine-grained token/i })).toHaveAttribute(
      'href',
      'https://github.com/settings/personal-access-tokens/new',
    );
    expect(screen.getByText('Pull requests')).toBeInTheDocument();
    expect(screen.getByText('Commit statuses')).toBeInTheDocument();
    expect(screen.getByText(/Actions CI status won/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute(
      'placeholder',
      'github_pat_…',
    );
    // Inactive (classic) panel must not be in the DOM / a11y tree.
    expect(screen.queryByText('repo')).not.toBeInTheDocument();
    expect(screen.queryByText(/Configure SSO/i)).not.toBeInTheDocument();
  });

  it('never mentions "Checks" and drops the local-first tagline', () => {
    render(<SetupForm host={host} onSubmit={vi.fn()} />);
    expect(screen.queryByText('Checks')).not.toBeInTheDocument();
    expect(screen.queryByText(/local-first/i)).not.toBeInTheDocument();
  });

  it('shows the error pill, marks the input invalid, and links them via aria-describedby', () => {
    render(<SetupForm host={host} onSubmit={vi.fn()} error="GitHub rejected this token." />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('GitHub rejected this token.');
    const input = screen.getByLabelText('Personal access token');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // The field points at the pill so assistive tech can retrieve the message on focus.
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.id).toBeTruthy();
  });

  it('clears a stale error when the token type is switched', async () => {
    const user = userEvent.setup();
    const onErrorClear = vi.fn();
    render(
      <SetupForm
        host={host}
        onSubmit={vi.fn()}
        error="This token is missing required scopes."
        onErrorClear={onErrorClear}
      />,
    );
    await user.click(screen.getByRole('radio', { name: 'Fine-grained' }));
    // A classic-scopes error must not persist against the fine-grained panel.
    expect(onErrorClear).toHaveBeenCalledTimes(1);
  });
});
