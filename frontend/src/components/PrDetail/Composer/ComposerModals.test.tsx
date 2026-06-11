import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ComposerModals } from './ComposerModals';

const base = {
  discardModalOpen: false,
  onDiscardCancel: vi.fn(),
  onDiscardConfirm: vi.fn(),
  recoveryModalOpen: false,
  onRecoveryCancel: vi.fn(),
  onRecoveryRecreate: vi.fn(),
  onRecoveryDiscard: vi.fn(),
  discardBody: 'This will remove the saved draft on this line.',
  recoveryTitle: 'Draft deleted elsewhere',
  recoveryBody: 'This draft was deleted from another window or by reload. Re-create it with the current text, or discard?',
};

describe('ComposerModals', () => {
  it('renders the discard modal body when open', () => {
    render(<ComposerModals {...base} discardModalOpen />);
    expect(screen.getByText('This will remove the saved draft on this line.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('Discard saved draft?');
  });
  it('renders the recovery modal title + body when open', () => {
    render(<ComposerModals {...base} recoveryModalOpen />);
    expect(screen.getByRole('dialog')).toHaveTextContent('Draft deleted elsewhere');
    expect(screen.getByText(base.recoveryBody)).toBeInTheDocument();
  });
});
