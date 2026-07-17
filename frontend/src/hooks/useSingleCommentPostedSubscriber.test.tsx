import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { useSingleCommentPostedSubscriber } from './useSingleCommentPostedSubscriber';
import { EventStreamProvider } from './useEventSource';
import { FakeEventSource, installFakeEventSource } from '../../__tests__/helpers/fakeEventSource';

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

describe('useSingleCommentPostedSubscriber', () => {
  beforeEach(() => installFakeEventSource());

  it('fires onPosted for a matching prRef', async () => {
    const onPosted = vi.fn();
    const prRef = { owner: 'acme', repo: 'api', number: 7 };
    renderHook(() => useSingleCommentPostedSubscriber({ prRef, onPosted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      FakeEventSource.instance.dispatch('single-comment-posted', {
        prRef: 'acme/api/7',
        reviewCommentId: 42,
      }),
    );

    expect(onPosted).toHaveBeenCalledOnce();
  });

  it('ignores a non-matching prRef', async () => {
    const onPosted = vi.fn();
    const prRef = { owner: 'acme', repo: 'api', number: 7 };
    renderHook(() => useSingleCommentPostedSubscriber({ prRef, onPosted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      FakeEventSource.instance.dispatch('single-comment-posted', {
        prRef: 'acme/api/999',
        reviewCommentId: 42,
      }),
    );

    expect(onPosted).not.toHaveBeenCalled();
  });
});
