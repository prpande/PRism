import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatsTiles } from '../src/components/PrDetail/OverviewTab/StatsTiles';

function findTile(label: string) {
  const heading = screen.getByText(new RegExp(`^${label}$`, 'i'));
  return heading.closest('.stats-tile') as HTMLElement;
}

describe('StatsTiles', () => {
  it('renders the four labeled tiles in order: Files, Drafts, Threads, Viewed', () => {
    render(<StatsTiles filesCount={3} draftsCount={0} threadsCount={2} viewedCount={1} />);
    const labels = screen.getAllByRole('term').map((el) => el.textContent);
    expect(labels).toEqual(['Files', 'Drafts', 'Threads', 'Viewed']);
  });

  it('renders the files count', () => {
    render(<StatsTiles filesCount={7} draftsCount={0} threadsCount={0} viewedCount={0} />);
    const tile = findTile('Files');
    expect(within(tile).getByText('7')).toBeInTheDocument();
  });

  it('renders drafts count even when zero (S3 has no composer)', () => {
    render(<StatsTiles filesCount={0} draftsCount={0} threadsCount={0} viewedCount={0} />);
    const tile = findTile('Drafts');
    expect(within(tile).getByText('0')).toBeInTheDocument();
  });

  it('renders the threads count', () => {
    render(<StatsTiles filesCount={0} draftsCount={0} threadsCount={4} viewedCount={0} />);
    const tile = findTile('Threads');
    expect(within(tile).getByText('4')).toBeInTheDocument();
  });

  it('renders viewed as N/M against filesCount', () => {
    render(<StatsTiles filesCount={5} draftsCount={0} threadsCount={0} viewedCount={2} />);
    const tile = findTile('Viewed');
    expect(within(tile).getByText('2/5')).toBeInTheDocument();
  });

  it('handles empty PR (zero files, viewed renders as 0/0)', () => {
    render(<StatsTiles filesCount={0} draftsCount={0} threadsCount={0} viewedCount={0} />);
    expect(within(findTile('Files')).getByText('0')).toBeInTheDocument();
    expect(within(findTile('Viewed')).getByText('0/0')).toBeInTheDocument();
  });
});
