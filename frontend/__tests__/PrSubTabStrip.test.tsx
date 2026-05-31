import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PrSubTabStrip } from '../src/components/PrDetail/PrSubTabStrip';
import styles from '../src/components/PrDetail/PrSubTabStrip.module.css';

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
    expect(screen.getByRole('tab', { name: /drafts/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('Drafts tab is enabled in S4 PR6 — no aria-disabled, full tab cycle', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} />);
    const drafts = screen.getByRole('tab', { name: /drafts/i });
    expect(drafts).not.toHaveAttribute('aria-disabled');
    expect(drafts).toHaveAttribute('tabindex', '0');
  });

  it('clicking Files calls onTabChange("files")', async () => {
    const onTabChange = vi.fn();
    render(<PrSubTabStrip activeTab="overview" onTabChange={onTabChange} />);
    await userEvent.click(screen.getByRole('tab', { name: /files/i }));
    expect(onTabChange).toHaveBeenCalledWith('files');
  });

  it('clicking Drafts calls onTabChange("drafts") in S4 PR6', async () => {
    const onTabChange = vi.fn();
    render(<PrSubTabStrip activeTab="overview" onTabChange={onTabChange} />);
    await userEvent.click(screen.getByRole('tab', { name: /drafts/i }));
    expect(onTabChange).toHaveBeenCalledWith('drafts');
  });

  it('renders file count next to Files tab when provided', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} fileCount={12} />);
    const files = screen.getByRole('tab', { name: /files/i });
    expect(files.textContent).toMatch(/12/);
  });

  it('renders draft count next to Drafts tab when > 0', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} draftsCount={3} />);
    const drafts = screen.getByRole('tab', { name: /drafts/i });
    expect(drafts.textContent).toMatch(/3/);
  });

  it('does NOT render a "0" count next to Drafts tab when draftsCount is 0', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} draftsCount={0} />);
    const drafts = screen.getByRole('tab', { name: /drafts/i });
    expect(drafts.querySelector('[data-testid="pr-tab-count"]')).toBeNull();
  });

  // D11/D103 — handoff (design/handoff/pr-detail.jsx:124 + :134) applies the
  // `.pr-tab-count-warn` class drafts-only, never on files. The base
  // `.pr-tab-count` class is shared.
  it('applies .prTabCountWarn class on the drafts tab when draftsCount > 0', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} draftsCount={3} />);
    const drafts = screen.getByRole('tab', { name: /drafts/i });
    const count = drafts.querySelector('[data-testid="pr-tab-count"]');
    expect(count).not.toBeNull();
    expect(count?.classList.contains(styles.prTabCount)).toBe(true);
    expect(count?.classList.contains(styles.prTabCountWarn)).toBe(true);
  });

  it('does NOT apply .prTabCountWarn class on the files tab when fileCount > 0', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} fileCount={12} />);
    const files = screen.getByRole('tab', { name: /files/i });
    const count = files.querySelector('[data-testid="pr-tab-count"]');
    expect(count).not.toBeNull();
    expect(count?.classList.contains(styles.prTabCount)).toBe(true);
    expect(count?.classList.contains(styles.prTabCountWarn)).toBe(false);
  });
});
