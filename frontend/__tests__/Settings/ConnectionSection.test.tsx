import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionSection } from '../../src/components/Settings/ConnectionSection';

const showMock = vi.fn();
vi.mock('../../src/components/Toast', () => ({
  useToast: () => ({ show: showMock, dismiss: vi.fn(), toasts: [] }),
}));
vi.mock('../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: { theme: 'system', accent: 'indigo', aiPreview: false },
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
        configPath: '/Users/x/AppData/Local/PRism/config.json',
        logsPath: '/Users/x/AppData/Local/PRism/logs',
      },
    },
    error: null,
    refetch: vi.fn(),
    set: vi.fn(),
  }),
}));

// @testing-library/user-event v14 installs its own navigator.clipboard mock
// whose writeText always resolves to undefined (used by user.copy()/.paste()).
// To assert success vs failure paths in the component, install OUR mock
// AFTER userEvent.setup() materialises the clipboard, via vi.spyOn on the
// existing instance.
const writeTextMock = vi.fn();

function setupClipboardMock() {
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((text: string) =>
    writeTextMock(text),
  );
}

describe('ConnectionSection', () => {
  beforeEach(() => {
    showMock.mockReset();
    writeTextMock.mockReset();
  });

  it('renders the config.json path as an always-visible read-only input', () => {
    render(<ConnectionSection />);
    const input = screen.getByRole('textbox', { name: /path to config.json/i });
    expect(input).toHaveAttribute('readOnly');
    expect(input).toHaveValue('/Users/x/AppData/Local/PRism/config.json');
  });

  it('renders the logs path as an always-visible read-only input', () => {
    render(<ConnectionSection />);
    const input = screen.getByRole('textbox', { name: /path to prism logs/i });
    expect(input).toHaveAttribute('readOnly');
    expect(input).toHaveValue('/Users/x/AppData/Local/PRism/logs');
  });

  it('clicking Copy config.json path surfaces a success toast on clipboard.writeText resolve', async () => {
    const user = userEvent.setup();
    setupClipboardMock();
    writeTextMock.mockResolvedValue(undefined);
    render(<ConnectionSection />);
    await user.click(screen.getByRole('button', { name: /copy config\.json path/i }));
    await waitFor(() =>
      expect(showMock).toHaveBeenCalledWith({
        kind: 'success',
        message: 'Path copied — paste into your editor.',
      }),
    );
  });

  it('clicking Copy logs path surfaces the distinct logs-specific success toast on resolve', async () => {
    const user = userEvent.setup();
    setupClipboardMock();
    writeTextMock.mockResolvedValue(undefined);
    render(<ConnectionSection />);
    await user.click(screen.getByRole('button', { name: /copy logs path/i }));
    await waitFor(() =>
      expect(showMock).toHaveBeenCalledWith({
        kind: 'success',
        message: 'Logs path copied — paste into a terminal or file browser.',
      }),
    );
  });

  it('clipboard.writeText rejection surfaces the shared error toast (config path)', async () => {
    const user = userEvent.setup();
    setupClipboardMock();
    writeTextMock.mockRejectedValue(new Error('blocked'));
    render(<ConnectionSection />);
    await user.click(screen.getByRole('button', { name: /copy config\.json path/i }));
    await waitFor(() =>
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' })),
    );
  });

  it('clipboard.writeText rejection surfaces the shared error toast (logs path)', async () => {
    const user = userEvent.setup();
    setupClipboardMock();
    writeTextMock.mockRejectedValue(new Error('blocked'));
    render(<ConnectionSection />);
    await user.click(screen.getByRole('button', { name: /copy logs path/i }));
    await waitFor(() =>
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' })),
    );
  });
});
