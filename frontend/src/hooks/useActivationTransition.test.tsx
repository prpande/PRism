import { test, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useActivationTransition } from './useActivationTransition';

function Host({ active, cb }: { active: boolean; cb: () => void }) {
  useActivationTransition(active, cb);
  return null;
}

test('does NOT fire on first mount even when active=true', () => {
  const cb = vi.fn();
  render(<Host active cb={cb} />);
  expect(cb).not.toHaveBeenCalled();
});

test('fires once on false->true transition', () => {
  const cb = vi.fn();
  const { rerender } = render(<Host active={false} cb={cb} />);
  rerender(<Host active cb={cb} />);
  expect(cb).toHaveBeenCalledTimes(1);
});

test('does not fire on true->false or repeated true', () => {
  const cb = vi.fn();
  const { rerender } = render(<Host active={false} cb={cb} />);
  rerender(<Host active cb={cb} />);
  rerender(<Host active cb={cb} />); // still active, no re-fire
  rerender(<Host active={false} cb={cb} />); // deactivate, no fire
  expect(cb).toHaveBeenCalledTimes(1);
});
