import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PrDescription } from '../src/components/PrDetail/OverviewTab/PrDescription';

describe('PrDescription', () => {
  it('renders the body as Markdown', () => {
    render(
      <PrDescription
        title="Renewal worker batches"
        body="**Important**: this changes batch behavior."
        aiPreview={false}
      />,
    );
    expect(screen.getByText('Important')).toBeInTheDocument();
    const strong = screen.getByText('Important');
    expect(strong.tagName.toLowerCase()).toBe('strong');
  });

  it('applies the overview-card-hero-no-ai modifier when aiPreview is false', () => {
    const { container } = render(
      <PrDescription title="Title" body="Body content" aiPreview={false} />,
    );
    const card = container.querySelector('.pr-description');
    expect(card).toHaveClass('overview-card-hero-no-ai');
    expect(card).toHaveClass('overview-card');
  });

  it('renders the leading title row when aiPreview is false', () => {
    render(<PrDescription title="Renewal worker batches" body="Body" aiPreview={false} />);
    const titleEl = screen.getByText('Renewal worker batches');
    expect(titleEl.closest('.pr-description-title')).toBeTruthy();
  });

  it('omits the hero modifier when aiPreview is true (AiSummaryCard takes the hero)', () => {
    const { container } = render(
      <PrDescription title="Title" body="Body content" aiPreview={true} />,
    );
    const card = container.querySelector('.pr-description');
    expect(card).not.toHaveClass('overview-card-hero-no-ai');
    expect(card).toHaveClass('overview-card');
  });

  it('omits the leading title row when aiPreview is true', () => {
    render(<PrDescription title="Renewal worker batches" body="Body" aiPreview={true} />);
    expect(screen.queryByText('Renewal worker batches')).not.toBeInTheDocument();
  });

  it('renders the empty-PR placeholder when body is empty', () => {
    render(<PrDescription title="Title" body="" aiPreview={false} />);
    const placeholder = screen.getByText('No description provided');
    expect(placeholder).toBeInTheDocument();
    expect(placeholder).toHaveClass('muted');
  });

  it('renders the empty-PR placeholder when body is whitespace-only', () => {
    render(<PrDescription title="Title" body={'   \n  \t  '} aiPreview={false} />);
    expect(screen.getByText('No description provided')).toBeInTheDocument();
  });

  it('still renders the leading title row when body is empty (non-AI hero stays anchored)', () => {
    render(<PrDescription title="Renewal worker batches" body="" aiPreview={false} />);
    expect(screen.getByText('Renewal worker batches')).toBeInTheDocument();
    expect(screen.getByText('No description provided')).toBeInTheDocument();
  });
});
