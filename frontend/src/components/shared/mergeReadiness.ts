// Frontend-owned presentation for the backend-derived MergeReadiness enum (architecture C).
// The union MUST match the kebab-case wire form emitted by JsonStringEnumConverter.
export type MergeReadiness =
  | 'none'
  | 'merged'
  | 'closed'
  | 'conflicts'
  | 'behind-base'
  | 'changes-requested'
  | 'review-required'
  | 'blocked-by-protection'
  | 'unstable'
  | 'ready-with-changes-requested'
  | 'ready';

// The 8 open states that render a badge (none/merged/closed render nothing — D5).
export function isBadgeRendered(r: MergeReadiness): boolean {
  return r !== 'none' && r !== 'merged' && r !== 'closed';
}

// Compact inbox label.
export const READINESS_SHORT: Record<MergeReadiness, string> = {
  none: '',
  merged: '',
  closed: '',
  conflicts: 'Conflicts',
  'behind-base': 'Behind',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
  'blocked-by-protection': 'Blocked',
  unstable: 'Unstable',
  'ready-with-changes-requested': 'Ready (changes)',
  ready: 'Ready',
};

// Expanded PR-detail reason.
export const READINESS_LONG: Record<MergeReadiness, string> = {
  none: '',
  merged: '',
  closed: '',
  conflicts: 'Has conflicts',
  'behind-base': 'Out of date with base',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
  'blocked-by-protection': 'Blocked by branch protection',
  unstable: 'Checks unstable',
  'ready-with-changes-requested': 'Ready — changes requested',
  ready: 'Ready to merge',
};

// Tooltip one-line explanation (spec §6 table).
export const READINESS_TOOLTIP: Record<MergeReadiness, string> = {
  none: '',
  merged: '',
  closed: '',
  conflicts: 'Resolve merge conflicts to continue.',
  'behind-base': 'Update this branch with its base before merging.',
  'changes-requested': 'A reviewer requested changes.',
  'review-required': 'Waiting on a required approving review.',
  'blocked-by-protection': 'A branch-protection rule is not yet satisfied.',
  unstable: "Required checks haven't all passed yet.",
  'ready-with-changes-requested': 'Mergeable, but a reviewer requested changes.',
  ready: 'This PR can be merged.',
};

// Global chip class (defined in tokens.css, Task 4). Shared by both surfaces.
export const READINESS_CHIP_CLASS: Record<MergeReadiness, string> = {
  none: '',
  merged: '',
  closed: '',
  conflicts: 'chip-readiness-conflicts',
  'behind-base': 'chip-readiness-behind-base',
  'changes-requested': 'chip-readiness-changes-requested',
  'review-required': 'chip-readiness-review-required',
  'blocked-by-protection': 'chip-readiness-blocked-by-protection',
  unstable: 'chip-readiness-unstable',
  'ready-with-changes-requested': 'chip-readiness-ready-with-changes-requested',
  ready: 'chip-readiness-ready',
};
