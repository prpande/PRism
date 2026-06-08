import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal open={false} title="Title" onClose={() => {}}>
        body
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the title and children when open', () => {
    render(
      <Modal open title="My title" onClose={() => {}}>
        <span>my body</span>
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('My title')).toBeInTheDocument();
    expect(screen.getByText('my body')).toBeInTheDocument();
  });

  it('defaults role to "dialog"', () => {
    render(
      <Modal open title="T" onClose={() => {}}>
        body
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('applies role="alertdialog" when role="alertdialog"', () => {
    render(
      <Modal open title="T" role="alertdialog" onClose={() => {}}>
        body
      </Modal>,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not add the center modifier class by default (top-anchored)', () => {
    const { container } = render(
      <Modal open title="T" onClose={() => {}}>
        body
      </Modal>,
    );
    const backdrop = container.querySelector('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop).not.toHaveClass('modal-backdrop--center');
  });

  it('adds the center modifier class when align="center"', () => {
    const { container } = render(
      <Modal open title="T" align="center" onClose={() => {}}>
        body
      </Modal>,
    );
    const backdrop = container.querySelector('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveClass('modal-backdrop--center');
  });

  it('calls onClose on Escape by default', () => {
    const onClose = vi.fn();
    render(
      <Modal open title="T" onClose={onClose}>
        body
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('suppresses Escape when disableEscDismiss is set', () => {
    const onClose = vi.fn();
    render(
      <Modal open title="T" onClose={onClose} disableEscDismiss>
        body
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
