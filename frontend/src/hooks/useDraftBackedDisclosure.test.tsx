import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDraftBackedDisclosure } from './useDraftBackedDisclosure';

describe('useDraftBackedDisclosure', () => {
  it('opens with the draft id when a draft exists at mount', () => {
    const { result } = renderHook(() => useDraftBackedDisclosure({ id: 'd1' }));
    expect(result.current.composerOpen).toBe(true);
    expect(result.current.draftId).toBe('d1');
  });

  it('starts closed with a null draft id when there is no draft (null and undefined alike)', () => {
    const fromNull = renderHook(() => useDraftBackedDisclosure(null));
    expect(fromNull.result.current.composerOpen).toBe(false);
    expect(fromNull.result.current.draftId).toBeNull();

    const fromUndefined = renderHook(() => useDraftBackedDisclosure(undefined));
    expect(fromUndefined.result.current.composerOpen).toBe(false);
    expect(fromUndefined.result.current.draftId).toBeNull();
  });

  it('re-opens and adopts the id when a draft arrives after mount (cross-tab / Overview resync)', () => {
    const { result, rerender } = renderHook(
      ({ draft }: { draft: { id: string } | null }) => useDraftBackedDisclosure(draft),
      { initialProps: { draft: null as { id: string } | null } },
    );
    expect(result.current.composerOpen).toBe(false);
    expect(result.current.draftId).toBeNull();

    rerender({ draft: { id: 'arrived' } });
    expect(result.current.composerOpen).toBe(true);
    expect(result.current.draftId).toBe('arrived');
  });

  it('adopts a new id when the draft id changes while the composer stays open', () => {
    const { result, rerender } = renderHook(
      ({ draft }: { draft: { id: string } }) => useDraftBackedDisclosure(draft),
      { initialProps: { draft: { id: 'a' } } },
    );
    expect(result.current.composerOpen).toBe(true);
    expect(result.current.draftId).toBe('a');

    // The effect is keyed on existingDraft?.id, so a changed id re-runs it.
    rerender({ draft: { id: 'b' } });
    expect(result.current.composerOpen).toBe(true);
    expect(result.current.draftId).toBe('b');
  });

  it('open() opens the composer; close() closes it without clearing draftId', () => {
    const { result } = renderHook(() => useDraftBackedDisclosure({ id: 'keep' }));
    expect(result.current.composerOpen).toBe(true);

    act(() => result.current.close());
    expect(result.current.composerOpen).toBe(false);
    // draftId persists so reopening restores the same draft.
    expect(result.current.draftId).toBe('keep');

    act(() => result.current.open());
    expect(result.current.composerOpen).toBe(true);
    expect(result.current.draftId).toBe('keep');
  });

  it('does not force the composer open while the draft stays absent', () => {
    const { result, rerender } = renderHook(
      ({ draft }: { draft: { id: string } | null }) => useDraftBackedDisclosure(draft),
      { initialProps: { draft: null as { id: string } | null } },
    );
    act(() => result.current.open());
    act(() => result.current.close());

    // A re-render with the draft still absent must not re-open via the resync effect.
    rerender({ draft: null });
    expect(result.current.composerOpen).toBe(false);
  });
});
