import { describe, it, expect } from 'vitest';
import {
  buildTree,
  type FileTreeNode,
  type DirectoryTreeNode,
} from '../src/components/PrDetail/FilesTab/treeBuilder';
import type { FileChange } from '../src/api/types';

function file(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return {
    path,
    status: 'modified',
    hunks: [],
    ...overrides,
  };
}

describe('buildTree', () => {
  it('returns empty array on empty input', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('renders a single root-level file as a single FileTreeNode', () => {
    const tree = buildTree([file('README.md')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe('file');
    expect((tree[0] as FileTreeNode).name).toBe('README.md');
    expect((tree[0] as FileTreeNode).path).toBe('README.md');
  });

  it('compacts a deep single-child chain into one DirectoryTreeNode', () => {
    const tree = buildTree([file('src/Foo/Bar/Baz.cs', { status: 'added' })]);
    expect(tree).toHaveLength(1);
    const dir = tree[0] as DirectoryTreeNode;
    expect(dir.kind).toBe('directory');
    expect(dir.name).toBe('src/Foo/Bar');
    expect(dir.children).toHaveLength(1);
    expect(dir.children[0].kind).toBe('file');
    expect((dir.children[0] as FileTreeNode).name).toBe('Baz.cs');
  });

  it('does not compact when siblings exist at a directory level', () => {
    const tree = buildTree([file('src/a.ts'), file('src/b.ts')]);
    expect(tree).toHaveLength(1);
    const dir = tree[0] as DirectoryTreeNode;
    expect(dir.kind).toBe('directory');
    expect(dir.name).toBe('src');
    expect(dir.children).toHaveLength(2);
  });

  it('compacts partial chains but stops at branching points', () => {
    const tree = buildTree([file('a/b/c/x.ts'), file('a/b/c/y.ts')]);
    expect(tree).toHaveLength(1);
    const dir = tree[0] as DirectoryTreeNode;
    expect(dir.kind).toBe('directory');
    expect(dir.name).toBe('a/b/c');
    expect(dir.children).toHaveLength(2);
  });

  it('handles mixed depth files correctly', () => {
    const tree = buildTree([file('root.ts'), file('src/app.ts')]);
    expect(tree).toHaveLength(2);
    const rootFile = tree.find((n) => n.kind === 'file') as FileTreeNode;
    expect(rootFile.name).toBe('root.ts');
    const srcDir = tree.find((n) => n.kind === 'directory') as DirectoryTreeNode;
    expect(srcDir.name).toBe('src');
    expect(srcDir.children).toHaveLength(1);
  });

  it('sorts directories before files, alphabetically within each group', () => {
    const tree = buildTree([file('z.ts'), file('a.ts'), file('src/b.ts'), file('lib/c.ts')]);
    expect(tree).toHaveLength(4);
    expect(tree[0].kind).toBe('directory');
    expect((tree[0] as DirectoryTreeNode).name).toBe('lib');
    expect(tree[1].kind).toBe('directory');
    expect((tree[1] as DirectoryTreeNode).name).toBe('src');
    expect(tree[2].kind).toBe('file');
    expect((tree[2] as FileTreeNode).name).toBe('a.ts');
    expect(tree[3].kind).toBe('file');
    expect((tree[3] as FileTreeNode).name).toBe('z.ts');
  });

  it('preserves FileChange data on FileTreeNode', () => {
    const tree = buildTree([file('src/main.ts', { status: 'deleted' })]);
    const dir = tree[0] as DirectoryTreeNode;
    const f = dir.children[0] as FileTreeNode;
    expect(f.file.status).toBe('deleted');
    expect(f.file.path).toBe('src/main.ts');
  });

  it('handles deeply nested single-file with multiple compaction', () => {
    const tree = buildTree([file('a/b/c/d/e/f.ts')]);
    expect(tree).toHaveLength(1);
    const dir = tree[0] as DirectoryTreeNode;
    expect(dir.kind).toBe('directory');
    expect(dir.name).toBe('a/b/c/d/e');
    expect(dir.children).toHaveLength(1);
    expect((dir.children[0] as FileTreeNode).name).toBe('f.ts');
  });
});
