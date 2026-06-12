import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useSingleCommentPostedSubscriber } from '../src/hooks/useSingleCommentPostedSubscriber';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

describe('useSingleCommentPostedSubscriber', () => {
  it('fires onPosted for a matching prRef', async () => {
    installFakeEventSource();
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
    installFakeEventSource();
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
