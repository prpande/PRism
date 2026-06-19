// frontend/src/components/AskAiDrawer/AskAiDrawer.test.tsx
import { act, render, screen, fireEvent } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Probe exposes the context API to the test body via a ref handle, so the
// test can drive setInput/sendMessage in SEPARATE act() calls (each flushes
// before the next reads `threadsRef.current` inside the context). Driving
// these from a single useEffect batches the updates and `sendMessage` reads
// stale input → early-returns. Mirrors the renderHook+act pattern that
// AskAiDrawerContext.test.tsx uses for the same context.
interface SeedHandle {
  setInput: (key: string, value: string) => void;
  sendMessage: (key: string) => void;
  toggle: () => void;
}
function ApiProbe({ handle }: { handle: { current: SeedHandle | null } }) {
  const ctx = useAskAiDrawer();
  handle.current = { setInput: ctx.setInput, sendMessage: ctx.sendMessage, toggle: ctx.toggle };
  return null;
}

function HarnessWithApi({ handle }: { handle: { current: SeedHandle | null } }) {
  return (
    <MemoryRouter initialEntries={['/pr/acme/api/1']}>
      <AskAiDrawerProvider>
        <ApiProbe handle={handle} />
        <AskAiDrawer />
      </AskAiDrawerProvider>
    </MemoryRouter>
  );
}

function seed(
  handle: { current: SeedHandle | null },
  messages: Array<{ role: 'user' | 'ai'; body: string }>,
) {
  const api = handle.current!;
  // Separate act() calls force `setThreads` to commit before the next read of
  // `threadsRef.current` (sendMessage checks input length via the ref). The
  // matching pattern is AskAiDrawerContext.test.tsx's renderHook + act flow.
  act(() => api.toggle());
  for (const m of messages) {
    if (m.role === 'user') {
      act(() => api.setInput('acme/api/1', m.body));
      act(() => api.sendMessage('acme/api/1'));
    }
  }
}

describe('AskAiDrawer messages', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders user bubble for user messages', () => {
    const handle = { current: null as SeedHandle | null };
    render(<HarnessWithApi handle={handle} />);
    seed(handle, [{ role: 'user', body: 'why?' }]);
    expect(screen.getByText('why?')).toBeInTheDocument();
  });

  it('renders typing indicator while pendingAiReply', () => {
    const handle = { current: null as SeedHandle | null };
    render(<HarnessWithApi handle={handle} />);
    seed(handle, [{ role: 'user', body: 'why?' }]);
    expect(screen.getByTestId('ai-typing-indicator')).toBeInTheDocument();
  });

  it('renders AI bubble after timeout fires', () => {
    const handle = { current: null as SeedHandle | null };
    render(<HarnessWithApi handle={handle} />);
    seed(handle, [{ role: 'user', body: 'why?' }]);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByTestId('ai-typing-indicator')).not.toBeInTheDocument();
    expect(screen.getByText(/AI isn't available right now\./)).toBeInTheDocument();
  });

  it('replaces all three drawer sparkles with markers and leaves no emoji', () => {
    const handle = { current: null as SeedHandle | null };
    const { container } = render(<HarnessWithApi handle={handle} />);
    // Seed 1 AI message: send a user msg → AI reply fires after timeout
    seed(handle, [{ role: 'user', body: 'hello' }]);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    // Now send another user message to get pendingAiReply back
    act(() => handle.current!.setInput('acme/api/1', 'again'));
    act(() => handle.current!.sendMessage('acme/api/1'));
    // header (1) + one AI message (1) + typing indicator (1) = 3
    expect(screen.getAllByTestId('ai-marker')).toHaveLength(3);
    expect(container.textContent).not.toContain('✨');
  });

  it('renders bodies as plain text, not HTML (XSS guard)', () => {
    const handle = { current: null as SeedHandle | null };
    render(<HarnessWithApi handle={handle} />);
    seed(handle, [{ role: 'user', body: '<script>x</script>' }]);
    expect(screen.getByText('<script>x</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});

function ComposerHarness() {
  return (
    <MemoryRouter initialEntries={['/pr/acme/api/1']}>
      <AskAiDrawerProvider>
        <OpenOnMount />
        <AskAiDrawer />
      </AskAiDrawerProvider>
    </MemoryRouter>
  );
}

function OpenOnMount() {
  const { isOpen, toggle } = useAskAiDrawer();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || isOpen) return;
    fired.current = true;
    toggle();
  }, [isOpen, toggle]);
  return null;
}

describe('AskAiDrawer composer', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('typing in textarea updates input via setInput', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'hello');
    expect((textarea as HTMLTextAreaElement).value).toBe('hello');
  });

  it('Send button is disabled when input is empty', () => {
    render(<ComposerHarness />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('Send button is disabled when input is whitespace-only', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    await user.type(screen.getByRole('textbox'), '   ');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('Send button enables when input has non-whitespace chars', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    await user.type(screen.getByRole('textbox'), 'x');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('clicking Send appends user message + sets pending', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    await user.type(screen.getByRole('textbox'), 'why?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('why?')).toBeInTheDocument();
    expect(screen.getByTestId('ai-typing-indicator')).toBeInTheDocument();
  });

  it('Cmd/Ctrl+Enter submits', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'why?');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(screen.getByText('why?')).toBeInTheDocument();
  });

  it('plain Enter inserts newline, does NOT submit', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'line1{Enter}line2');
    expect((textarea as HTMLTextAreaElement).value).toBe('line1\nline2');
    expect(screen.queryByTestId('ai-typing-indicator')).not.toBeInTheDocument();
  });

  it('Send button disabled while pendingAiReply', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    await user.type(screen.getByRole('textbox'), 'first');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.type(screen.getByRole('textbox'), 'second');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('input is cleared after successful submit', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, 'why?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(textarea.value).toBe('');
  });
});

// #330: the drawer reads useEffectiveLocation, not raw useLocation. When a
// Settings/Help/Feedback modal route is open OVER a PR, the live pathname is
// /settings/* (which carries no prRef) but `state.backgroundLocation` still points
// at the PR. With raw useLocation the drawer would null out prRef → blank its thread
// + disable its composer until the modal closed. These tests pin the fix: the drawer
// keeps tracking the underlying PR behind the scrim.
function ModalOverPrHarness({ handle }: { handle: { current: SeedHandle | null } }) {
  return (
    <MemoryRouter
      initialEntries={[
        { pathname: '/settings', state: { backgroundLocation: { pathname: '/pr/acme/api/1' } } },
      ]}
    >
      <AskAiDrawerProvider>
        <ApiProbe handle={handle} />
        <AskAiDrawer />
      </AskAiDrawerProvider>
    </MemoryRouter>
  );
}

describe('AskAiDrawer effective location (#330)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the underlying PR thread visible while a Settings modal route is open', () => {
    const handle = { current: null as SeedHandle | null };
    render(<ModalOverPrHarness handle={handle} />);
    // Seed a user message on the PR's thread while the live URL is /settings — the
    // effective location resolves prRef from backgroundLocation, so the thread exists.
    seed(handle, [{ role: 'user', body: 'still tracking the PR?' }]);
    expect(screen.getByText('still tracking the PR?')).toBeInTheDocument();
  });

  it('keeps the composer enabled (not blanked) under a modal route', () => {
    const handle = { current: null as SeedHandle | null };
    render(<ModalOverPrHarness handle={handle} />);
    act(() => handle.current!.toggle());
    const textarea = screen.getByRole('textbox');
    // With raw useLocation prKey would be '' → onChange a no-op and the controlled
    // value would stay empty. Under the fix the keystroke lands and Send enables.
    act(() => {
      fireEvent.change(textarea, { target: { value: 'hi' } });
    });
    expect((textarea as HTMLTextAreaElement).value).toBe('hi');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });
});
