import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../../contexts/OpenTabsContext';
import { PasteUrlInput } from './PasteUrlInput';

// PasteUrlInput.tsx imports `inboxApi` from '../../api/inbox' and calls
// `inboxApi.parsePrUrl(...)`. Mock that named export shape.
vi.mock('../../api/inbox', () => ({
  inboxApi: {
    parsePrUrl: vi.fn(async () => ({
      ok: true,
      ref: { owner: 'acme', repo: 'api', number: 7 },
      error: null,
      configuredHost: 'github.com',
      urlHost: 'github.com',
    })),
  },
}));

function TabsProbe() {
  const { openTabs } = useOpenTabs();
  return <div data-testid="tab-count">{openTabs.length}</div>;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="path">{loc.pathname}</div>;
}

describe('PasteUrlInput adds a tab when the URL parses', () => {
  it('adds the parsed ref to openTabs before navigating', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <TabsProbe />
          <LocationProbe />
          <Routes>
            <Route path="/" element={<PasteUrlInput />} />
            <Route path="/pr/:owner/:repo/:number" element={<div>PR Detail</div>} />
          </Routes>
        </OpenTabsProvider>
      </MemoryRouter>,
    );

    await userEvent.type(
      screen.getByPlaceholderText('Paste a PR URL to open it…'),
      'https://github.com/acme/api/pull/7{enter}',
    );

    // openTabs has the parsed ref, and we navigated to the detail route.
    expect(await screen.findByTestId('tab-count')).toHaveTextContent('1');
    expect(screen.getByTestId('path')).toHaveTextContent('/pr/acme/api/7');
  });
});
