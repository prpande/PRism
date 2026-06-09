import { render, renderHook, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiClient } from '../src/api/client';
import { PreferencesProvider, readKey, writeKey } from '../src/contexts/PreferencesContext';
import { usePreferences } from '../src/hooks/usePreferences';
import type { PreferencesResponse } from '../src/api/types';

const showMock = vi.fn();
vi.mock('../src/components/Toast', () => ({
  useToast: () => ({ show: showMock, dismiss: vi.fn(), toasts: [] }),
}));

function prefs(overrides: Partial<PreferencesResponse['ui']> = {}): PreferencesResponse {
  return {
    ui: {
      theme: 'system',
      accent: 'indigo',
      aiPreview: false,
      density: 'comfortable',
      contentScale: 'm',
      ...overrides,
    },
    inbox: {
      sections: {},
      defaultSort: 'updated',
      sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
    } as PreferencesResponse['inbox'],
    github: { host: 'https://github.com', configPath: '/c', logsPath: '/l' },
  };
}

// A leaf consumer that reads the shared store via usePreferences().
function ThemeProbe({ label }: { label: string }) {
  const { preferences } = usePreferences();
  return <span data-testid={label}>{preferences?.ui.theme ?? 'loading'}</span>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  showMock.mockReset();
});

describe('PreferencesProvider', () => {
  it('fetches GET /api/preferences exactly once for multiple consumers on mount', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(prefs());

    render(
      <PreferencesProvider>
        <ThemeProbe label="a" />
        <ThemeProbe label="b" />
        <ThemeProbe label="c" />
      </PreferencesProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('system'));
    // Three consumers, but one shared provider → one fetch. On the old
    // per-consumer hook this would have been three.
    const prefGets = get.mock.calls.filter(([path]) => path === '/api/preferences');
    expect(prefGets).toHaveLength(1);
    // All consumers observe the same shared value.
    expect(screen.getByTestId('b')).toHaveTextContent('system');
    expect(screen.getByTestId('c')).toHaveTextContent('system');
  });

  it('refetches exactly once per window focus across all consumers', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(prefs());

    render(
      <PreferencesProvider>
        <ThemeProbe label="a" />
        <ThemeProbe label="b" />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('system'));

    const before = get.mock.calls.filter(([p]) => p === '/api/preferences').length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      const after = get.mock.calls.filter(([p]) => p === '/api/preferences').length;
      expect(after).toBe(before + 1);
    });
  });

  it('shares set() across consumers — a write in one is visible to the others', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(prefs());
    vi.spyOn(apiClient, 'post').mockResolvedValue(prefs({ theme: 'dark' }));

    function Writer() {
      const { set } = usePreferences();
      return (
        <button type="button" onClick={() => void set('theme', 'dark')}>
          go-dark
        </button>
      );
    }

    render(
      <PreferencesProvider>
        <Writer />
        <ThemeProbe label="reader" />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('reader')).toHaveTextContent('system'));

    await act(async () => {
      screen.getByText('go-dark').click();
    });

    // The reader, a separate consumer, sees the writer's update — proving one
    // shared store rather than independent per-consumer copies.
    await waitFor(() => expect(screen.getByTestId('reader')).toHaveTextContent('dark'));
  });

  it('is lenient outside a provider — falls back to a live local self-fetch (no throw)', async () => {
    // Mirrors useEventSource(): a consumer rendered without a PreferencesProvider
    // must not crash. It self-fetches (the pre-#143 per-consumer behavior).
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(prefs({ theme: 'dark' }));
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.preferences).not.toBeNull());
    expect(result.current.preferences?.ui.theme).toBe('dark');
    expect(get.mock.calls.filter(([p]) => p === '/api/preferences')).toHaveLength(1);
  });

  it('a failed GET sets the shared error and leaves preferences null; a later success clears it', async () => {
    // The shared-store topology means one failed fetch leaves every consumer in
    // error/null at once. A subsequent successful refetch must clear the error.
    vi.spyOn(apiClient, 'get')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(prefs({ theme: 'dark' }));
    const { result } = renderHook(() => usePreferences());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.preferences).toBeNull();

    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.preferences?.ui.theme).toBe('dark');
  });
});

// #262 PR3: inbox.defaultSort is the first scalar inbox preference. It must route
// through its own readKey/writeKey branch (prefs.inbox.defaultSort), NOT the
// inbox.sections.* slice fallthrough (which would land it at sections['defaultSort']).
describe('readKey/writeKey — inbox.defaultSort routing', () => {
  it('routes inbox.defaultSort to the scalar branch, not sections', () => {
    const base = prefs();
    expect(readKey(base, 'inbox.defaultSort')).toBe('updated');

    const next = writeKey(base, 'inbox.defaultSort', 'pushed');
    expect(next.inbox.defaultSort).toBe('pushed');
    // Did NOT leak into the sections slice.
    expect((next.inbox.sections as unknown as Record<string, unknown>).defaultSort).toBeUndefined();
  });
});

// #275: inbox.sectionOrder is a new scalar inbox preference. It must route
// through its own readKey/writeKey branch, NOT the inbox.sections.* slice
// fallthrough (which would corrupt the sections map).
describe('readKey/writeKey — inbox.sectionOrder routing', () => {
  it('writes inbox.sectionOrder via its own arm without touching inbox.sections', () => {
    const before = {
      ui: {},
      github: {},
      inbox: {
        sections: {
          'review-requested': true,
          'awaiting-author': true,
          'authored-by-me': true,
          mentioned: true,
          'recently-closed': true,
        },
        defaultSort: 'updated',
        sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
      },
    } as unknown as import('../src/api/types').PreferencesResponse;

    const after = writeKey(
      before,
      'inbox.sectionOrder',
      'mentioned,review-requested,authored-by-me,awaiting-author',
    );

    expect(after.inbox.sectionOrder).toBe(
      'mentioned,review-requested,authored-by-me,awaiting-author',
    );
    // The slice-fallthrough trap: sections must be untouched.
    expect(after.inbox.sections).toEqual(before.inbox.sections);
    expect(readKey(after, 'inbox.sectionOrder')).toBe(
      'mentioned,review-requested,authored-by-me,awaiting-author',
    );
  });
});
