// DiffSettingsMenu.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffSettingsMenu } from './DiffSettingsMenu';

function setup(overrides = {}) {
  const props = {
    showFullFile: false,
    onShowFullFileChange: vi.fn(),
    fullFileViewBlocked: false,
    fullFileViewBlockedReason: null,
    fullFileInertHere: false,
    fullFileInertReason: null,
    lineWrap: false,
    onLineWrapChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DiffSettingsMenu {...props} />) };
}

describe('DiffSettingsMenu — disclosure shell', () => {
  it('is closed initially with aria-expanded=false', () => {
    const { getByTestId, queryByTestId } = setup();
    expect(getByTestId('diff-settings-trigger').getAttribute('aria-expanded')).toBe('false');
    expect(queryByTestId('diff-settings-panel')).toBeNull();
  });

  it('opens on click and closes on a second click, returning focus to the gear', async () => {
    const { getByTestId, queryByTestId } = setup();
    const trigger = getByTestId('diff-settings-trigger');
    await userEvent.click(trigger);
    expect(getByTestId('diff-settings-panel')).toBeInTheDocument();
    await userEvent.click(trigger);
    expect(queryByTestId('diff-settings-panel')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape and returns focus to the gear', async () => {
    const { getByTestId, queryByTestId } = setup();
    const trigger = getByTestId('diff-settings-trigger');
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(queryByTestId('diff-settings-panel')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on outside click and returns focus to the gear', async () => {
    const { getByTestId, queryByTestId } = setup();
    const trigger = getByTestId('diff-settings-trigger');
    await userEvent.click(trigger);
    await userEvent.click(document.body);
    expect(queryByTestId('diff-settings-panel')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('marks the gear modified when a setting is non-default', () => {
    const { getByTestId } = setup({ lineWrap: true });
    const trigger = getByTestId('diff-settings-trigger');
    expect(trigger.getAttribute('aria-label')).toMatch(/modified/i);
  });
});

describe('DiffSettingsMenu — panel content', () => {
  it('reflects and toggles Show full file and Wrap long lines with stable labels', async () => {
    const { props, getByTestId } = setup({ showFullFile: true, lineWrap: false });
    await userEvent.click(getByTestId('diff-settings-trigger'));
    const full = getByTestId('show-full-file-checkbox') as HTMLInputElement;
    const wrap = getByTestId('line-wrap-checkbox') as HTMLInputElement;
    expect(full.checked).toBe(true);
    expect(wrap.checked).toBe(false);
    await userEvent.click(wrap);
    expect(props.onLineWrapChange).toHaveBeenCalledWith(true);
    await userEvent.click(full);
    expect(props.onShowFullFileChange).toHaveBeenCalledWith(false);
    expect(getByTestId('diff-settings-panel').textContent).toContain('Show full file');
    expect(getByTestId('diff-settings-panel').textContent).toContain('Wrap long lines');
  });

  it('disables Show full file with a view-blocked reason wired via aria-describedby', async () => {
    const { getByTestId } = setup({
      fullFileViewBlocked: true,
      fullFileViewBlockedReason: "Whole-file view available only on the 'all' iteration view",
    });
    await userEvent.click(getByTestId('diff-settings-trigger'));
    const full = getByTestId('show-full-file-checkbox') as HTMLInputElement;
    const helper = getByTestId('show-full-file-helper');
    expect(full.disabled).toBe(true);
    expect(full.getAttribute('aria-describedby')).toBe(helper.id);
    expect(helper.textContent).toMatch(/all.*iteration/i);
  });

  it('keeps Show full file enabled but shows a mandatory inert note for an ineligible current file', async () => {
    const { getByTestId } = setup({
      showFullFile: true,
      fullFileInertHere: true,
      fullFileInertReason: 'Not available for this file — still on for other files',
    });
    await userEvent.click(getByTestId('diff-settings-trigger'));
    const full = getByTestId('show-full-file-checkbox') as HTMLInputElement;
    const helper = getByTestId('show-full-file-helper');
    expect(full.disabled).toBe(false);
    expect(full.checked).toBe(true);
    expect(full.getAttribute('aria-describedby')).toBe(helper.id);
    expect(helper.textContent).toMatch(/still on for other files/i);
  });

  it('closes on Escape pressed from a focused checkbox (not just from the trigger)', async () => {
    const { getByTestId, queryByTestId } = setup();
    const trigger = getByTestId('diff-settings-trigger');
    await userEvent.click(trigger);
    const wrap = getByTestId('line-wrap-checkbox');
    wrap.focus();
    expect(wrap).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(queryByTestId('diff-settings-panel')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
