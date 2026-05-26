import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Cheatsheet, CheatsheetProvider, useCheatsheet } from '../src/components/Cheatsheet';

function TestApp() {
  const { toggle } = useCheatsheet();
  return (
    <>
      <button type="button" onClick={toggle}>
        open
      </button>
      <Cheatsheet />
    </>
  );
}

describe('Cheatsheet', () => {
  it('does not render when closed', () => {
    render(
      <CheatsheetProvider>
        <TestApp />
      </CheatsheetProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders dialog with labelled heading + close button when open', async () => {
    const user = userEvent.setup();
    render(
      <CheatsheetProvider>
        <TestApp />
      </CheatsheetProvider>,
    );
    await user.click(screen.getByText('open'));

    const dialog = screen.getByRole('dialog', { name: /keyboard shortcuts/i });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    expect(screen.getByRole('button', { name: /close cheatsheet/i })).toBeInTheDocument();
  });

  it('shows shortcut tables grouped by section heading', async () => {
    const user = userEvent.setup();
    render(
      <CheatsheetProvider>
        <TestApp />
      </CheatsheetProvider>,
    );
    await user.click(screen.getByText('open'));

    expect(screen.getByRole('heading', { name: /global/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /file tree/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /diff/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /composer/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /submit dialog/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByText(/Toggle "Viewed" checkbox/i)).toBeInTheDocument();
  });

  it('focus moves to the dialog heading on open', async () => {
    const user = userEvent.setup();
    render(
      <CheatsheetProvider>
        <TestApp />
      </CheatsheetProvider>,
    );
    await user.click(screen.getByText('open'));

    const heading = screen.getByRole('heading', { name: /keyboard shortcuts/i, level: 2 });
    expect(document.activeElement).toBe(heading);
  });

  it('does NOT move focus to the dialog heading when a modal (aria-modal=true) is already open', async () => {
    const user = userEvent.setup();
    // Simulate an open modal in the page — its presence is detected via a
    // document.querySelector('[aria-modal="true"]') probe in the effect.
    const modalSentinel = document.createElement('div');
    modalSentinel.setAttribute('role', 'dialog');
    modalSentinel.setAttribute('aria-modal', 'true');
    const modalFocusable = document.createElement('button');
    modalFocusable.textContent = 'modal-button';
    modalSentinel.appendChild(modalFocusable);
    document.body.appendChild(modalSentinel);
    modalFocusable.focus();
    expect(document.activeElement).toBe(modalFocusable);

    try {
      render(
        <CheatsheetProvider>
          <TestApp />
        </CheatsheetProvider>,
      );
      await user.click(screen.getByText('open'));

      // Cheatsheet panel IS rendered (visible above modal), but focus stays
      // wherever it was — the click moved it to the opener button. The key
      // assertion: focus is NOT on the cheatsheet heading.
      const heading = screen.getByRole('heading', { name: /keyboard shortcuts/i, level: 2 });
      expect(document.activeElement).not.toBe(heading);
    } finally {
      document.body.removeChild(modalSentinel);
    }
  });

  it('focus returns to previously-focused element on close (liveness guard, in-DOM)', async () => {
    const user = userEvent.setup();
    render(
      <CheatsheetProvider>
        <TestApp />
      </CheatsheetProvider>,
    );
    const opener = screen.getByText('open');
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await user.click(opener); // opens; toggle captures opener → focus moves to heading
    await user.click(screen.getByRole('button', { name: /close cheatsheet/i }));

    expect(document.activeElement).toBe(opener);
  });

  it('liveness guard: falls back to <body> when the originally-focused element unmounted', async () => {
    const user = userEvent.setup();
    function App2() {
      const { toggle } = useCheatsheet();
      return (
        <>
          <button id="ephemeral" type="button" onClick={toggle}>
            open-and-unmount
          </button>
          <Cheatsheet />
        </>
      );
    }
    const { rerender } = render(
      <CheatsheetProvider>
        <App2 />
      </CheatsheetProvider>,
    );
    const opener = screen.getByText('open-and-unmount');
    opener.focus();
    await user.click(opener); // opens; returnFocusRef = opener

    // Simulate the opener unmounting while the overlay is open.
    rerender(
      <CheatsheetProvider>
        <Cheatsheet />
      </CheatsheetProvider>,
    );
    expect(document.getElementById('ephemeral')).toBeNull();

    await user.click(screen.getByRole('button', { name: /close cheatsheet/i }));

    expect(document.activeElement).toBe(document.body);
  });

  it('Esc closes the cheatsheet when open', async () => {
    render(
      <CheatsheetProvider>
        <TestApp />
      </CheatsheetProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText('open'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    act(() => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
    });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking the close button closes the cheatsheet', async () => {
    const user = userEvent.setup();
    render(
      <CheatsheetProvider>
        <TestApp />
      </CheatsheetProvider>,
    );
    await user.click(screen.getByText('open'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /close cheatsheet/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('useCheatsheet() outside a provider returns a no-op API (no throw)', () => {
    function StandaloneProbe() {
      const { isOpen, toggle, close } = useCheatsheet();
      return (
        <div>
          <span data-testid="open-flag">{String(isOpen)}</span>
          <button type="button" onClick={toggle}>
            t
          </button>
          <button type="button" onClick={close}>
            c
          </button>
        </div>
      );
    }
    render(<StandaloneProbe />);
    // No-op: just verifies render did not throw and the default api is reachable.
    expect(screen.getByTestId('open-flag').textContent).toBe('false');
  });
});
