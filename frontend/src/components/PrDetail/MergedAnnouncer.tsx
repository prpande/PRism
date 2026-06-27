import { useEffect, useRef, useState } from 'react';

interface MergedAnnouncerProps {
  isMerged: boolean;
  onMerged: () => void;
}

/**
 * Isolated component that detects a live false→true transition on `isMerged`
 * and (a) queues a polite SR announcement, then (b) calls `onMerged` on the
 * next animation frame so the host can move focus to a stable landmark.
 *
 * Opening an already-merged PR does NOT trigger either effect — only a live
 * state transition does. This keeps the component out of PrActionsPanel (which
 * unmounts on merge) and places it in the persistent PR-detail shell instead.
 */
export function MergedAnnouncer({ isMerged, onMerged }: MergedAnnouncerProps) {
  // Initialise to the CURRENT isMerged so an already-merged PR on mount is
  // silent — we only react to a false→true transition observed during the
  // component's lifetime.
  const wasMergedRef = useRef(isMerged);
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    if (isMerged && !wasMergedRef.current) {
      // (1) Queue the polite live-region text first so assistive tech picks it up.
      setAnnounce('Pull request merged');
      // (2) Move focus on the next frame, after the announcement is queued.
      requestAnimationFrame(() => onMerged());
    }
    wasMergedRef.current = isMerged;
  }, [isMerged, onMerged]);

  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="pr-merged-status">
      {announce}
    </div>
  );
}
