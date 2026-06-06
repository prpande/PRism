import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { SettingsLink } from './SettingsLink';

function StateProbe() {
  const loc = useLocation();
  return <pre data-testid="bg">{JSON.stringify(loc.state)}</pre>;
}

describe('SettingsLink', () => {
  it('preserves backgroundLocation across intra-modal navigation', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/settings/appearance',
            state: { backgroundLocation: { pathname: '/pr/o/r/1' } },
          },
        ]}
      >
        <SettingsLink to="/settings/system">System</SettingsLink>
        <Routes>
          <Route path="/settings/:section" element={<StateProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByText('System'));
    expect(screen.getByTestId('bg').textContent).toContain('/pr/o/r/1');
  });
});
