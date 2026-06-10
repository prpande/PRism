import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterFacet } from './FilterFacet';

describe('FilterFacet', () => {
  it('shows the bare name when nothing is selected and a count when ≥1', () => {
    const { rerender } = render(
      <FilterFacet
        name="Repo"
        values={['acme/api', 'acme/bff']}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Repo/ })).toHaveTextContent('Repo');
    rerender(
      <FilterFacet
        name="Repo"
        values={['acme/api', 'acme/bff']}
        selected={['acme/api']}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Repo/ })).toHaveTextContent('Repo (1)');
  });

  it('toggles a value on checkbox click', () => {
    const onToggle = vi.fn();
    render(<FilterFacet name="Repo" values={['acme/api']} selected={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /Repo/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    expect(onToggle).toHaveBeenCalledWith('acme/api');
  });
});
