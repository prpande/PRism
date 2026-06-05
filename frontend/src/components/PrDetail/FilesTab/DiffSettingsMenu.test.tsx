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
