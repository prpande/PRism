import { act, render } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useEffect } from 'react';
import { DrawerEffects } from './DrawerEffects';
import { AskAiDrawerProvider, useAskAiDrawer } from '../../contexts/AskAiDrawerContext';

function StateProbe({
  onMount,
  onState,
}: {
  onMount: (toggle: () => void, navigate: ReturnType<typeof useNavigate>) => void;
  onState: (isOpen: boolean) => void;
}) {
  const { isOpen, toggle } = useAskAiDrawer();
  const navigate = useNavigate();
  useEffect(() => {
    onMount(toggle, navigate);
  }, []);
  useEffect(() => {
    onState(isOpen);
  }, [isOpen, onState]);
  return null;
}

describe('DrawerEffects', () => {
  it('does NOT close drawer while on a PR Detail route', () => {
    const states: boolean[] = [];
    let toggleFn: (() => void) | null = null;
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <AskAiDrawerProvider>
          <StateProbe
            onMount={(t) => {
              toggleFn = t;
            }}
            onState={(o) => states.push(o)}
          />
          <DrawerEffects />
        </AskAiDrawerProvider>
      </MemoryRouter>,
    );
    act(() => toggleFn!());
    expect(states[states.length - 1]).toBe(true);
  });

  it('auto-closes drawer when pathname leaves PR Detail', () => {
    const states: boolean[] = [];
    let toggleFn: (() => void) | null = null;
    let navigateFn: ReturnType<typeof useNavigate> | null = null;
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <AskAiDrawerProvider>
          <StateProbe
            onMount={(t, n) => {
              toggleFn = t;
              navigateFn = n;
            }}
            onState={(o) => states.push(o)}
          />
          <DrawerEffects />
        </AskAiDrawerProvider>
      </MemoryRouter>,
    );
    act(() => toggleFn!());
    expect(states[states.length - 1]).toBe(true);
    act(() => navigateFn!('/'));
    expect(states[states.length - 1]).toBe(false);
  });

  it('does NOT auto-reopen when pathname returns to PR Detail', () => {
    const states: boolean[] = [];
    let toggleFn: (() => void) | null = null;
    let navigateFn: ReturnType<typeof useNavigate> | null = null;
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <AskAiDrawerProvider>
          <StateProbe
            onMount={(t, n) => {
              toggleFn = t;
              navigateFn = n;
            }}
            onState={(o) => states.push(o)}
          />
          <DrawerEffects />
        </AskAiDrawerProvider>
      </MemoryRouter>,
    );
    act(() => toggleFn!());
    act(() => navigateFn!('/'));
    act(() => navigateFn!('/pr/acme/api/1'));
    expect(states[states.length - 1]).toBe(false);
  });
});
