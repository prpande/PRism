// frontend/src/components/Ai/AiMarker.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AiMarker } from './AiMarker';
import { AI_PROVENANCE_LABEL, AI_IDLE_DONE_LABEL } from './aiStrings';

describe('AiMarker', () => {
  it('provenance (default) renders the Prism glyph, an sr-only label, and an idle hover tooltip', () => {
    render(<AiMarker />);
    const marker = screen.getByTestId('ai-marker');
    expect(marker.querySelector('svg')).not.toBeNull();
    expect(marker).toHaveTextContent(AI_PROVENANCE_LABEL);
    // Idle now carries a persistent hover tooltip confirming the AI work is done.
    expect(marker).toHaveAttribute('title', AI_IDLE_DONE_LABEL);
  });

  it('decorative drops the sr-only label but KEEPS the idle hover tooltip', () => {
    render(<AiMarker decorative />);
    const marker = screen.getByTestId('ai-marker');
    expect(marker.querySelector('svg')).not.toBeNull();
    expect(marker).toHaveTextContent('');
    // The tooltip is the visible affordance, so it stays even when decorative.
    expect(marker).toHaveAttribute('title', AI_IDLE_DONE_LABEL);
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
