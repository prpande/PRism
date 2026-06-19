import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PrSubTabStrip } from './PrSubTabStrip';

function renderStrip(showHotspots: boolean) {
  return render(
    <PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} showHotspots={showHotspots} />,
  );
}

describe('PrSubTabStrip AI marker', () => {
  it('Hotspots tab contains the AI marker when showHotspots=true and aiMarkerState is set', () => {
    render(
      <PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} showHotspots aiMarkerState="idle" />,
    );
    const hotspotsTab = screen.getByTestId('pr-tab-hotspots');
    expect(hotspotsTab.querySelector('[data-ai-marker]')).not.toBeNull();
  });

  it('AI marker is accessible via getByTestId within the Hotspots tab', () => {
    render(
      <PrSubTabStrip activeTab="overview" onTabChange={vi.fn()} showHotspots aiMarkerState="idle" />,
    );
    const marker = screen.getByTestId('ai-marker');
    expect(marker).toBeInTheDocument();
    const hotspotsTab = screen.getByTestId('pr-tab-hotspots');
    expect(hotspotsTab).toContainElement(marker);
  });

  it('Overview tab does NOT contain an AI marker', () => {
    renderStrip(true);
    const overviewTab = screen.getByTestId('pr-tab-overview');
    expect(overviewTab.querySelector('[data-ai-marker]')).toBeNull();
  });

  it('Files tab does NOT contain an AI marker', () => {
    renderStrip(true);
    const filesTab = screen.getByTestId('pr-tab-files');
    expect(filesTab.querySelector('[data-ai-marker]')).toBeNull();
  });

  it('Drafts tab does NOT contain an AI marker', () => {
    renderStrip(true);
    const draftsTab = screen.getByTestId('pr-tab-drafts');
    expect(draftsTab.querySelector('[data-ai-marker]')).toBeNull();
  });

  it('when showHotspots=false the Hotspots tab is absent and no AI marker renders', () => {
    renderStrip(false);
    expect(screen.queryByTestId('pr-tab-hotspots')).toBeNull();
    expect(screen.queryByTestId('ai-marker')).toBeNull();
  });

  it('renders a working AiMarker on the Hotspots tab when aiMarkerState is working', () => {
    render(<PrSubTabStrip activeTab="files" onTabChange={() => {}} showHotspots aiMarkerState="working" />);
    expect(within(screen.getByTestId('pr-tab-hotspots')).getByTestId('ai-marker')).toHaveAttribute('data-ai-state', 'working');
  });
  it('renders an idle AiMarker when aiMarkerState is idle', () => {
    render(<PrSubTabStrip activeTab="files" onTabChange={() => {}} showHotspots aiMarkerState="idle" />);
    expect(within(screen.getByTestId('pr-tab-hotspots')).getByTestId('ai-marker')).toHaveAttribute('data-ai-state', 'idle');
  });
  it('renders no AiMarker when aiMarkerState is null', () => {
    render(<PrSubTabStrip activeTab="files" onTabChange={() => {}} showHotspots aiMarkerState={null} />);
    expect(within(screen.getByTestId('pr-tab-hotspots')).queryByTestId('ai-marker')).toBeNull();
  });
});
