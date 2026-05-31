import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppearanceSection } from '../../src/components/Settings/AppearanceSection';
import { usePreferences } from '../../src/hooks/usePreferences';
import { applyDensityToDocument } from '../../src/utils/applyTheme';
import type { PreferencesResponse } from '../../src/api/types';

vi.mock('../../src/hooks/usePreferences');
vi.mock('../../src/hooks/useCapabilities', () => ({
  useCapabilities: () => ({ refetch: vi.fn() }),
}));
vi.mock('../../src/utils/applyTheme', () => ({
  applyThemeToDocument: vi.fn(),
  applyDensityToDocument: vi.fn(),
}));

function mockPrefs(density: 'comfortable' | 'compact' = 'comfortable'): PreferencesResponse {
  return {
    ui: { theme: 'system', accent: 'indigo', aiPreview: false, density },
    inbox: {
      sections: {
        'review-requested': true,
        'awaiting-author': true,
        'authored-by-me': true,
        mentioned: true,
        'ci-failing': true,
      },
    },
    github: { host: 'https://github.com', configPath: '/fake/config.json', logsPath: '/fake/logs' },
  };
}

describe('AppearanceSection density picker (PR9b-density)', () => {
  const mockSet = vi.fn();

  beforeEach(() => {
    vi.mocked(usePreferences).mockReturnValue({
      preferences: mockPrefs('comfortable'),
      error: null,
      refetch: vi.fn(),
      set: mockSet,
    });
    mockSet.mockReset();
    mockSet.mockResolvedValue(undefined);
    vi.mocked(applyDensityToDocument).mockReset();
  });

  it('renders the density picker with comfortable + compact options', () => {
    render(<AppearanceSection />);
    const select = screen.getByLabelText('Density') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['comfortable', 'compact']);
  });

  it('places the density row between Accent and AI preview (visual chrome before functional toggle)', () => {
    render(<AppearanceSection />);
    // Spec § 4.9.2 IA: Theme → Accent → Density → AI preview. The order of
    // accessible names within the section establishes the rendered DOM order.
    const labels = screen
      .getAllByText(/Theme|Accent|Density|AI preview/i)
      .map((el) => el.textContent);
    const densityIdx = labels.findIndex((t) => /density/i.test(t ?? ''));
    const aiIdx = labels.findIndex((t) => /ai preview/i.test(t ?? ''));
    const accentIdx = labels.findIndex((t) => /accent/i.test(t ?? ''));
    expect(densityIdx).toBeGreaterThan(accentIdx);
    expect(densityIdx).toBeLessThan(aiIdx);
  });

  it('changing density optimistically calls applyDensityToDocument + set("density", value)', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    const select = screen.getByLabelText('Density');
    await user.selectOptions(select, 'compact');

    expect(applyDensityToDocument).toHaveBeenCalledWith('compact');
    expect(mockSet).toHaveBeenCalledWith('density', 'compact');
  });

  it('POST failure re-applies prior density (rollback parity with theme/accent)', async () => {
    mockSet.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    render(<AppearanceSection />);
    const select = screen.getByLabelText('Density');
    await user.selectOptions(select, 'compact');

    // Poll the observable condition — Windows CI runners flake on sub-second
    // fixed sleeps (memory: feedback_windows_ci_fixed_delay_flake).
    await waitFor(() => expect(applyDensityToDocument).toHaveBeenCalledWith('comfortable'));
    expect(applyDensityToDocument).toHaveBeenCalledWith('compact'); // optimistic
    expect(applyDensityToDocument).toHaveBeenCalledWith('comfortable'); // rollback
  });
});
