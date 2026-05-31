import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InboxSectionsSection } from '../../src/components/Settings/InboxSectionsSection';

const setMock = vi.fn(() => Promise.resolve());

vi.mock('../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
      inbox: {
        sections: {
          'review-requested': true,
          'awaiting-author': true,
          'authored-by-me': true,
          mentioned: true,
          'ci-failing': true,
        },
      },
      github: {
        host: 'https://github.com',
        configPath: '/x/config.json',
        logsPath: '/x/logs',
      },
    },
    error: null,
    refetch: vi.fn(),
    set: setMock,
  }),
}));

describe('InboxSectionsSection', () => {
  beforeEach(() => setMock.mockClear());

  it('renders five toggles each describedby the shared helper span', () => {
    render(<InboxSectionsSection />);
    const toggles = screen.getAllByRole('switch');
    expect(toggles).toHaveLength(5);
    toggles.forEach((toggle) =>
      expect(toggle).toHaveAttribute('aria-describedby', 'inbox-section-help'),
    );
    expect(screen.getByText(/within 2 minutes/i)).toBeInTheDocument();
  });

  it('clicking a toggle posts the dotted-path key matching the section id', async () => {
    const user = userEvent.setup();
    render(<InboxSectionsSection />);
    const reviewToggle = screen.getByRole('switch', { name: /review requested/i });
    await user.click(reviewToggle);
    // Starting state is checked=true; click flips to false.
    expect(setMock).toHaveBeenCalledWith('inbox.sections.review-requested', false);
  });

  it('clicking a different toggle uses the matching dotted-path key', async () => {
    const user = userEvent.setup();
    render(<InboxSectionsSection />);
    const ciToggle = screen.getByRole('switch', { name: /CI failing on my PRs/i });
    await user.click(ciToggle);
    expect(setMock).toHaveBeenCalledWith('inbox.sections.ci-failing', false);
  });
});
