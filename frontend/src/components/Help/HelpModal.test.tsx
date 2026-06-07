import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { HelpModal } from './HelpModal';

function renderModal(authed = true, onClose = vi.fn()) {
  return render(
    <MemoryRouter>
      <HelpModal onClose={onClose} authed={authed} />
    </MemoryRouter>,
  );
}

describe('HelpModal', () => {
  it('renders a labelled dialog titled "Help"', () => {
    renderModal();
    const dialog = screen.getByRole('dialog', { name: /help/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // h2 title inside the dialog
    expect(screen.getByRole('heading', { level: 2, name: 'Help' })).toBeInTheDocument();
  });

  it('renders all six section headings', () => {
    renderModal();
    for (const title of [
      'What PRism is',
      'The review loop',
      'The main surfaces',
      'Connecting your token',
      'Keyboard shortcuts',
      'Send feedback',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(title, 'i') })).toBeInTheDocument();
    }
  });

  it('renders content without referencing Azure DevOps', () => {
    renderModal();
    // Open all sections to expose all text
    for (const title of [
      'What PRism is',
      'The review loop',
      'The main surfaces',
      'Connecting your token',
      'Keyboard shortcuts',
      'Send feedback',
    ]) {
      const btn = screen.getByRole('button', { name: new RegExp(title, 'i') });
      if (btn.getAttribute('aria-expanded') !== 'true') fireEvent.click(btn);
    }
    const dialog = screen.getByRole('dialog', { name: /help/i });
    expect(dialog.textContent).toMatch(/GitHub/);
    expect(dialog.textContent).not.toMatch(/Azure DevOps/i);
  });

  it('first section ("What PRism is") is open by default', () => {
    renderModal();
    const btn = screen.getByRole('button', { name: /what prism is/i });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    // Content visible
    expect(screen.getByText(/local-first workspace/i)).toBeInTheDocument();
  });

  it('other sections are collapsed by default', () => {
    renderModal();
    const btn = screen.getByRole('button', { name: /the review loop/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles a section open and closed on header click', async () => {
    renderModal();
    const btn = screen.getByRole('button', { name: /the review loop/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('only sets aria-controls while the section body is mounted (axe aria-valid-attr-value)', async () => {
    renderModal();
    const btn = screen.getByRole('button', { name: /the review loop/i });
    // Collapsed → no dangling aria-controls pointing at an absent id.
    expect(btn).not.toHaveAttribute('aria-controls');

    await userEvent.click(btn);
    const controls = btn.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).not.toBeNull();
  });

  it('token section links to /settings/github-connection when authed', () => {
    renderModal(true);
    // Open the token section
    fireEvent.click(screen.getByRole('button', { name: /connecting your token/i }));
    expect(screen.getByRole('link', { name: /settings.*github connection/i })).toHaveAttribute(
      'href',
      '/settings/github-connection',
    );
  });

  it('token section links to /setup when not authed', () => {
    renderModal(false);
    fireEvent.click(screen.getByRole('button', { name: /connecting your token/i }));
    expect(screen.getByRole('link', { name: /get started/i })).toHaveAttribute('href', '/setup');
    expect(screen.queryByRole('link', { name: /settings.*github connection/i })).toBeNull();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    renderModal(true, onClose);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the ✕ close button is clicked', async () => {
    const onClose = vi.fn();
    renderModal(true, onClose);
    await userEvent.click(screen.getByRole('button', { name: /close help/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on scrim click (pointer-down + pointer-up on same scrim target)', async () => {
    const onClose = vi.fn();
    renderModal(true, onClose);
    const scrim = screen.getByTestId('help-scrim');
    await userEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close when pointer-down starts on the scrim but pointer-up lands inside the modal (drag)', () => {
    const onClose = vi.fn();
    renderModal(true, onClose);
    const scrim = screen.getByTestId('help-scrim');
    const dialog = screen.getByRole('dialog', { name: /help/i });
    fireEvent.pointerDown(scrim);
    fireEvent.pointerUp(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('restores focus to the fallback landmark on close when there was no opener', () => {
    document.body.innerHTML = '<main data-testid="bg" tabindex="-1"></main>';
    const { rerender } = render(
      <MemoryRouter>
        <HelpModal onClose={() => {}} authed restoreFocusFallbackSelector='[data-testid="bg"]' />
      </MemoryRouter>,
    );
    rerender(<></>);
    expect(document.activeElement).toBe(document.querySelector('[data-testid="bg"]'));
  });

  it('restores focus to the opener on close', () => {
    document.body.innerHTML = '<button data-testid="opener">open</button>';
    const opener = document.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    const { rerender } = render(
      <MemoryRouter>
        <HelpModal onClose={() => {}} authed />
      </MemoryRouter>,
    );
    rerender(<></>);
    expect(document.activeElement).toBe(opener);
  });
});
