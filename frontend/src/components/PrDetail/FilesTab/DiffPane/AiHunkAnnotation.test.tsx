import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiHunkAnnotation } from './AiHunkAnnotation';

describe('AiHunkAnnotation', () => {
  it('renders Calm tone as Note + chip-info', () => {
    render(
      <AiHunkAnnotation
        annotation={{
          path: 'src/Calc.cs',
          hunkIndex: 0,
          body: 'Looks fine.',
          tone: 'calm',
        }}
      />,
    );
    expect(screen.getByTestId('ai-hunk')).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(screen.getByText('Looks fine.')).toBeInTheDocument();
    const chip = screen.getByText('Note');
    expect(chip.className).toContain('chip-info');
  });

  it('renders HeadsUp tone as "Behavior change" + chip-warning', () => {
    render(
      <AiHunkAnnotation
        annotation={{
          path: 'src/Calc.cs',
          hunkIndex: 1,
          body: 'Failure semantics changed.',
          tone: 'heads-up',
        }}
      />,
    );
    expect(screen.getByText('Behavior change')).toBeInTheDocument();
    expect(screen.getByText('Failure semantics changed.')).toBeInTheDocument();
    const chip = screen.getByText('Behavior change');
    expect(chip.className).toContain('chip-warning');
  });

  it('renders Concern tone as Concern + chip-danger', () => {
    render(
      <AiHunkAnnotation
        annotation={{
          path: 'src/Calc.cs',
          hunkIndex: 2,
          body: 'Possible regression.',
          tone: 'concern',
        }}
      />,
    );
    expect(screen.getByText('Concern')).toBeInTheDocument();
    expect(screen.getByText('Possible regression.')).toBeInTheDocument();
    const chip = screen.getByText('Concern');
    expect(chip.className).toContain('chip-danger');
  });

  it('renders a decorative, un-boxed AiMarker (bare glyph, svg is aria-hidden)', () => {
    const { container } = render(
      <AiHunkAnnotation
        annotation={{
          path: 'src/Calc.cs',
          hunkIndex: 0,
          body: 'x',
          tone: 'calm',
        }}
      />,
    );
    // #508 B1 un-boxed the marker: it no longer carries the `.ai-icon` chip box —
    // it's the bare AiMarker glyph, consistent with the other AI surfaces.
    const icon = container.querySelector('[data-ai-marker]');
    expect(icon).toBeInTheDocument();
    expect(container.querySelector('.ai-icon')).not.toBeInTheDocument();
    expect(container.querySelector('[data-ai-marker] svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
