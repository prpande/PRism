import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiOnboardingDialog } from './AiOnboardingDialog';
import * as consentApi from '../../api/aiConsent';
import type { EgressDisclosure } from '../../api/aiConsent';

vi.mock('../../api/aiConsent');

const disclosure = (alreadyConsented: boolean): EgressDisclosure => ({
  recipient: 'Anthropic, via the Claude Code CLI',
  dataCategories: ['Pull request diff (changed files and their contents)', 'Title', 'Description'],
  disclosureVersion: '1',
  alreadyConsented,
});

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
  vi.mocked(consentApi.getEgressDisclosure).mockClear();
  vi.mocked(consentApi.postAiConsent).mockClear();
  prefs.aiMode = 'preview';
  vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
  vi.mocked(consentApi.postAiConsent).mockResolvedValue(undefined);
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

  it('selecting Off changes the button to "Turn off AI" and commits off + seen in order', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Off/ }));
    const btn = screen.getByRole('button', { name: 'Turn off AI' });
    await user.click(btn);
    expect(set).toHaveBeenCalledWith('ui.ai.mode', 'off');
    expect(set).toHaveBeenCalledWith('ui.ai.onboardingSeen', true);
    // Order assertion: mode BEFORE seen
    expect(set.mock.calls[0]).toEqual(['ui.ai.mode', 'off']);
    expect(set.mock.calls[1]).toEqual(['ui.ai.onboardingSeen', true]);
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

describe('AiOnboardingDialog Live path', () => {
  it('shows skeleton + disabled button while disclosure loads, then enables', async () => {
    let resolve!: (d: EgressDisclosure) => void;
    vi.mocked(consentApi.getEgressDisclosure).mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    expect(screen.getByRole('button', { name: 'Enable Live AI' })).toBeDisabled();
    resolve(disclosure(false));
    await screen.findByText('Anthropic, via the Claude Code CLI');
    expect(screen.getByRole('button', { name: 'Enable Live AI' })).toBeEnabled();
  });

  it('Enable Live: posts consent then commits mode=live + seen in order', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await screen.findByText('Anthropic, via the Claude Code CLI');
    await user.click(screen.getByRole('button', { name: 'Enable Live AI' }));
    expect(consentApi.postAiConsent).toHaveBeenCalledWith('1');
    expect(set).toHaveBeenCalledWith('ui.ai.mode', 'live');
    expect(set).toHaveBeenCalledWith('ui.ai.onboardingSeen', true);
    // Order assertion: postAiConsent BEFORE mode=live BEFORE seen=true
    const postOrder = vi.mocked(consentApi.postAiConsent).mock.invocationCallOrder[0];
    const modeOrder =
      set.mock.invocationCallOrder[
        set.mock.calls.findIndex((c) => c[0] === 'ui.ai.mode' && c[1] === 'live')
      ];
    const seenOrder =
      set.mock.invocationCallOrder[
        set.mock.calls.findIndex((c) => c[0] === 'ui.ai.onboardingSeen' && c[1] === true)
      ];
    expect(postOrder).toBeLessThan(modeOrder);
    expect(modeOrder).toBeLessThan(seenOrder);
  });

  it('alreadyConsented short-circuits the POST', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(true));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await user.click(await screen.findByRole('button', { name: 'Enable Live AI' }));
    expect(consentApi.postAiConsent).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith('ui.ai.mode', 'live');
  });

  it('fails closed when the consent POST rejects (no commit)', async () => {
    vi.mocked(consentApi.postAiConsent).mockRejectedValue(new Error('409'));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await screen.findByText('Anthropic, via the Claude Code CLI');
    await user.click(screen.getByRole('button', { name: 'Enable Live AI' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', 'live');
  });

  it('aborting Live (pick Preview) drops the in-flight disclosure', async () => {
    const abortSpy = vi.fn();
    vi.mocked(consentApi.getEgressDisclosure).mockImplementation((signal) => {
      signal?.addEventListener('abort', abortSpy);
      return new Promise(() => {}); // never resolves
    });
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await user.click(screen.getByRole('radio', { name: /Preview/ }));
    expect(abortSpy).toHaveBeenCalled();
  });

  it('POST failure shows enable-specific copy, not the load-failure copy', async () => {
    vi.mocked(consentApi.postAiConsent).mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await screen.findByText('Anthropic, via the Claude Code CLI'); // disclosure loaded
    await user.click(screen.getByRole('button', { name: 'Enable Live AI' }));
    expect(await screen.findByText(/Couldn't enable Live AI/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load the data-sharing disclosure/)).not.toBeInTheDocument();
  });

  it('disables the Manage button while the consent POST is in flight', async () => {
    let resolvePost!: () => void;
    vi.mocked(consentApi.postAiConsent).mockReturnValue(new Promise((r) => (resolvePost = r)));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await screen.findByText('Anthropic, via the Claude Code CLI');
    await user.click(screen.getByRole('button', { name: 'Enable Live AI' }));
    expect(screen.getByRole('button', { name: /Manage AI settings/ })).toBeDisabled();
    resolvePost();
  });
});
