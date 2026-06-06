import { StrictMode } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadingBarProvider, useLoadingBar, useTopProgress } from './LoadingBarContext';

function wrapper({ children }: { children: React.ReactNode }) {
  return <LoadingBarProvider>{children}</LoadingBarProvider>;
}

describe('LoadingBarContext', () => {
  it('active is true when any key is true (OR across keys)', () => {
    const { result } = renderHook(() => useLoadingBar(), { wrapper });
    expect(result.current.active).toBe(false);
    act(() => result.current.setLoading('a', true));
    expect(result.current.active).toBe(true);
    act(() => {
      result.current.setLoading('b', true);
      result.current.setLoading('a', false);
    });
    expect(result.current.active).toBe(true); // b still true
    act(() => result.current.setLoading('b', false));
    expect(result.current.active).toBe(false);
  });

  it('useTopProgress sets its key from active and clears when active flips false', () => {
    const probe = { value: false };
    function Bar() {
      probe.value = useLoadingBar().active;
      return null;
    }
    function Feeder({ active }: { active: boolean }) {
      useTopProgress('feeder', active);
      return null;
    }
    const view = (active: boolean) => (
      <LoadingBarProvider>
        <Feeder active={active} />
        <Bar />
      </LoadingBarProvider>
    );
    const { rerender, unmount } = render(view(false));
    expect(probe.value).toBe(false);
    rerender(view(true));
    expect(probe.value).toBe(true);
    rerender(view(false));
    expect(probe.value).toBe(false);
    unmount();
  });

  it('StrictMode: a key that flips true->false clears, no stuck-true drift', () => {
    const probe = { value: false };
    function Bar() {
      probe.value = useLoadingBar().active;
      return null;
    }
    function Feeder({ active }: { active: boolean }) {
      useTopProgress('feeder', active);
      return null;
    }
    const view = (active: boolean) => (
      <StrictMode>
        <LoadingBarProvider>
          <Feeder active={active} />
          <Bar />
        </LoadingBarProvider>
      </StrictMode>
    );
    const { rerender } = render(view(true));
    expect(probe.value).toBe(true);
    rerender(view(false));
    expect(probe.value).toBe(false);
  });
});
