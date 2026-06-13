import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Select } from './Select';

const OPTS = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'pushed', label: 'Recently pushed' },
  { value: 'diff', label: 'Largest diff' },
  { value: 'comments', label: 'Most comments' },
];

describe('Select — core', () => {
  it('renders a combobox showing the selected label, list closed', () => {
    render(<Select aria-label="Sort" options={OPTS} value="pushed" onChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    expect(trigger).toHaveTextContent('Recently pushed');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens the listbox on trigger click and renders all options', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={() => {}} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.getByRole('option', { name: 'Recently updated' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('selecting an option fires onChange and closes the list', async () => {
    const onChange = vi.fn();
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={onChange} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
    await userEvent.click(screen.getByRole('option', { name: 'Largest diff' }));
    expect(onChange).toHaveBeenCalledWith('diff');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('clicking outside closes the list without firing onChange', async () => {
    const onChange = vi.fn();
    render(
      <div>
        <Select aria-label="Sort" options={OPTS} value="updated" onChange={onChange} />
        <button>outside</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sets combobox/listbox ARIA wiring', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
  });
});
