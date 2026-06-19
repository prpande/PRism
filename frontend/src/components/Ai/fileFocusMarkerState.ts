import type { FileFocusStatus } from '../../api/types';

/**
 * Reduce a `useFileFocusResult` status to an AiMarker working/idle state for a
 * region-level cue (spec §3). `loading` → working; resolved-with-output
 * (`ok`/`empty`/`fallback`) → the persistent idle "AI analyzed this" glyph;
 * `error`/`no-changes`/`not-subscribed` → no marker (null).
 *
 * Second caller of this exact mapping is the Hotspots tab (via PrDetailView),
 * so per spec §1's YAGNI threshold ("extract when a second caller appears")
 * this is shared rather than inlined twice. This is the focus-ONLY mapping; the
 * file-tree header additionally OR-folds its hunk-annotation pass into `working`
 * at the call site (it spans two AI passes).
 */
export function fileFocusStatusToMarkerState(status: FileFocusStatus): 'idle' | 'working' | null {
  if (status === 'loading') return 'working';
  if (status === 'ok' || status === 'empty' || status === 'fallback') return 'idle';
  return null; // 'error' | 'no-changes' | 'not-subscribed'
}
