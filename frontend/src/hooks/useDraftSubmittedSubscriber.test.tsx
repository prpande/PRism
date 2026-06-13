import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { EventStreamProvider } from './useEventSource';
import { useDraftSubmittedSubscriber } from './useDraftSubmittedSubscriber';
import { FakeEventSource, installFakeEventSource } from '../../__tests__/helpers/fakeEventSource';
import type { PrReference } from '../api/types';

beforeEach(() => {
  installFakeEventSource();
  vi.restoreAllMocks();
});

const prRef: PrReference = { owner: 'acme', repo: 'api', number: 7 };

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

describe('useDraftSubmittedSubscriber (#392)', () => {
  it('fires onSubmitted when a draft-submitted frame matches the prRef', async () => {
    const onSubmitted = vi.fn();
    renderHook(() => useDraftSubmittedSubscriber({ prRef, onSubmitted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instance.dispatch('draft-submitted', { prRef: 'acme/api/7' });

    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('ignores a draft-submitted frame for a different prRef', async () => {
    const onSubmitted = vi.fn();
    renderHook(() => useDraftSubmittedSubscriber({ prRef, onSubmitted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instance.dispatch('draft-submitted', { prRef: 'acme/api/8' });

    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('does nothing when prRef is null', async () => {
    const onSubmitted = vi.fn();
    renderHook(() => useDraftSubmittedSubscriber({ prRef: null, onSubmitted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instance.dispatch('draft-submitted', { prRef: 'acme/api/7' });

    expect(onSubmitted).not.toHaveBeenCalled();
  });
});
