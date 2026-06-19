import { describe, it, expect } from 'vitest';
import { fileFocusStatusToMarkerState } from './fileFocusMarkerState';

describe('fileFocusStatusToMarkerState', () => {
  it('maps loading to working', () => {
    expect(fileFocusStatusToMarkerState('loading')).toBe('working');
  });
  it('maps resolved-with-content states to idle', () => {
    expect(fileFocusStatusToMarkerState('ok')).toBe('idle');
    expect(fileFocusStatusToMarkerState('empty')).toBe('idle');
    expect(fileFocusStatusToMarkerState('fallback')).toBe('idle');
  });
  it('maps no-marker states to null', () => {
    expect(fileFocusStatusToMarkerState('error')).toBeNull();
    expect(fileFocusStatusToMarkerState('no-changes')).toBeNull();
    expect(fileFocusStatusToMarkerState('not-subscribed')).toBeNull();
  });
});
