import { afterEach, describe, expect, it } from 'vitest';
import type { Accent } from '../api/types';
import { applyContentScaleToDocument, applyThemeToDocument } from './applyTheme';

const ATTR = 'data-content-scale';

afterEach(() => {
  document.documentElement.removeAttribute(ATTR);
  document.documentElement.style.removeProperty('--accent-h');
  document.documentElement.style.removeProperty('--accent-c');
  delete document.documentElement.dataset.theme;
});

// The known accent → (hue, chroma) map, mirrored from applyTheme's ACCENT_HUES.
const KNOWN_ACCENTS: Record<Accent, { h: string; c: string }> = {
  indigo: { h: '245', c: '0.085' },
  amber: { h: '75', c: '0.1' },
  teal: { h: '195', c: '0.075' },
};

function accentVars() {
  const root = document.documentElement.style;
  return { h: root.getPropertyValue('--accent-h'), c: root.getPropertyValue('--accent-c') };
}

describe('applyThemeToDocument', () => {
  it.each(Object.entries(KNOWN_ACCENTS))('maps the %s accent to its hue/chroma', (accent, vars) => {
    applyThemeToDocument('light', accent as Accent);
    expect(accentVars()).toEqual(vars);
  });

  it('falls back to the indigo hue for an accent outside the enum (defensive, no throw)', () => {
    // An out-of-band config.json edit or FE/backend skew can yield an arbitrary
    // string (#612 B): the wire shape is validated for type, not enum membership.
    expect(() => applyThemeToDocument('light', 'purple' as Accent)).not.toThrow();
    expect(accentVars()).toEqual(KNOWN_ACCENTS.indigo);
  });
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
