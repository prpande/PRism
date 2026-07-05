import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ICONS, MoreIcon } from './formattingIcons';
import type { FormatAction } from './markdownFormatting';

const ACTIONS: FormatAction[] = [
  'bold',
  'italic',
  'strikethrough',
  'code',
  'link',
  'heading',
  'quote',
  'bulleted',
  'numbered',
  'task',
];

describe('formattingIcons', () => {
  it.each(ACTIONS)('renders an aria-hidden svg for %s', (action) => {
    const Icon = ICONS[action];
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(svg!.getAttribute('focusable')).toBe('false');
  });

  it('renders the More (kebab) icon', () => {
    const { container } = render(<MoreIcon />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
