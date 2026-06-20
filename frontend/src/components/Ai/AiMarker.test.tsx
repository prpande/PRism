// frontend/src/components/Ai/AiMarker.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AiMarker } from './AiMarker';
import { AI_PROVENANCE_LABEL } from './aiStrings';

describe('AiMarker', () => {
  it('provenance (default) renders the Prism glyph plus an sr-only label', () => {
    render(<AiMarker />);
    const marker = screen.getByTestId('ai-marker');
    expect(marker.querySelector('svg')).not.toBeNull();
    expect(marker).toHaveTextContent(AI_PROVENANCE_LABEL);
    expect(marker).not.toHaveAttribute('title');
  });

  it('decorative renders the Prism glyph with no sr-only label and no title', () => {
    render(<AiMarker decorative />);
    const marker = screen.getByTestId('ai-marker');
    expect(marker.querySelector('svg')).not.toBeNull();
    expect(marker).toHaveTextContent('');
    expect(marker).not.toHaveAttribute('title');
  });

  it('applies the variant class (superscript default, inline + lead opt-in)', () => {
    const { rerender } = render(<AiMarker />);
    expect(screen.getByTestId('ai-marker').className).toMatch(/superscript/);
    rerender(<AiMarker variant="inline" />);
    expect(screen.getByTestId('ai-marker').className).toMatch(/inline/);
    rerender(<AiMarker variant="lead" />);
    expect(screen.getByTestId('ai-marker').className).toMatch(/lead/);
  });
});

it('renders the working class, sr-only label, and a native title tooltip when state=working', () => {
  render(<AiMarker state="working" />);
  const marker = screen.getByTestId('ai-marker');
  expect(marker.className).toMatch(/working/);
  expect(screen.getByText('AI is working…')).toBeInTheDocument();
  expect(marker).toHaveAttribute('title', 'AI is working…');
});

it('omits the sr-only label when working and decorative, but KEEPS the title tooltip', () => {
  render(<AiMarker state="working" decorative />);
  // decorative drops the sr-only label only; the hover tooltip is the visible
  // affordance and stays (e.g. the decorative file-tree header working marker).
  expect(screen.queryByText('AI is working…')).not.toBeInTheDocument();
  expect(screen.getByTestId('ai-marker')).toHaveAttribute('title', 'AI is working…');
});

it('defaults to idle with no working class', () => {
  render(<AiMarker />);
  expect(screen.getByTestId('ai-marker').className).not.toMatch(/working/);
});
