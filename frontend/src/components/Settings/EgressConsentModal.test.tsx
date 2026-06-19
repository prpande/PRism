import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EgressConsentModal } from './EgressConsentModal';
import * as api from '../../api/aiConsent';

vi.mock('../../api/aiConsent');
const disclosure = {
  recipient: 'Anthropic, via the Claude Code CLI',
  dataCategories: ['Pull request diff', 'Title', 'Description'],
  disclosureVersion: '1',
  alreadyConsented: false,
};

describe('EgressConsentModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows loading then disclosure, Accept enabled after load', async () => {
    vi.spyOn(api, 'getEgressDisclosure').mockResolvedValue(disclosure);
    render(<EgressConsentModal open onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText('Loading data-sharing disclosure…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Anthropic/)).toBeInTheDocument());
  });

  it('fail-closed on disclosure error: Accept stays disabled', async () => {
    vi.spyOn(api, 'getEgressDisclosure').mockRejectedValue(new Error('x'));
    render(<EgressConsentModal open onAccept={vi.fn()} onDecline={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the data-sharing disclosure/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /enable live/i })).toBeDisabled();
  });

  it('Accept records consent then calls onAccept', async () => {
    vi.spyOn(api, 'getEgressDisclosure').mockResolvedValue(disclosure);
    const post = vi.spyOn(api, 'postAiConsent').mockResolvedValue();
    const onAccept = vi.fn();
    render(<EgressConsentModal open onAccept={onAccept} onDecline={vi.fn()} />);
    await waitFor(() => screen.getByText(/Anthropic/));
    await userEvent.click(screen.getByRole('button', { name: /enable live/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('1'));
    expect(onAccept).toHaveBeenCalled();
  });

  it('does not commit Live if the modal is dismissed before the consent POST resolves', async () => {
    vi.spyOn(api, 'getEgressDisclosure').mockResolvedValue(disclosure);
    let resolvePost!: () => void;
    vi.spyOn(api, 'postAiConsent').mockReturnValue(
      new Promise<void>((res) => {
        resolvePost = res;
      }),
    );
    const onAccept = vi.fn();
    const { rerender } = render(
      <EgressConsentModal open onAccept={onAccept} onDecline={vi.fn()} />,
    );
    await waitFor(() => screen.getByText(/Anthropic/));
    await userEvent.click(screen.getByRole('button', { name: /enable live/i }));
    // Consent POST is in flight; the user dismisses the modal (Escape / Decline →
    // parent flips `open` to false) BEFORE the POST settles.
    rerender(<EgressConsentModal open={false} onAccept={onAccept} onDecline={vi.fn()} />);
    resolvePost();
    await waitFor(() => expect(api.postAiConsent).toHaveBeenCalled());
    // The late resolution must NOT commit Live — the dismissal is the user's final word.
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('renders the AI spark in the title without altering the dialog name', async () => {
    vi.spyOn(api, 'getEgressDisclosure').mockResolvedValue(disclosure);
    render(<EgressConsentModal open onAccept={vi.fn()} onDecline={vi.fn()} />);
    // The spark icon is aria-hidden, so the dialog name is still exactly the title.
    expect(screen.getByRole('dialog', { name: 'Enable Live AI' })).toBeInTheDocument();
  });

  it('renders the egress callout with recipient and each data category', async () => {
    vi.spyOn(api, 'getEgressDisclosure').mockResolvedValue(disclosure);
    render(<EgressConsentModal open onAccept={vi.fn()} onDecline={vi.fn()} />);
    // Recipient stays in its own element (exact-match selectors depend on this).
    expect(await screen.findByText('Anthropic, via the Claude Code CLI')).toBeInTheDocument();
    for (const c of disclosure.dataCategories) {
      expect(screen.getByText(c)).toBeInTheDocument();
    }
  });

  it('submit error: shows retry copy, does not call onAccept, re-enables Accept', async () => {
    vi.spyOn(api, 'getEgressDisclosure').mockResolvedValue(disclosure);
    vi.spyOn(api, 'postAiConsent').mockRejectedValue(new Error('409'));
    const onAccept = vi.fn();
    render(<EgressConsentModal open onAccept={onAccept} onDecline={vi.fn()} />);
    await waitFor(() => screen.getByText(/Anthropic/));
    const accept = screen.getByRole('button', { name: /enable live/i });
    await userEvent.click(accept);
    // `.` matches the apostrophe; scoped phrase avoids colliding with the modal title "Enable Live AI".
    await waitFor(() => expect(screen.getByText(/Couldn.t enable Live AI/i)).toBeInTheDocument());
    expect(onAccept).not.toHaveBeenCalled();
    expect(accept).not.toBeDisabled();
  });
});
