import type { FileChange } from '../../../api/types';

export interface FileTreeNode {
  kind: 'file';
  name: string;
  path: string;
  file: FileChange;
}

export interface DirectoryTreeNode {
  kind: 'directory';
  name: string;
  children: TreeNode[];
}

export type TreeNode = FileTreeNode | DirectoryTreeNode;

interface IntermediateDir {
  entries: { name: string; file: FileChange }[];
  subdirs: Map<string, IntermediateDir>;
}

function newDir(): IntermediateDir {
  return { entries: [], subdirs: new Map() };
}

export function buildTree(files: FileChange[]): TreeNode[] {
  if (files.length === 0) return [];

  const root = newDir();
  for (const f of files) {
    const parts = f.path.split('/');
    const fileName = parts.pop()!;
    let current = root;
    for (const part of parts) {
      if (!current.subdirs.has(part)) {
        current.subdirs.set(part, newDir());
      }
      current = current.subdirs.get(part)!;
    }
    current.entries.push({ name: fileName, file: f });
  }

  return collapse(root);
}

function collapse(dir: IntermediateDir, prefix = ''): TreeNode[] {
  const result: TreeNode[] = [];

  const dirEntries = Array.from(dir.subdirs.entries()).sort(([a], [b]) => a.localeCompare(b));

  for (const [name, child] of dirEntries) {
    const compactedName = prefix ? `${prefix}/${name}` : name;

    if (child.subdirs.size === 1 && child.entries.length === 0) {
      result.push(...collapse(child, compactedName));
    } else {
      result.push({
        kind: 'directory',
        name: compactedName,
        children: collapse(child),
      });
    }
  }

  const fileNodes: FileTreeNode[] = dir.entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      kind: 'file' as const,
      name: e.name,
      path: e.file.path,
      file: e.file,
    }));

  return [...result, ...fileNodes];
}
