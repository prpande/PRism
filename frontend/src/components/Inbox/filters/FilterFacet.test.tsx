import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('FilterFacet — dismissal (#705 shared hook)', () => {
  function setup() {
    render(
      <div>
        <button>outside</button>
        <FilterFacet
          name="Repo"
          values={['acme/api', 'acme/bff']}
          selected={[]}
          onToggle={() => {}}
        />
      </div>,
    );
    return screen.getByRole('button', { name: /Repo/ });
  }

  it('closes on Escape and returns focus to the trigger', async () => {
    const trigger = setup();
    await userEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Repo filter' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Repo filter' })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes on outside click and leaves focus where the click landed', async () => {
    const trigger = setup();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('group', { name: 'Repo filter' })).toBeNull();
    // Flush the deferred focus-return path to prove it does NOT fire on outside close.
    await new Promise((r) => setTimeout(r, 0));
    expect(trigger).not.toHaveFocus();
  });

  it('closes when keyboard focus tabs away, without refocusing the trigger', async () => {
    const trigger = setup();
    await userEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Repo filter' })).toBeInTheDocument();
    await userEvent.tab(); // trigger → first checkbox (inside popover: stays open)
    expect(screen.getByRole('group', { name: 'Repo filter' })).toBeInTheDocument();
    await userEvent.tab(); // → second checkbox
    await userEvent.tab(); // leaves the facet entirely
    expect(screen.queryByRole('group', { name: 'Repo filter' })).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(trigger).not.toHaveFocus();
  });
});
