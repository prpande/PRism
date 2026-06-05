import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ErrorBox } from './ErrorBox';

describe('ErrorBox', () => {
  it('renders role="alert" on the element', () => {
    render(<ErrorBox>Something failed</ErrorBox>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders the children text', () => {
    render(<ErrorBox>Something failed</ErrorBox>);
    expect(screen.getByText('Something failed')).toBeInTheDocument();
  });

  it('lands a passed className on the same alert node', () => {
    render(<ErrorBox className="my-hook">Something failed</ErrorBox>);
    expect(screen.getByRole('alert')).toHaveClass('my-hook');
  });

  it('renders a decorative icon (aria-hidden svg)', () => {
    const { container } = render(<ErrorBox>Something failed</ErrorBox>);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders children as direct content of the alert node', () => {
    render(<ErrorBox>msg</ErrorBox>);
    expect(screen.getByText('msg')).toHaveAttribute('role', 'alert');
  });
});
