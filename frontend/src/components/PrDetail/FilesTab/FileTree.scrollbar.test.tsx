// FileTree.test.tsx — structural assertions for the #214 synthetic horizontal
// scrollbar. jsdom does no layout, so the scroll GEOMETRY (overflow detection,
// translateX sync, sticky pinning) is covered by tree-scroll-regression.spec.ts in a
// real browser. These cover the DOM contract the e2e and the hook depend on.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { FileTree } from './FileTree';
import { buildTree } from './treeBuilder';
import type { FileChange } from '../../../api/types';

const file = (path: string): FileChange => ({ path, status: 'modified', hunks: [] });

// #327 (Task 9) — FileTree takes the built tree from FilesTab; build it with the real
// builder so fixtures match production tree construction.
const treeProps = (files: FileChange[]) => ({ files, tree: buildTree(files) });

function renderTree(files: FileChange[]) {
  return render(
    <FileTree
      {...treeProps(files)}
      selectedPath={null}
      onSelectFile={() => {}}
      viewedPaths={new Set()}
      onToggleViewed={() => {}}
      focusEntries={null}
      focusStatus="no-changes"
      aiPreview={false}
    />,
  );
}

describe('FileTree synthetic horizontal scrollbar (#214)', () => {
  it('renders the pinned scrollbar element when the tree has files', () => {
    const { getByTestId } = renderTree([file('src/Calc.cs'), file('src/very/deep/Nested.cs')]);
    expect(getByTestId('file-tree-hscroll')).toBeTruthy();
  });

  it('keeps the scrollbar out of the accessibility tree (aria-hidden, pointer affordance only)', () => {
    const { getByTestId } = renderTree([file('a.cs')]);
    const bar = getByTestId('file-tree-hscroll');
    // The bar lives inside an aria-hidden footer row — matching DiffPane's .diffHScroll.
    expect(bar.closest('[aria-hidden="true"]')).not.toBeNull();
    // And it is not a tab stop.
    expect(bar.getAttribute('tabindex')).toBeNull();
  });

  it('renders the bar inside a three-cell footer (leading rail spacer, bar, right gutter)', () => {
    const { getByTestId } = renderTree([file('a.cs')]);
    const bar = getByTestId('file-tree-hscroll');
    const row = bar.closest('.file-tree-hscroll-row')!;
    // Footer mirrors .fileTreeBody: [comment-rail spacer][bar][ai+check gutter spacer].
    expect(row.children.length).toBe(3);
    expect(row.children[1]).toBe(bar);
  });

  it('keeps the leading rail spacer present so it aligns under the tree column (width gated by CSS)', () => {
    const { getByTestId } = render(
      <FileTree
        {...treeProps([file('a.cs')])}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
        commentStateByPath={new Map([['a.cs', 'unresolved']])}
      />,
    );
    const row = getByTestId('file-tree-hscroll').closest('.file-tree-hscroll-row')!;
    // data-has-comments='1' drives the leading spacer's width via CSS; assert the
    // root flag here (jsdom does no layout, so width itself is covered by e2e).
    expect(getByTestId('file-tree').getAttribute('data-has-comments')).toBe('1');
    expect(row.children.length).toBe(3);
  });

  it('omits the scrollbar entirely on the empty state', () => {
    const { queryByTestId } = renderTree([]);
    expect(queryByTestId('file-tree-hscroll')).toBeNull();
  });
});
