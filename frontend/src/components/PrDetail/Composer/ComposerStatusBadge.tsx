import { badgeLabel, type ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';

export interface ComposerStatusBadgeProps {
  badge: ComposerSaveBadge;
  // Cross-tab take-over flag (§5.7a). When set, this tab is read-only.
  readOnly: boolean;
}

/**
 * The composer's status slot. Normally surfaces the autosave save-state badge.
 *
 * #630: a cross-tab take-over that flips the composer read-only mid-PUT leaves
 * `useComposerAutoSave`'s badge stuck on 'Saving…' (the post-await `disabled`
 * re-check bails before the result block). For a read-only tab the save-state
 * value is meaningless ('saving' misleads, 'unsaved' implies the user can save,
 * 'saved' is a lie since the PUT result was suppressed), so we supersede it with
 * a neutral read-only indicator. The autosave hook is intentionally left
 * untouched — see docs/specs/2026-06-26-644-630-composer-post-lock-readonly-badge-design.md.
 *
 * `role="status"` (polite) is intentional; "Read-only" is the full screen-reader
 * announcement, and the `title` is a mouse-hover enhancement only.
 */
export function ComposerStatusBadge({ badge, readOnly }: ComposerStatusBadgeProps) {
  if (readOnly) {
    return (
      <span
        className="composer-badge composer-badge--readonly"
        role="status"
        data-testid="composer-badge"
        title="Another tab is editing this PR."
      >
        Read-only
      </span>
    );
  }
  return (
    <span
      className={`composer-badge composer-badge--${badge}`}
      role="status"
      data-testid="composer-badge"
    >
      {badgeLabel(badge)}
    </span>
  );
}
