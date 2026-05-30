// frontend/src/components/AskAiDrawer/AskAiDrawer.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AskAiDrawer } from './AskAiDrawer';
import { AskAiDrawerProvider, useAskAiDrawer } from '../../contexts/AskAiDrawerContext';

function Harness({ openOnMount }: { openOnMount: boolean }) {
  return (
    <MemoryRouter initialEntries={['/pr/acme/api/1']}>
      <AskAiDrawerProvider>
        <ToggleOnMount openOnMount={openOnMount} />
        <AskAiDrawer />
      </AskAiDrawerProvider>
    </MemoryRouter>
  );
}

function ToggleOnMount({ openOnMount }: { openOnMount: boolean }) {
  // Open the drawer exactly once on mount when requested — never on re-renders
  // triggered by close, otherwise ESC/click-close tests immediately re-open.
  const { toggle } = useAskAiDrawer();
  const fired = useRef(false);
  useEffect(() => {
    if (openOnMount && !fired.current) {
      fired.current = true;
      toggle();
    }
  }, [openOnMount, toggle]);
  return null;
}

describe('AskAiDrawer chrome', () => {
  it('renders the drawer container always (for animation), with isOpen class only when open', () => {
    const { container } = render(<Harness openOnMount={false} />);
    const drawer = container.querySelector('aside[role="dialog"]');
    expect(drawer).toBeInTheDocument();
    expect(drawer).not.toHaveClass('isOpen');
  });

  it('adds the isOpen class when state is open', () => {
    const { container } = render(<Harness openOnMount={true} />);
    const drawer = container.querySelector('aside[role="dialog"]');
    expect(drawer).toHaveClass(/isOpen/);
  });

  it('renders header label "Ask about this PR · AI unavailable" with subtitle muted', () => {
    render(<Harness openOnMount={true} />);
    expect(screen.getByText('Ask about this PR')).toBeInTheDocument();
    expect(screen.getByText(/AI unavailable/)).toBeInTheDocument();
  });

  it('has aria-modal="false" and aria-labelledby pointing at the header title', () => {
    const { container } = render(<Harness openOnMount={true} />);
    const dialog = container.querySelector('aside[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent('Ask about this PR');
  });

  it('sets aria-hidden=true when closed and false when open', () => {
    const { container, rerender } = render(<Harness openOnMount={false} />);
    expect(container.querySelector('aside[role="dialog"]')!.getAttribute('aria-hidden')).toBe(
      'true',
    );
    rerender(<Harness openOnMount={true} />);
    expect(container.querySelector('aside[role="dialog"]')!.getAttribute('aria-hidden')).toBe(
      'false',
    );
  });

  it('close button is keyboard-reachable and labelled', () => {
    render(<Harness openOnMount={true} />);
    const close = screen.getByRole('button', { name: /close ask ai drawer/i });
    expect(close).toBeInTheDocument();
  });

  it('Escape key closes the drawer', () => {
    render(<Harness openOnMount={true} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    const drawer = document.querySelector('aside[role="dialog"]')!;
    expect(drawer).not.toHaveClass(/isOpen/);
  });

  it('clicking the close button closes the drawer', () => {
    render(<Harness openOnMount={true} />);
    fireEvent.click(screen.getByRole('button', { name: /close ask ai drawer/i }));
    const drawer = document.querySelector('aside[role="dialog"]')!;
    expect(drawer).not.toHaveClass(/isOpen/);
  });

  it('empty body shows "Ask anything about this PR." hint + ⌘ ⏎ kbd hint', () => {
    render(<Harness openOnMount={true} />);
    expect(screen.getByText(/Ask anything about this PR/)).toBeInTheDocument();
    expect(screen.getByText(/⌘ ⏎ to send/)).toBeInTheDocument();
  });

  it('composer textarea is initial focus on open', () => {
    render(<Harness openOnMount={true} />);
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });
});
