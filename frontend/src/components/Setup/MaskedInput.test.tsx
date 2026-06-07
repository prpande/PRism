import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MaskedInput } from './MaskedInput';

describe('MaskedInput', () => {
  it('marks the input invalid when hasError is set', () => {
    render(
      <MaskedInput
        id="pat"
        value=""
        onChange={vi.fn()}
        ariaLabel="Personal access token"
        hasError
      />,
    );
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('aria-invalid', 'true');
  });
  it('has no aria-invalid when hasError is absent', () => {
    render(<MaskedInput id="pat" value="" onChange={vi.fn()} ariaLabel="Personal access token" />);
    expect(screen.getByLabelText('Personal access token')).not.toHaveAttribute('aria-invalid');
  });
  it('associates the error text via aria-describedby only when hasError is set', () => {
    const { rerender } = render(
      <MaskedInput
        id="pat"
        value=""
        onChange={vi.fn()}
        ariaLabel="Personal access token"
        errorId="pat-err"
      />,
    );
    // errorId present but no error → no association (avoids pointing at an absent node).
    expect(screen.getByLabelText('Personal access token')).not.toHaveAttribute('aria-describedby');
    rerender(
      <MaskedInput
        id="pat"
        value=""
        onChange={vi.fn()}
        ariaLabel="Personal access token"
        errorId="pat-err"
        hasError
      />,
    );
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute(
      'aria-describedby',
      'pat-err',
    );
  });
});
