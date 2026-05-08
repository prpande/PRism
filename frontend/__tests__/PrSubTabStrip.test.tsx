import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PrSubTabStrip } from '../src/components/PrDetail/PrSubTabStrip';

describe('PrSubTabStrip', () => {
  it('renders three tabs: Overview, Files, Drafts', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /drafts/i })).toBeInTheDocument();
  });

  it('renders tablist as a group', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('marks the active tab with aria-selected=true and others false', () => {
    render(<PrSubTabStrip activeTab="files" onTabChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tab', { name: /files/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /drafts/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('Drafts tab is aria-disabled with tabIndex=-1 (skipped from Tab cycle)', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} />);
    const drafts = screen.getByRole('tab', { name: /drafts/i });
    expect(drafts).toHaveAttribute('aria-disabled', 'true');
    expect(drafts).toHaveAttribute('tabindex', '-1');
  });

  it('Drafts tab carries a tooltip explaining the disabled state', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} />);
    const drafts = screen.getByRole('tab', { name: /drafts/i });
    expect(drafts).toHaveAttribute('title', expect.stringMatching(/Drafts arrive in S4/i));
  });

  it('clicking Files calls onTabChange("files")', async () => {
    const onTabChange = vi.fn();
    render(<PrSubTabStrip activeTab="overview" onTabChange={onTabChange} />);
    await userEvent.click(screen.getByRole('tab', { name: /files/i }));
    expect(onTabChange).toHaveBeenCalledWith('files');
  });

  it('clicking Drafts does NOT call onTabChange', async () => {
    const onTabChange = vi.fn();
    render(<PrSubTabStrip activeTab="overview" onTabChange={onTabChange} />);
    await userEvent.click(screen.getByRole('tab', { name: /drafts/i }));
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it('renders file count next to Files tab when provided', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} fileCount={12} />);
    const files = screen.getByRole('tab', { name: /files/i });
    expect(files.textContent).toMatch(/12/);
  });
});
