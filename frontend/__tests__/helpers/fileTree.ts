// Shared FileTree prop builder. #327 (Task 9) — FilesTab builds the tree once
// and passes it down, so FileTree takes the built tree alongside `files`.
// Derive both props from the real builder so test fixtures can never drift
// from production tree construction.
import { buildTree } from '../../src/components/PrDetail/FilesTab/treeBuilder';
import type { FileChange } from '../../src/api/types';

export function treeProps(files: FileChange[]) {
  return { files, tree: buildTree(files) };
}
