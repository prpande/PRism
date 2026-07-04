import { describe, it, expect } from 'vitest';
import { buildAllRange, anchorShaForRange } from './range';
import type { PrDetailDto } from '../../api/types';

describe('buildAllRange', () => {
  it('joins base and head with the `..` separator', () => {
    const pr = { baseSha: 'basedef', headSha: 'headabc' } as PrDetailDto['pr'];
    expect(buildAllRange(pr)).toBe('basedef..headabc');
  });
});

describe('anchorShaForRange (#723)', () => {
  // A new inline comment posts to GitHub with `commit_id = anchoredSha`
  // (PrCommentEndpoints), so the anchor must be the RIGHT-side commit of the
  // range currently on screen.

  it('anchors to the iterations afterSha when an older iteration is displayed', () => {
    // Older-iteration view: compare(before..after) where after !== head.
    expect(anchorShaForRange('mid111..mid222', 'headabc')).toBe('mid222');
  });

  it('anchors to head for the "all changes" range (base..head)', () => {
    // buildAllRange yields base..head, so the after side already IS head.
    expect(anchorShaForRange('basedef..headabc', 'headabc')).toBe('headabc');
  });

  it('falls back to head when no iteration range is displayed (low-quality picker → null)', () => {
    expect(anchorShaForRange(null, 'headabc')).toBe('headabc');
  });

  it('falls back to head defensively when the range has no `..` separator', () => {
    expect(anchorShaForRange('malformed', 'headabc')).toBe('headabc');
  });
});
