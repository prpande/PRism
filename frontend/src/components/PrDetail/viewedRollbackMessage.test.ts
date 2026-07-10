import { describe, it, expect } from 'vitest';
import { viewedRollbackMessage } from './viewedRollbackMessage';
import { ApiError } from '../../api/client';

describe('viewedRollbackMessage', () => {
  it('names the file and the intent that failed to persist', () => {
    expect(
      viewedRollbackMessage({
        path: 'src/components/Foo.tsx',
        viewed: true,
        error: new Error('network down'),
      }),
    ).toBe('Couldn\'t mark "Foo.tsx" as reviewed.');
  });

  it('words a failed un-mark as such', () => {
    expect(
      viewedRollbackMessage({ path: 'Foo.tsx', viewed: false, error: new Error('network down') }),
    ).toBe('Couldn\'t mark "Foo.tsx" as not reviewed.');
  });

  it('falls back to the whole path when it has no directory segment', () => {
    expect(
      viewedRollbackMessage({ path: 'README.md', viewed: true, error: new Error('x') }),
    ).toContain('"README.md"');
  });

  it('tells the user to reload when the head advanced (409)', () => {
    expect(
      viewedRollbackMessage({
        path: 'src/Foo.tsx',
        viewed: true,
        error: new ApiError(409, null, { type: '/viewed/stale-head-sha' }),
      }),
    ).toBe('The PR has new commits — reload to update reviewed files.');
  });

  it('uses the generic message for non-409 ApiErrors', () => {
    expect(
      viewedRollbackMessage({
        path: 'src/Foo.tsx',
        viewed: true,
        error: new ApiError(422, null, { type: '/viewed/path-not-in-diff' }),
      }),
    ).toBe('Couldn\'t mark "Foo.tsx" as reviewed.');
  });
});
