import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemPane } from './SystemPane';

const show = vi.fn();
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: {}, inbox: { sections: {} }, github: { host: 'h', configPath: 'C:/x/config.json', logsPath: 'C:/x/logs' } } }),
}));
vi.mock('../../Toast', () => ({ useToast: () => ({ show }) }));
beforeEach(() => show.mockClear());

describe('SystemPane', () => {
  it('shows the config and logs paths', () => {
    render(<SystemPane />);
    expect(screen.getByDisplayValue('C:/x/config.json')).toBeInTheDocument();
    expect(screen.getByDisplayValue('C:/x/logs')).toBeInTheDocument();
  });

  it('copies the config path and toasts success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    render(<SystemPane />);
    await user.click(screen.getByRole('button', { name: /copy config\.json path/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('C:/x/config.json'));
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
  });
});
