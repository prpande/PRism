import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { ToolbarOverflowMenu } from './ToolbarOverflowMenu';

describe('ToolbarOverflowMenu', () => {
  it('renders a collapsed menu-button and expands on click', () => {
    const { getByRole, queryByRole } = render(
      <ToolbarOverflowMenu items={['task', 'strikethrough']} runAction={() => {}} />,
    );
    const trigger = getByRole('button', { name: /More formatting/i });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(getByRole('menu')).toBeTruthy();
  });

  it('focuses the first item on open and navigates with ArrowDown', () => {
    const { getByRole } = render(
      <ToolbarOverflowMenu items={['task', 'strikethrough']} runAction={() => {}} />,
    );
    fireEvent.click(getByRole('button', { name: /More formatting/i }));
    const menu = getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
  });

  it('runs the action and closes when a menuitem is chosen', () => {
    const runAction = vi.fn();
    const { getByRole, queryByRole } = render(
      <ToolbarOverflowMenu items={['task', 'strikethrough']} runAction={runAction} />,
    );
    fireEvent.click(getByRole('button', { name: /More formatting/i }));
    fireEvent.click(within(getByRole('menu')).getAllByRole('menuitem')[0]);
    expect(runAction).toHaveBeenCalledWith('task');
    expect(queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const { getByRole, queryByRole } = render(
      <ToolbarOverflowMenu items={['task']} runAction={() => {}} />,
    );
    const trigger = getByRole('button', { name: /More formatting/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(getByRole('menu'), { key: 'Escape' });
    expect(queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('disables the trigger and cannot open when disabled (matches the greyed strip)', () => {
    const { getByRole, queryByRole } = render(
      <ToolbarOverflowMenu items={['task']} runAction={() => {}} disabled />,
    );
    const trigger = getByRole('button', { name: /More formatting/i }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(queryByRole('menu')).toBeNull();
  });
});
