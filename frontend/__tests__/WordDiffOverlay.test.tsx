import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WordDiffOverlay } from '../src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay';

describe('WordDiffOverlay', () => {
  it('highlights inserted words', () => {
    render(<WordDiffOverlay oldText="hello world" newText="hello beautiful world" type="insert" />);
    const overlay = screen.getByTestId('word-diff-overlay');
    const inserts = overlay.querySelectorAll('.word-diff-insert');
    expect(inserts.length).toBeGreaterThan(0);
    const insertText = Array.from(inserts)
      .map((el) => el.textContent)
      .join('');
    expect(insertText).toContain('beautiful ');
  });

  it('highlights deleted words', () => {
    render(<WordDiffOverlay oldText="hello beautiful world" newText="hello world" type="delete" />);
    const overlay = screen.getByTestId('word-diff-overlay');
    const deletes = overlay.querySelectorAll('.word-diff-delete');
    expect(deletes.length).toBeGreaterThan(0);
    const deleteText = Array.from(deletes)
      .map((el) => el.textContent)
      .join('');
    expect(deleteText).toContain('beautiful ');
  });

  it('renders unchanged text without markers', () => {
    render(<WordDiffOverlay oldText="same text" newText="same text" type="insert" />);
    const overlay = screen.getByTestId('word-diff-overlay');
    expect(overlay.querySelectorAll('.word-diff-insert').length).toBe(0);
    expect(overlay.querySelectorAll('.word-diff-delete').length).toBe(0);
    expect(overlay.textContent).toBe('same text');
  });

  it('handles complete line replacement', () => {
    render(
      <WordDiffOverlay oldText="function foo() {" newText="function bar() {" type="insert" />,
    );
    const overlay = screen.getByTestId('word-diff-overlay');
    const inserts = overlay.querySelectorAll('.word-diff-insert');
    expect(inserts.length).toBeGreaterThan(0);
    expect(overlay.textContent).toContain('bar()');
  });

  it('handles empty old text (entire line is new)', () => {
    render(<WordDiffOverlay oldText="" newText="brand new line" type="insert" />);
    const overlay = screen.getByTestId('word-diff-overlay');
    const inserts = overlay.querySelectorAll('.word-diff-insert');
    expect(inserts.length).toBeGreaterThan(0);
    expect(overlay.textContent).toBe('brand new line');
  });

  it('handles empty new text (entire line deleted)', () => {
    render(<WordDiffOverlay oldText="deleted line" newText="" type="delete" />);
    const overlay = screen.getByTestId('word-diff-overlay');
    const deletes = overlay.querySelectorAll('.word-diff-delete');
    expect(deletes.length).toBeGreaterThan(0);
    expect(overlay.textContent).toBe('deleted line');
  });
});
