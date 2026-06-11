import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './useAuth';
import { apiClient } from '../api/client';

function Probe() {
  const { authState } = useAuth();
  return <div>{authState?.githubCredentialInvalid ? 'invalid' : 'valid'}</div>;
}

describe('useAuth prism-request-failed refetch', () => {
  it('refetches auth state when a request fails', async () => {
    const get = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce({
        hasToken: true,
        host: 'github.com',
        hostMismatch: null,
        githubCredentialInvalid: false,
      } as never)
      .mockResolvedValue({
        hasToken: true,
        host: 'github.com',
        hostMismatch: null,
        githubCredentialInvalid: true,
      } as never);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new CustomEvent('prism-request-failed'));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
  });
});
