import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ErrorModal } from './ErrorModal';

describe('ErrorModal', () => {
  it('renders nothing when open=false', () => {
    render(
      <ErrorModal
        open={false}
        title="Something went wrong"
        message="details"
        actions={<button>Reload</button>}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('renders an alertdialog with the title and message when open', () => {
    render(
      <ErrorModal
        open
        title="Couldn't load this PR"
        message="Server said no"
        actions={<button>Reload</button>}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Couldn't load this PR")).toBeInTheDocument();
    expect(screen.getByText('Server said no')).toBeInTheDocument();
  });

  it('renders the provided action(s)', () => {
    render(<ErrorModal open title="T" actions={<button>Reload</button>} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('does NOT call onClose on Escape when dismissible=false (default)', () => {
    const onClose = vi.fn();
    render(<ErrorModal open title="T" actions={<button>Reload</button>} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose on Escape when dismissible=true', () => {
    const onClose = vi.fn();
    render(
      <ErrorModal
        open
        dismissible
        title="T"
        actions={<button>Back to inbox</button>}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
