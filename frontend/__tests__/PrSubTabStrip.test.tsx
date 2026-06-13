import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PrSubTabStrip } from '../src/components/PrDetail/PrSubTabStrip';
import styles from '../src/components/PrDetail/PrSubTabStrip.module.css';

describe('PrSubTabStrip', () => {
  it('renders four tabs: Overview, Files, Hotspots, Drafts', () => {
    // Spec §8 — the Hotspots tab is gated on showHotspots (the fileFocus
    // capability). Enable it here so the four-tab layout under test is present.
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} showHotspots />);
    expect(screen.getByRole('tab', { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /hotspots/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /drafts/i })).toBeInTheDocument();
  });

  // Spec §8 — Hotspots is rendered ONLY when the fileFocus capability is on.
  // When off it is removed from the DOM (not display:none / aria-hidden), so
  // the tablist carries no inert tab.
  it('does NOT render the Hotspots tab when showHotspots is false (AI Off)', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} showHotspots={false} />);
    expect(screen.queryByRole('tab', { name: /hotspots/i })).not.toBeInTheDocument();
    // The other three tabs remain.
    expect(screen.getByRole('tab', { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /drafts/i })).toBeInTheDocument();
  });

  it('defaults to NOT rendering the Hotspots tab when showHotspots is omitted', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /hotspots/i })).not.toBeInTheDocument();
  });

  it('renders the Hotspots tab when showHotspots is true', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} showHotspots />);
    expect(screen.getByRole('tab', { name: /hotspots/i })).toBeInTheDocument();
  });

  it('marks the Hotspots tab active with aria-selected when it is the active tab', () => {
    render(<PrSubTabStrip activeTab="hotspots" onTabChange={vi.fn()} showHotspots />);
    expect(screen.getByRole('tab', { name: /hotspots/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('clicking Hotspots calls onTabChange("hotspots")', async () => {
    const onTabChange = vi.fn();
    render(<PrSubTabStrip activeTab="overview" onTabChange={onTabChange} showHotspots />);
    await userEvent.click(screen.getByRole('tab', { name: /hotspots/i }));
    expect(onTabChange).toHaveBeenCalledWith('hotspots');
  });

  it('renders the hotspots count and announces "N files need attention" when > 0', () => {
    render(
      <PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} hotspotsCount={3} showHotspots />,
    );
    const hotspots = screen.getByRole('tab', { name: /hotspots/i });
    expect(hotspots.querySelector('[data-testid="pr-tab-count"]')?.textContent).toBe('3');
    expect(hotspots.textContent).toMatch(/3 files need attention/i);
  });

  it('uses singular "file needs attention" when hotspotsCount is 1', () => {
    render(
      <PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} hotspotsCount={1} showHotspots />,
    );
    const hotspots = screen.getByRole('tab', { name: /hotspots/i });
    expect(hotspots.textContent).toMatch(/1 file needs attention/i);
  });

  it('does NOT render a count next to Hotspots when hotspotsCount is undefined', () => {
    render(<PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} showHotspots />);
    const hotspots = screen.getByRole('tab', { name: /hotspots/i });
    expect(hotspots.querySelector('[data-testid="pr-tab-count"]')).toBeNull();
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
