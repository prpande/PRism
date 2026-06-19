import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiOnboardingDialog } from './AiOnboardingDialog';

const set = vi.fn().mockResolvedValue(undefined);
const navigate = vi.fn();
const prefs = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live' }));

vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: { ui: { aiMode: prefs.aiMode, onboardingSeen: false } },
    set,
  }),
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/', state: null }),
}));

const onDismiss = vi.fn();
beforeEach(() => {
  set.mockClear();
  navigate.mockClear();
  onDismiss.mockClear();
  prefs.aiMode = 'preview';
});

describe('AiOnboardingDialog shell', () => {
  it('opens on Preview with a "Maybe later" button and no mode write on click', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    const btn = screen.getByRole('button', { name: 'Maybe later' });
    await user.click(btn);
    // Preview kept → only the seen-write, no mode write.
    expect(set).toHaveBeenCalledWith('ui.ai.onboardingSeen', true);
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', expect.anything());
    expect(onDismiss).toHaveBeenCalled();
  });

  it('selecting Off changes the button to "Turn off AI" and commits off + seen', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Off/ }));
    const btn = screen.getByRole('button', { name: 'Turn off AI' });
    await user.click(btn);
    expect(set).toHaveBeenCalledWith('ui.ai.mode', 'off');
    expect(set).toHaveBeenCalledWith('ui.ai.onboardingSeen', true);
  });

  it('Manage AI settings sets seen, navigates, and does NOT write a mode (pending Off)', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Off/ })); // pending = off
    // Rendered as a <button class="btn btn-link"> (matches the existing settings opener), so query by button.
    await user.click(screen.getByRole('button', { name: /Manage AI settings/ }));
    expect(set).toHaveBeenCalledWith('ui.ai.onboardingSeen', true);
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', expect.anything());
    expect(navigate).toHaveBeenCalledWith('/settings/ai', expect.anything());
  });

  it('Esc does NOT set seen and does not commit', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.keyboard('{Escape}');
    expect(set).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled(); // closes, but seen stays false → re-shows next launch
  });
});
