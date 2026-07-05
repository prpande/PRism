import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import * as draftApi from '../../../api/draft';
import * as rootCommentApi from '../../../api/rootComment';
import {
  PrRootConversationActions,
  type PrRootConversationReplyContext,
} from './PrRootConversation';
import type { PrReference } from '../../../api/types';

// #620 — PrRootConversation's comment-list rendering moved to ActivityFeed
// (see ActivityFeed.test.tsx for comment/marker rendering coverage). This
// file now covers only PrRootConversationActions: the lifted composer +
// Mark-all-read actions, ported from the old PrRootConversation composer
// cases, plus the new onPosted refetch-bridge wiring.

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const replyContext: PrRootConversationReplyContext = {
  prRef: ref,
  prState: 'open',
  existingPrRootDraft: null,
  registerOpenComposer: () => () => undefined,
  onComposerClose: () => undefined,
  insertDraftLocally: () => undefined,
};

describe('PrRootConversationActions', () => {
  it('renders the Reply and Mark-all-read actions', () => {
    render(<PrRootConversationActions replyContext={replyContext} />);
    expect(
      screen.getByRole('button', { name: 'Reply to the PR conversation' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark all read/i })).toBeInTheDocument();
  });

  it('clicking Reply mounts the PrRootReplyComposer (form role with PR-root aria-label)', async () => {
    const user = await import('@testing-library/user-event').then((m) => m.default.setup());
    render(<PrRootConversationActions replyContext={replyContext} />);
    await user.click(screen.getByRole('button', { name: 'Reply to the PR conversation' }));
    expect(screen.getByRole('form', { name: 'Reply to this PR' })).toBeInTheDocument();
  });

  it('forwards onPosted through to the mounted composer, firing on a successful post (#620)', async () => {
    const user = await import('@testing-library/user-event').then((m) => m.default.setup());
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: 'uuid-existing' },
    } as never);
    vi.spyOn(rootCommentApi, 'postRootComment').mockResolvedValue({ ok: true });
    const onPosted = vi.fn();

    render(
      <PrRootConversationActions
        replyContext={{ ...replyContext, existingPrRootDraft: null }}
        onPosted={onPosted}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reply to the PR conversation' }));
    const editor = screen.getByLabelText('PR-level body');
    await user.type(editor, 'ready to ship — long enough to clear the create threshold');
    await user.click(screen.getByRole('button', { name: /^Post$/ }));

    await waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
  });
});
