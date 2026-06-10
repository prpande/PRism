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
});
