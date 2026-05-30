import { describe, expect, it } from 'vitest';
import { AI_UNAVAILABLE_RESPONSES, pickAiUnavailableResponse } from './askAiUnavailableResponses';

describe('AI_UNAVAILABLE_RESPONSES', () => {
  it('exports exactly 5 distinct strings', () => {
    expect(AI_UNAVAILABLE_RESPONSES).toHaveLength(5);
    expect(new Set(AI_UNAVAILABLE_RESPONSES).size).toBe(5);
  });

  it('every string starts with "AI isn\'t available right now." and is non-empty', () => {
    for (const s of AI_UNAVAILABLE_RESPONSES) {
      expect(s).toMatch(/^AI isn't available right now\./);
      expect(s.length).toBeGreaterThan(30);
    }
  });
});

describe('pickAiUnavailableResponse', () => {
  it('returns entry at index 0 for cycleIndex 0', () => {
    expect(pickAiUnavailableResponse(0)).toBe(AI_UNAVAILABLE_RESPONSES[0]);
  });

  it('wraps around past the pool length (modulo)', () => {
    expect(pickAiUnavailableResponse(5)).toBe(AI_UNAVAILABLE_RESPONSES[0]);
    expect(pickAiUnavailableResponse(12)).toBe(AI_UNAVAILABLE_RESPONSES[2]);
  });

  it('handles negative indices via positive modulo', () => {
    expect(pickAiUnavailableResponse(-1)).toBe(AI_UNAVAILABLE_RESPONSES[4]);
  });
});
