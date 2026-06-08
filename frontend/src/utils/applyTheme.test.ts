import { afterEach, describe, expect, it } from 'vitest';
import { applyContentScaleToDocument } from './applyTheme';

const ATTR = 'data-content-scale';

afterEach(() => {
  document.documentElement.removeAttribute(ATTR);
});

describe('applyContentScaleToDocument', () => {
  it.each(['xs', 's', 'l', 'xl'] as const)('sets data-content-scale="%s"', (value) => {
    applyContentScaleToDocument(value);
    expect(document.documentElement.getAttribute(ATTR)).toBe(value);
  });

  it('removes the attribute for the default "m"', () => {
    document.documentElement.setAttribute(ATTR, 'xl');
    applyContentScaleToDocument('m');
    expect(document.documentElement.hasAttribute(ATTR)).toBe(false);
  });

  it('removes the attribute for an unrecognized value (defensive)', () => {
    document.documentElement.setAttribute(ATTR, 'xl');
    applyContentScaleToDocument('zzz' as never);
    expect(document.documentElement.hasAttribute(ATTR)).toBe(false);
  });
});
