import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiHunkAnnotation } from '../src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation';

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

  it('renders the ai-icon as a decorative AiMarker (svg is aria-hidden)', () => {
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
    const icon = container.querySelector('.ai-icon');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-ai-marker');
    expect(container.querySelector('.ai-icon svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
