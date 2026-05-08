import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WordDiffOverlay } from '../src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay';

describe('WordDiffOverlay', () => {
  it('highlights inserted words', () => {
    const { container } = render(
      <WordDiffOverlay oldText="hello world" newText="hello beautiful world" type="insert" />,
    );
    const inserts = container.querySelectorAll('.word-diff-insert');
    expect(inserts.length).toBeGreaterThan(0);
    const insertText = Array.from(inserts)
      .map((el) => el.textContent)
      .join('');
    expect(insertText).toContain('beautiful ');
  });

  it('highlights deleted words', () => {
    const { container } = render(
      <WordDiffOverlay oldText="hello beautiful world" newText="hello world" type="delete" />,
    );
    const deletes = container.querySelectorAll('.word-diff-delete');
    expect(deletes.length).toBeGreaterThan(0);
    const deleteText = Array.from(deletes)
      .map((el) => el.textContent)
      .join('');
    expect(deleteText).toContain('beautiful ');
  });

  it('renders unchanged text without markers', () => {
    const { container } = render(
      <WordDiffOverlay oldText="same text" newText="same text" type="insert" />,
    );
    expect(container.querySelectorAll('.word-diff-insert').length).toBe(0);
    expect(container.querySelectorAll('.word-diff-delete').length).toBe(0);
    expect(container.textContent).toBe('same text');
  });

  it('handles complete line replacement', () => {
    const { container } = render(
      <WordDiffOverlay oldText="function foo() {" newText="function bar() {" type="insert" />,
    );
    const inserts = container.querySelectorAll('.word-diff-insert');
    expect(inserts.length).toBeGreaterThan(0);
    expect(container.textContent).toContain('bar()');
  });

  it('handles empty old text (entire line is new)', () => {
    const { container } = render(
      <WordDiffOverlay oldText="" newText="brand new line" type="insert" />,
    );
    const inserts = container.querySelectorAll('.word-diff-insert');
    expect(inserts.length).toBeGreaterThan(0);
    expect(container.textContent).toBe('brand new line');
  });

  it('handles empty new text (entire line deleted)', () => {
    const { container } = render(
      <WordDiffOverlay oldText="deleted line" newText="" type="delete" />,
    );
    const deletes = container.querySelectorAll('.word-diff-delete');
    expect(deletes.length).toBeGreaterThan(0);
    expect(container.textContent).toBe('deleted line');
  });
});
