import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AskAiPullTab } from './AskAiPullTab';

const mocks = vi.hoisted(() => ({ gate: vi.fn(), drawer: vi.fn() }));
vi.mock('../../hooks/useAiGate', () => ({ useAiGate: () => mocks.gate() }));
vi.mock('../../contexts/AskAiDrawerContext', () => ({ useAskAiDrawer: () => mocks.drawer() }));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AskAiPullTab />
    </MemoryRouter>,
  );

describe('AskAiPullTab', () => {
  it('hidden when AI gate is off', () => {
    mocks.gate.mockReturnValue(false);
    mocks.drawer.mockReturnValue({ isOpen: false, toggle: vi.fn() });
    renderAt('/pr/acme/api/123');
    expect(screen.queryByRole('button', { name: /ask ai/i })).not.toBeInTheDocument();
  });
  it('hidden off a PR-detail route even when gated', () => {
    mocks.gate.mockReturnValue(true);
    mocks.drawer.mockReturnValue({ isOpen: false, toggle: vi.fn() });
    renderAt('/inbox');
    expect(screen.queryByRole('button', { name: /ask ai/i })).not.toBeInTheDocument();
  });
  it('shown on PR-detail when gated; toggles the drawer', async () => {
    const toggle = vi.fn();
    mocks.gate.mockReturnValue(true);
    mocks.drawer.mockReturnValue({ isOpen: false, toggle });
    renderAt('/pr/acme/api/123');
    const tab = screen.getByRole('button', { name: 'Ask AI' });
    expect(tab).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(tab);
    expect(toggle).toHaveBeenCalledOnce();
  });
  it('open state → aria-expanded true and label Close', () => {
    mocks.gate.mockReturnValue(true);
    mocks.drawer.mockReturnValue({ isOpen: true, toggle: vi.fn() });
    renderAt('/pr/acme/api/123');
    const tab = screen.getByRole('button', { name: 'Close' });
    expect(tab).toHaveAttribute('aria-expanded', 'true');
  });
  it('renders a recognizable icon at rest (present for touch users with no hover label)', () => {
    mocks.gate.mockReturnValue(true);
    mocks.drawer.mockReturnValue({ isOpen: false, toggle: vi.fn() });
    renderAt('/pr/acme/api/123');
    expect(screen.getByTestId('ask-ai-pull-tab').querySelector('.ai-icon')).toBeInTheDocument();
  });
});
