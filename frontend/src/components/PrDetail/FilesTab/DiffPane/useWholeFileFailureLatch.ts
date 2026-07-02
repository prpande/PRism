import { useEffect, useRef, useState } from 'react';

export interface WholeFileFailureLatch {
  failure: string | null; // latched failureReason, null = no banner
  dismiss: () => void; // clears the latch only
  retry: (() => void) | undefined; // defined iff onWholeFileRetry was provided
}

// Failure latch: fires onWholeFileFailed once per transition to 'failed'.
export function useWholeFileFailureLatch({
  fetchStatus,
  failureReason,
  selectedPath,
  onWholeFileFailed,
  onWholeFileRetry,
}: {
  fetchStatus: 'idle' | 'loading' | 'ok' | 'failed';
  failureReason: string | null | undefined;
  selectedPath: string | null;
  onWholeFileFailed?: (reason: string) => void;
  onWholeFileRetry?: () => void;
}): WholeFileFailureLatch {
  const [localFailure, setLocalFailure] = useState<string | null>(null);
  const prevStatus = useRef<typeof fetchStatus>('idle');

  useEffect(() => {
    if (prevStatus.current !== 'failed' && fetchStatus === 'failed' && failureReason) {
      setLocalFailure(failureReason);
      onWholeFileFailed?.(failureReason);
    }
    prevStatus.current = fetchStatus;
  }, [fetchStatus, failureReason, onWholeFileFailed]);

  // Clear the latch on file navigation. The banner is scoped to the file
  // that produced the failure; carrying its reason across a file switch
  // shows a misleading banner for the new file (Copilot iter-1 finding).
  // Skip the initial mount — the latch detection effect above can set
  // the latch on the same render that this effect's deps initialize,
  // and React batches both setStates; without the skip, the clear
  // would land last and clobber the latch.
  const isInitialPathMount = useRef(true);
  useEffect(() => {
    if (isInitialPathMount.current) {
      isInitialPathMount.current = false;
      return;
    }
    setLocalFailure(null);
  }, [selectedPath]);

  // Dismiss only clears the latch — the toggle-revert callback already
  // fired on the original failure transition (above). Calling onWholeFileFailed
  // here would re-fire against the CURRENT selectedPath, which may be a
  // different file than the one that produced the failure (Copilot iter-1
  // navigation race).
  const dismiss = () => {
    setLocalFailure(null);
  };

  // #510: in-place retry. Clear the local latch (hides the banner immediately) and
  // ask FilesTab to re-permit whole-file view for this file, which re-fires the
  // fetch (failed results are never cached). A re-failure simply re-latches.
  const retry = onWholeFileRetry
    ? () => {
        setLocalFailure(null);
        onWholeFileRetry();
      }
    : undefined;

  return { failure: localFailure, dismiss, retry };
}
