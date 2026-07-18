import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { HighlightedLine } from './HighlightedLine';

describe('HighlightedLine', () => {
  it('renders one .codeLine wrapper with one .codeToken span per span', () => {
    const { container } = render(
      <HighlightedLine
        spans={[
          { text: 'const', style: { '--shiki-light': '#005cc5', '--shiki-dark': '#79b8ff' } },
          { text: ' x', style: {} },
        ]}
        fallback="const x"
      />,
    );
    const line = container.querySelector('.codeLine');
    expect(line).not.toBeNull();
    expect(line!.children.length).toBe(2); // single direct wrapper, N token children
    const tokens = container.querySelectorAll('.codeToken');
    expect(tokens.length).toBe(2);
    expect((tokens[0] as HTMLElement).style.getPropertyValue('--shiki-dark')).toBe('#79b8ff');
    expect(line!.textContent).toBe('const x');
  });

  it('applies background-only change classes on merged spans', () => {
    const { container } = render(
      <HighlightedLine
        spans={[
          { text: 'a', style: {}, change: 'insert' },
          { text: 'b', style: {}, change: 'delete' },
        ]}
        fallback="ab"
      />,
    );
    expect(container.querySelector('.codeToken.wordDiffInsertBg')).not.toBeNull();
    expect(container.querySelector('.codeToken.wordDiffDeleteBg')).not.toBeNull();
  });

  it('renders fallback as a single plain span when spans is empty', () => {
    const { container } = render(<HighlightedLine spans={[]} fallback={'  indented'} />);
    const line = container.querySelector('.codeLine');
    expect(line!.children.length).toBe(1);
    expect(line!.textContent).toBe('  indented'); // whitespace preserved as text
  });
});
