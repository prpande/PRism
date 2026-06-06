import { describe, it, expect } from 'vitest';
import { connectErrorMessage, replaceErrorMessage } from './tokenErrorCopy';

describe('connectErrorMessage', () => {
  it('maps insufficientscopes to the classic repo/read:org message', () => {
    expect(connectErrorMessage('insufficientscopes')).toBe(
      'This token is missing required scopes. A classic token needs repo and read:org.',
    );
  });
  it('invalid token copy mentions neither scope nor permission', () => {
    const msg = connectErrorMessage('invalidtoken');
    expect(msg).toContain('GitHub rejected this token');
    expect(msg.toLowerCase()).not.toContain('scope');
    expect(msg.toLowerCase()).not.toContain('permission');
  });
  it('maps network/dns codes to a connection message', () => {
    expect(connectErrorMessage('networkerror')).toContain('connection');
    expect(connectErrorMessage('dnserror')).toContain('connection');
  });
  it('unknown code falls back to a static message that never echoes the code', () => {
    expect(connectErrorMessage('weird-new-code-xyz')).toBe(
      'Validation failed. Check your token and try again.',
    );
    expect(connectErrorMessage(undefined)).toBe(
      'Validation failed. Check your token and try again.',
    );
  });
});

describe('replaceErrorMessage', () => {
  it('keeps replace-only codes', () => {
    expect(replaceErrorMessage('submit-in-flight')).toContain('submit started');
    expect(replaceErrorMessage('pat-required')).toContain('Paste your new token');
  });
  it('shares the classic scopes message and static fallback', () => {
    expect(replaceErrorMessage('insufficientscopes')).toBe(
      'This token is missing required scopes. A classic token needs repo and read:org.',
    );
    expect(replaceErrorMessage('weird')).toBe('Validation failed. Check your token and try again.');
  });
});
