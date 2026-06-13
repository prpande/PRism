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

describe('Select — keyboard', () => {
  const DIS = [
    { value: 1, label: 'Iter 1' },
    { value: 2, label: 'Iter 2 (snapshot lost)', disabled: true },
    { value: 3, label: 'Iter 3' },
  ];

  it('opens on ArrowDown with the selected option active', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="pushed" onChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Recently pushed' })).toHaveClass(/optionActive/);
  });

  it('Arrow keys skip disabled options and stop at the boundary (no wrap)', async () => {
    render(<Select aria-label="Iter" options={DIS} value={1} onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // open at selected (Iter 1)
    expect(screen.getByRole('option', { name: 'Iter 1' })).toHaveClass(/optionActive/);
    await userEvent.keyboard('{ArrowDown}'); // Iter 1 -> skip disabled Iter 2 -> Iter 3
    expect(screen.getByRole('option', { name: 'Iter 3' })).toHaveClass(/optionActive/);
    await userEvent.keyboard('{ArrowDown}'); // at last enabled -> stays
    expect(screen.getByRole('option', { name: 'Iter 3' })).toHaveClass(/optionActive/);
  });

  it('Enter selects the active option and closes', async () => {
    const onChange = vi.fn();
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={onChange} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // open at selected (Recently updated)
    await userEvent.keyboard('{ArrowDown}'); // move to Recently pushed
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('pushed');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes without changing value', async () => {
    const onChange = vi.fn();
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={onChange} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Home/End jump to first/last enabled', async () => {
    render(<Select aria-label="Iter" options={DIS} value={3} onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // open
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('option', { name: 'Iter 1' })).toHaveClass(/optionActive/);
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('option', { name: 'Iter 3' })).toHaveClass(/optionActive/);
  });
});

describe('Select — type-ahead', () => {
  it('jumps to the first option matching the accumulated prefix (case-insensitive)', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // open
    await userEvent.keyboard('la'); // "Largest diff"
    expect(screen.getByRole('option', { name: 'Largest diff' })).toHaveClass(/optionActive/);
  });

  it('cycles among matches when the same character repeats', async () => {
    const opts = [
      { value: 'a', label: 'Apple' },
      { value: 'b', label: 'Apricot' },
      { value: 'c', label: 'Cherry' },
    ];
    render(<Select aria-label="Fruit" options={opts} value="a" onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // open, active = Apple
    await userEvent.keyboard('a'); // next A-match after Apple -> Apricot
    expect(screen.getByRole('option', { name: 'Apricot' })).toHaveClass(/optionActive/);
    await userEvent.keyboard('a'); // cycle back to Apple
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveClass(/optionActive/);
  });

  it('leaves the active option unchanged when nothing matches', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // active = Recently updated
    await userEvent.keyboard('zzz');
    expect(screen.getByRole('option', { name: 'Recently updated' })).toHaveClass(/optionActive/);
  });
});
