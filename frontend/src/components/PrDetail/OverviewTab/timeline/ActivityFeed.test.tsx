import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { ActivityFeed } from './ActivityFeed';
import * as api from '../../../../api/timeline';
import type { TimelineEvent, ReviewThreadDto } from '../../../../api/types';

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

const seededThread = (over: Partial<ReviewThreadDto> = {}): ReviewThreadDto => ({
  threadId: 'th1',
  filePath: 'src/Calc.cs',
  lineNumber: 5,
  isResolved: false,
  reviewDatabaseId: 1,
  comments: [
    {
      commentId: 'c1',
      author: 'alice',
      avatarUrl: null,
      createdAt: '2026-01-01T00:00:00Z',
      body: 'nit here',
      editedAt: null,
    },
  ],
  ...over,
});

beforeEach(() => sessionStorage.clear());
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

  it('groups a >5 commit run to the newest 5 with a show-older control', async () => {
    const commits = Array.from({ length: 6 }, (_, i) =>
      ev(`p${i}`, { verb: 'pushed', commitCount: 1, subject: `commit ${i}` }),
    );
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: commits,
      olderCursor: null,
      hasOlder: false,
    });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    expect(await screen.findByTestId('timeline-commit-group')).toHaveTextContent(
      'pushed 6 commits',
    );
    // newest 5 shown, the 6th collapsed behind a show-older control
    expect(screen.getByRole('button', { name: /1 older commit/i })).toBeInTheDocument();
    expect(screen.queryByText('commit 5')).not.toBeInTheDocument();
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

  it('the show-older control reveals the remaining commits', async () => {
    const commits = Array.from({ length: 6 }, (_, i) =>
      ev(`p${i}`, { verb: 'pushed', commitCount: 1, subject: `commit ${i}` }),
    );
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: commits,
      olderCursor: null,
      hasOlder: false,
    });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    const btn = await screen.findByRole('button', { name: /1 older commit/i }); // a real <button> ⇒ keyboard-operable
    expect(screen.queryByText('commit 5')).not.toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.getByText('commit 5')).toBeInTheDocument(); // the collapsed 6th commit is revealed
  });

  it('renders thread rows under the matching review card', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: [ev('review:1', { verb: 'approved' })],
      olderCursor: null,
      hasOlder: false,
    });
    const threadsByReview = new Map<number, ReviewThreadDto[]>([[1, [seededThread()]]]);
    render(
      <ActivityFeed
        prRef={pr}
        prUpdatedSignal={0}
        composerSlot={<div />}
        threadsByReview={threadsByReview}
      />,
    );
    expect(await screen.findByTestId('timeline-thread-row')).toBeInTheDocument();
    expect(screen.getByText('src/Calc.cs:5')).toBeInTheDocument();
  });

  it('does not alter a review with no threads (still a bare marker)', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: [ev('review:9', { verb: 'approved' })],
      olderCursor: null,
      hasOlder: false,
    });
    render(
      <ActivityFeed
        prRef={pr}
        prUpdatedSignal={0}
        composerSlot={<div />}
        threadsByReview={new Map()}
      />,
    );
    expect(await screen.findByTestId('timeline-marker')).toHaveTextContent('approved');
    expect(screen.queryByTestId('timeline-thread-row')).not.toBeInTheDocument();
  });

  // Spec: "Rows follow their parent card's visibility (e.g. the existing 'Show bots' filter)."
  // The ReviewNode dispatches from the already-showBots-filtered `nodes`, so a hidden bot review's
  // threads are hidden too.
  it('hides bot-review threads under the Show-bots filter, reveals them on toggle', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: [
        ev('review:2', {
          verb: 'approved',
          actor: { login: 'dependabot[bot]', avatarUrl: null, isBot: true },
        }),
      ],
      olderCursor: null,
      hasOlder: false,
    });
    const threadsByReview = new Map<number, ReviewThreadDto[]>([
      [2, [seededThread({ reviewDatabaseId: 2 })]],
    ]);
    render(
      <ActivityFeed
        prRef={pr}
        prUpdatedSignal={0}
        composerSlot={<div />}
        threadsByReview={threadsByReview}
      />,
    );
    // Bots hidden by default → the bot review card AND its thread rows are absent.
    await screen.findByRole('button', { name: /show bots/i });
    expect(screen.queryByTestId('timeline-thread-row')).not.toBeInTheDocument();
    // Reveal bots → the thread rows follow their parent card in.
    await user.click(screen.getByRole('button', { name: /show bots/i }));
    expect(await screen.findByTestId('timeline-thread-row')).toBeInTheDocument();
  });
});
