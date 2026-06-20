// frontend/src/components/Ai/AiFailureContainer.tsx
import { useEffect, useRef } from 'react';
import { useAiFailure } from './aiFailure';
import { AiFailureToast } from './AiFailureToast';

export function AiFailureContainer() {
  const { activeFailedSeams, retrying, dismissed, anyTimedOut, retryAll, dismiss } = useAiFailure();
  const visible = activeFailedSeams.length > 0 && !dismissed;
  const wasVisible = useRef(false);

  // WCAG 2.4.3: if the toast's focused button is destroyed on hide (focus fell to body),
  // move focus to the PR main region. Do NOT steal focus when the user is elsewhere.
  useEffect(() => {
    if (wasVisible.current && !visible) {
      const focusLost = document.activeElement == null || document.activeElement === document.body;
      if (focusLost) {
        // Confirm this selector against PrDetailView's DOM during impl; falls back to <main>.
        const target =
          document.querySelector<HTMLElement>('[data-pr-main]:not([hidden])') ??
          document.querySelector<HTMLElement>('main');
        target?.focus();
      }
    }
    wasVisible.current = visible;
  }, [visible]);

  return (
    <>
      {/* Always-mounted polite live region — empty until a failure, so the ''→text change
          announces on appearance (and the text→'' change marks disappearance). The mutable
          seam list is NOT in here, so partial recovery does not re-announce. */}
      <span className="sr-only" aria-live="polite" data-testid="ai-failure-live">
        {visible ? 'AI generation failed.' : ''}
      </span>
      {visible && (
        <AiFailureToast
          seams={activeFailedSeams}
          retrying={retrying}
          anyTimedOut={anyTimedOut}
          onRetry={retryAll}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}
