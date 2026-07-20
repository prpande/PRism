import { describe, expect, it, vi } from 'vitest';
import { scrollThreadIntoCenter } from './scrollThreadIntoCenter';

function fake(rect: Partial<DOMRect>, over: Partial<HTMLElement> = {}) {
  return { getBoundingClientRect: () => rect as DOMRect, ...over } as unknown as HTMLElement;
}

describe('scrollThreadIntoCenter', () => {
  it('centers the target and clamps to the scroll range', () => {
    const scrollTo = vi.fn();
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTo,
    } as unknown as HTMLElement;
    const target = fake({ top: 1000, height: 40 });
    scrollThreadIntoCenter(container, target);
    // targetTop = 1000 - 0 + 0 = 1000; centered = 1000 - 200 + 20 = 820; clamp [0,1600]
    expect(scrollTo).toHaveBeenCalledWith({ top: 820, behavior: expect.any(String) });
  });

  it('clamps a near-bottom target to max scroll', () => {
    const scrollTo = vi.fn();
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTo,
    } as unknown as HTMLElement;
    scrollThreadIntoCenter(container, fake({ top: 980, height: 40 }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: expect.any(String) }); // max = 1000-400
  });
});
