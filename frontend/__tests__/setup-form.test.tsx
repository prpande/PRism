import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SetupForm } from '../src/components/Setup/SetupForm';

describe('SetupForm', () => {
  it('disables Continue when input is empty', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
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
});
