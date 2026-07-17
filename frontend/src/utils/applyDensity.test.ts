import { describe, it, expect, beforeEach } from 'vitest';
import type { Density } from '../api/types';
import { applyDensityToDocument } from './applyTheme';

describe('applyDensityToDocument', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-density');
  });

  it('sets data-density="compact" when value is compact', () => {
    applyDensityToDocument('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });

  it('removes data-density when value is comfortable', () => {
    document.documentElement.setAttribute('data-density', 'compact');
    applyDensityToDocument('comfortable');
    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
  });

  // The backend response is typed `string` (UiPreferencesDto.Density at PreferencesDtos.cs)
  // and ConfigStore._allowedFields validates type=String only, NOT enum membership
  // (plan Deviation 6). An out-of-band edit to config.json or a future allowlist
  // extension could yield a string the frontend Density union claims is impossible.
  // The defensive else-branch absorbs that.
  it('removes data-density for any non-compact string (wire-shape defense)', () => {
    document.documentElement.setAttribute('data-density', 'compact');
    applyDensityToDocument('weird-value' as unknown as Density);
    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
  });
});
