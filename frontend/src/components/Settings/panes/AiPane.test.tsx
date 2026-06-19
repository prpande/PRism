import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AiPane } from './AiPane';
import * as consentApi from '../../../api/aiConsent';
import type { EgressDisclosure } from '../../../api/aiConsent';

const set = vi.fn().mockResolvedValue(undefined);
const prefs = vi.hoisted(() => ({
  aiMode: 'off' as 'off' | 'preview' | 'live',
  providerTimeoutSeconds: 240,
  hunkAnnotationCap: 10,
  summaryMaxChars: 1000,
  features: {
    summary: true,
    fileFocus: true,
    hunkAnnotations: true,
    preSubmitValidators: true,
    composerAssist: true,
    draftSuggestions: true,
    draftReconciliation: true,
    inboxEnrichment: true,
    inboxRanking: true,
  },
}));
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {
        theme: 'dark',
        accent: 'indigo',
        density: 'comfortable',
        contentScale: 'm',
        aiMode: prefs.aiMode,
        providerTimeoutSeconds: prefs.providerTimeoutSeconds,
        hunkAnnotationCap: prefs.hunkAnnotationCap,
        summaryMaxChars: prefs.summaryMaxChars,
        features: prefs.features,
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
  prefs.providerTimeoutSeconds = 240;
  prefs.hunkAnnotationCap = 10;
  prefs.summaryMaxChars = 1000;
  vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
  vi.mocked(consentApi.postAiConsent).mockResolvedValue();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('AiPane', () => {
  it('renders the AI mode control', () => {
    render(<AiPane />);
    expect(screen.getByRole('radiogroup', { name: 'AI mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Off' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Live' })).toBeInTheDocument();
  });

  it('writes ui.ai.mode on selecting Preview', async () => {
    render(<AiPane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'preview'));
  });

  it('does not POST when the already-selected Preview is clicked', async () => {
    prefs.aiMode = 'preview';
    render(<AiPane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    expect(set).not.toHaveBeenCalled();
  });

  it('shows a live config as Live-selected and issues no POST on render', () => {
    prefs.aiMode = 'live';
    render(<AiPane />);
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'false');
    expect(set).not.toHaveBeenCalled();
  });

  it('POSTs preview when Preview is clicked on a live config (valid downgrade)', async () => {
    prefs.aiMode = 'live';
    render(<AiPane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'preview'));
  });

  // ---- Live two-phase commit (cases B–D) ----

  it('case B: when consent is needed, clicking Live opens the modal and does not POST live', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
    render(<AiPane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Enable Live AI')).toBeInTheDocument();
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', 'live');
  });

  it('case C: when already consented, clicking Live POSTs live without opening the modal', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(true));
    render(<AiPane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'live'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('case D: the AI-mode help text mentions Live', () => {
    render(<AiPane />);
    expect(screen.getByText(/Live · real AI/)).toBeInTheDocument();
  });

  it('does not advance the control to Live while consent is pending (value stays off)', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
    render(<AiPane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' }));
    await screen.findByRole('dialog');
    // The committed mode is still 'off'; the Live segment must NOT be checked.
    expect(screen.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'false');
  });

  it('Accept: records consent, POSTs live, and moves focus to the Live segment', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
    vi.mocked(consentApi.postAiConsent).mockResolvedValue();
    render(<AiPane />);
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
    render(<AiPane />);
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
    render(<AiPane />);
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

  // ---- New numeric-stepper cases ----

  it('renders the provider-timeout stepper and writes on step', async () => {
    prefs.aiMode = 'live';
    render(<AiPane />);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{ArrowUp}'); // 240 -> 270
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.providerTimeoutSeconds', 270));
  });

  it('renders the hunk-annotation-cap stepper and writes on step', async () => {
    prefs.aiMode = 'live';
    render(<AiPane />);
    const sb = screen.getByRole('spinbutton', { name: 'Annotation cap' });
    sb.focus();
    await userEvent.keyboard('{ArrowUp}'); // 10 -> 11
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.hunkAnnotationCap', 11));
  });

  it('renders the summary-length stepper and writes on step (step 100)', async () => {
    prefs.aiMode = 'live';
    render(<AiPane />);
    const sb = screen.getByRole('spinbutton', { name: 'Summary length' });
    sb.focus();
    await userEvent.keyboard('{ArrowUp}'); // 1000 -> 1100
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.summaryMaxChars', 1100));
  });

  it('hides detail controls in Off and Preview, and the Preview button does not activate', async () => {
    prefs.aiMode = 'preview';
    render(<AiPane />);
    expect(screen.queryByRole('spinbutton', { name: 'Provider timeout' })).toBeNull();
    // Preview shows the disabled, non-expanding "AI features" button + hint.
    const btn = screen.getByRole('button', { name: /AI features/ });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/Switch to Live/)).toBeInTheDocument();
    // The button has no onClick and never calls set/setFeaturesOpen, so a click is inert
    // even though aria-disabled alone would not block native activation: no patch, no expand.
    await userEvent.click(btn);
    expect(set).not.toHaveBeenCalled();
    expect(screen.queryByRole('switch')).toBeNull(); // accordion did not expand
  });

  it('shows four feature switches in Live and toggles one', async () => {
    prefs.aiMode = 'live';
    render(<AiPane />);
    await userEvent.click(screen.getByRole('button', { name: /AI features/ }));
    const summary = screen.getByRole('switch', { name: 'Summary' });
    expect(summary).toBeChecked();
    await userEvent.click(summary);
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.features.summary', false));
  });
});
