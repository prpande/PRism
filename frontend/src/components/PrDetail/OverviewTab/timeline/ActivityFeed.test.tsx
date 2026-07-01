import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ActivityFeed } from './ActivityFeed';
import * as api from '../../../../api/timeline';
import type { TimelineEvent } from '../../../../api/types';

// jsdom doesn't implement layout, so HTMLElement.prototype.scrollIntoView is undefined by
// default in this jsdom version — vi.spyOn requires the property to exist first.
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const ev = (id: string, over: Partial<TimelineEvent>): TimelineEvent => ({
  id,
  verb: 'approved',
  actor: { login: 'alice', avatarUrl: null, isBot: false },
  timestamp: '2021-01-01T00:00:00Z',
  body: null,
  commitCount: null,
  subject: null,
  ...over,
});
const pr = { owner: 'acme', repo: 'api', number: 7 };

afterEach(() => vi.restoreAllMocks());

describe('ActivityFeed', () => {
  it('renders a comment as a card and a bare approval as a marker', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: [ev('c', { verb: 'commented', body: 'looks good' }), ev('a', { verb: 'approved' })],
      olderCursor: null,
      hasOlder: false,
    });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={<div>composer</div>} />);
    expect(await screen.findByText('looks good')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-marker')).toHaveTextContent('approved');
  });

  it('collapses a >5 commit run into an expandable accordion', async () => {
    const commits = Array.from({ length: 6 }, (_, i) =>
      ev(`p${i}`, { verb: 'pushed', commitCount: 1 }),
    );
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: commits,
      olderCursor: null,
      hasOlder: false,
    });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    const acc = await screen.findByRole('button', { name: /6 commits/i });
    expect(acc).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows an empty-state placeholder, not a blank card', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: [],
      olderCursor: null,
      hasOlder: false,
    });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument();
  });

  it('shows a retry-distinct error state on fetch failure', async () => {
    vi.spyOn(api, 'getTimelinePage').mockRejectedValue(new Error('boom'));
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    expect(await screen.findByTestId('timeline-error')).toBeInTheDocument();
    expect(screen.queryByText(/no activity yet/i)).not.toBeInTheDocument();
  });

  it('renders a bodied approval as one card carrying the approved state', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: [ev('r', { verb: 'approved', body: 'ship it' })],
      olderCursor: null,
      hasOlder: false,
    });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    expect(await screen.findByText('ship it')).toBeInTheDocument(); // the body → a card
    expect(screen.getByText(/approved/i)).toBeInTheDocument(); // ...with the state band
    expect(screen.queryByTestId('timeline-marker')).not.toBeInTheDocument(); // not a separate duplicate marker
  });

  it('Retry re-fetches after an initial-load failure (not a no-op)', async () => {
    const spy = vi
      .spyOn(api, 'getTimelinePage')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        events: [ev('c', { verb: 'commented', body: 'hi' })],
        olderCursor: null,
        hasOlder: false,
      });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByText('hi')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a live merge announces the arrival without stealing focus or auto-scrolling', async () => {
    const scrollSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    vi.spyOn(api, 'getTimelinePage')
      .mockResolvedValueOnce({
        events: [ev('1', { verb: 'commented', body: 'first' })],
        olderCursor: null,
        hasOlder: false,
      })
      .mockResolvedValueOnce({
        events: [ev('9', { verb: 'approved' }), ev('1', { verb: 'commented', body: 'first' })],
        olderCursor: null,
        hasOlder: false,
      });
    const { rerender } = render(
      <ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />,
    );
    await screen.findByText('first');
    const focused = document.activeElement;
    rerender(<ActivityFeed prRef={pr} prUpdatedSignal={1} composerSlot={null} />); // simulate a pr-updated frame
    await screen.findByTestId('timeline-marker'); // the approval merged in
    expect(document.activeElement).toBe(focused); // focus not stolen
    expect(scrollSpy).not.toHaveBeenCalled(); // no auto-scroll on merge
    expect(screen.getByRole('status')).toHaveTextContent(/approved/i); // aria-live announced WHAT arrived
  });

  it('renders a subject-less review-requested marker without a dangling "from"', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: [ev('rr', { verb: 'review-requested', subject: null })],
      olderCursor: null,
      hasOlder: false,
    });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    const marker = await screen.findByTestId('timeline-marker');
    expect(marker).toHaveTextContent('requested a review');
    expect(marker).not.toHaveTextContent('requested review from');
  });

  it('the commit-run accordion is an operable button that toggles on activation', async () => {
    const commits = Array.from({ length: 6 }, (_, i) =>
      ev(`p${i}`, { verb: 'pushed', commitCount: 1 }),
    );
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: commits,
      olderCursor: null,
      hasOlder: false,
    });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    const acc = await screen.findByRole('button', { name: /6 commits/i }); // a real <button> ⇒ keyboard-operable
    expect(acc).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(acc);
    expect(acc).toHaveAttribute('aria-expanded', 'true'); // expands to reveal the per-commit list
  });
});
