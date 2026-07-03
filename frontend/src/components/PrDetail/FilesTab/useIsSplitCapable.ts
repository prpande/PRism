import { useMediaQuery } from '../../../hooks/useMediaQuery';

// Below this viewport width the side-by-side diff collapses to unified.
// Keep in sync with tokens.css `@media (max-width: 899px)`; #146 edits here.
export const SPLIT_DIFF_MIN_WIDTH = 900; // px

// True when the viewport is wide enough for the side-by-side (split) diff.
export function useIsSplitCapable(): boolean {
  return useMediaQuery(`(min-width: ${SPLIT_DIFF_MIN_WIDTH}px)`);
}
