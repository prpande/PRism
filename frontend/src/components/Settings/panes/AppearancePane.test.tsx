import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppearancePane } from './AppearancePane';
import * as consentApi from '../../../api/aiConsent';
import type { EgressDisclosure } from '../../../api/aiConsent';

const set = vi.fn().mockResolvedValue(undefined);
const prefs = vi.hoisted(() => ({ aiMode: 'off' as 'off' | 'preview' | 'live' }));
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {
        theme: 'dark',
        accent: 'indigo',
        density: 'comfortable',
        contentScale: 'm',
        aiMode: prefs.aiMode,
      },
      inbox: { sections: {} },
      github: {},
    },
    set,
  }),
}));
vi.mock('../../../api/aiConsent');

const disclosure = (alreadyConsented: boolean): EgressDisclosure => ({
  recipient: 'Anthropic, via the Claude Code CLI',
  dataCategories: ['Pull request diff', 'Title', 'Description'],
  disclosureVersion: '1',
  alreadyConsented,
});

beforeEach(() => {
  set.mockClear();
  prefs.aiMode = 'off';
  vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
  vi.mocked(consentApi.postAiConsent).mockResolvedValue();
});
afterEach(() => {
  document.documentElement.removeAttribute('data-content-scale');
  vi.clearAllMocks();
});

describe('AppearancePane', () => {
  it('renders theme/accent/density/AI-mode controls', () => {
    render(<AppearancePane />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    const aiMode = screen.getByRole('radiogroup', { name: 'AI mode' });
    expect(aiMode).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Off' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Live' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Content font size' })).toBeInTheDocument();
  });

  it('writes the contentScale preference on slider change', async () => {
    render(<AppearancePane />);
    fireEvent.change(screen.getByRole('slider', { name: 'Content font size' }), {
      target: { value: '4' },
    });
    await waitFor(() => expect(set).toHaveBeenCalledWith('contentScale', 'xl'));
  });

  it('rolls back the optimistic content-scale apply when the save fails', async () => {
    set.mockRejectedValueOnce(new Error('save failed'));
    render(<AppearancePane />);
    fireEvent.change(screen.getByRole('slider', { name: 'Content font size' }), {
      target: { value: '4' }, // 'xl'
    });
    // Optimistic write set the attribute to 'xl'; the rejected save reverts to
    // the prior value 'm', which removes the attribute entirely.
    await waitFor(() =>
      expect(document.documentElement.hasAttribute('data-content-scale')).toBe(false),
    );
    expect(set).toHaveBeenCalledWith('contentScale', 'xl');
  });

  it('writes ui.ai.mode on selecting Preview', async () => {
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'preview'));
  });

  it('does not POST when the already-selected Preview is clicked', async () => {
    prefs.aiMode = 'preview';
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    expect(set).not.toHaveBeenCalled();
  });

  it('shows a live config as Live-selected and issues no POST on render', () => {
    prefs.aiMode = 'live';
    render(<AppearancePane />);
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'false');
    expect(set).not.toHaveBeenCalled();
  });

  it('POSTs preview when Preview is clicked on a live config (valid downgrade)', async () => {
    prefs.aiMode = 'live';
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'preview'));
  });

  // ---- Live two-phase commit (Step 1 cases A–D) ----

  it('case B: when consent is needed, clicking Live opens the modal and does not POST live', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Enable Live AI')).toBeInTheDocument();
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', 'live');
  });

  it('case C: when already consented, clicking Live POSTs live without opening the modal', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(true));
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'live'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('case D: the AI-mode help text mentions Live', () => {
    render(<AppearancePane />);
    expect(screen.getByText(/Live · real AI/)).toBeInTheDocument();
  });

  it('does not advance the control to Live while consent is pending (value stays off)', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' }));
    await screen.findByRole('dialog');
    // The committed mode is still 'off'; the Live segment must NOT be checked.
    expect(screen.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'false');
  });

  it('Accept: records consent, POSTs live, and moves focus to the Live segment', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
    vi.mocked(consentApi.postAiConsent).mockResolvedValue();
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' }));
    await screen.findByText(/Anthropic/);
    await userEvent.click(screen.getByRole('button', { name: /enable live/i }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'live'));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Live' })),
    );
  });

  it('Decline: closes the modal, does not POST live, and returns focus to the prior segment', async () => {
    prefs.aiMode = 'preview';
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /decline/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', 'live');
    // Focus returns to the segment selected when Live was intercepted (Preview).
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Preview' })),
    );
  });

  it('aborts an in-flight Live disclosure fetch when a downgrade is chosen first', async () => {
    prefs.aiMode = 'preview';
    let resolveDisclosure!: (d: EgressDisclosure) => void;
    vi.mocked(consentApi.getEgressDisclosure).mockReturnValue(
      new Promise<EgressDisclosure>((res) => {
        resolveDisclosure = res;
      }),
    );
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' })); // starts the in-flight fetch (no modal yet)
    await userEvent.click(screen.getByRole('radio', { name: 'Off' })); // aborts it + commits the downgrade
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'off'));
    // The now-aborted fetch resolves late: it must NOT open the modal or flip to live.
    resolveDisclosure(disclosure(false));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', 'live');
  });
});
