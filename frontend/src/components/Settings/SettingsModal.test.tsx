import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';

describe('SettingsModal', () => {
  it('renders a labelled dialog with its children', () => {
    render(<SettingsModal onClose={() => {}}><p>pane</p></SettingsModal>);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('pane')).toBeInTheDocument();
  });

  it('closes on ESC', async () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose}><p>pane</p></SettingsModal>);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose}><p>pane</p></SettingsModal>);
    await userEvent.click(screen.getByRole('button', { name: /close settings/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop pointer down+up but not on inner clicks', async () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose}><p>pane</p></SettingsModal>);
    await userEvent.click(screen.getByText('pane'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('settings-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the fallback landmark on close when there was no opener', async () => {
    document.body.innerHTML = '<main data-testid="bg" tabindex="-1"></main>';
    const { rerender } = render(
      <SettingsModal onClose={() => {}} restoreFocusFallbackSelector='[data-testid="bg"]'><p>pane</p></SettingsModal>,
    );
    rerender(<></>); // unmount the modal → cleanup runs focus restore
    expect(document.activeElement).toBe(document.querySelector('[data-testid="bg"]'));
  });
});
