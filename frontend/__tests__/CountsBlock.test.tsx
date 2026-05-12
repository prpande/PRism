import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CountsBlock } from '../src/components/PrDetail/SubmitDialog/CountsBlock';

describe('CountsBlock', () => {
  it('renders the plural copy for >1', () => {
    render(<CountsBlock threadCount={3} replyCount={2} />);
    expect(
      screen.getByText(/This review will create 3 new threads and 2 replies\./i),
    ).toBeInTheDocument();
  });

  it('renders the singular copy for exactly 1', () => {
    render(<CountsBlock threadCount={1} replyCount={1} />);
    expect(
      screen.getByText(/This review will create 1 new thread and 1 reply\./i),
    ).toBeInTheDocument();
  });

  it('renders 0 explicitly (uses the plural form for 0)', () => {
    render(<CountsBlock threadCount={0} replyCount={0} />);
    expect(
      screen.getByText(/This review will create 0 new threads and 0 replies\./i),
    ).toBeInTheDocument();
  });
});
