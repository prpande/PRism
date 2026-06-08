import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WindowControls } from '../src/components/Header/WindowControls';

type MaxCb = (m: boolean) => void;

function installPrism(over: Partial<PrismWindowControls> = {}) {
  let maxCb: MaxCb = () => {};
  const controls: PrismWindowControls = {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onMaximizedChange: vi.fn((cb: MaxCb) => {
      maxCb = cb;
      return () => {};
    }),
    ...over,
  };
  window.prism = {
    isDesktop: true,
    platform: 'win32',
    openExternal: vi.fn().mockResolvedValue(true),
    windowControls: controls,
  };
  return { controls, fireMax: (m: boolean) => maxCb(m) };
}

afterEach(() => {
  delete window.prism;
});

describe('WindowControls', () => {
  it('renders nothing in a browser (no window.prism)', () => {
    const { container } = render(<WindowControls />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders minimize / maximize / close in the desktop shell', () => {
    installPrism();
    render(<WindowControls />);
    expect(screen.getByRole('button', { name: /minimize/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /maximize/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('invokes the bridge on each click', async () => {
    const { controls } = installPrism();
    const user = userEvent.setup();
    render(<WindowControls />);
    await user.click(screen.getByRole('button', { name: /minimize/i }));
    await user.click(screen.getByRole('button', { name: /maximize/i }));
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(controls.minimize).toHaveBeenCalledOnce();
    expect(controls.toggleMaximize).toHaveBeenCalledOnce();
    expect(controls.close).toHaveBeenCalledOnce();
  });

  it('swaps the maximize control to Restore when the window maximizes', async () => {
    const { fireMax } = installPrism();
    render(<WindowControls />);
    // Let the initial isMaximized() promise settle so it can't clobber the event
    // below (real bridge never races these — the mock just resolves on a later tick).
    await act(async () => {});
    expect(screen.getByRole('button', { name: /maximize/i })).toBeInTheDocument();
    act(() => fireMax(true));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /^maximize$/i })).not.toBeInTheDocument();
  });
});
