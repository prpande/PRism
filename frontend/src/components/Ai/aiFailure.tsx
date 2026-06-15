// frontend/src/components/Ai/aiFailure.tsx
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { PrReference, AiFailureReason } from '../../api/types';
import { prRefKey } from '../../api/types';
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';
import { parsePrRoute } from '../PrDetail/PrTabHost';

export type AiSeam = 'summary' | 'file-focus' | 'hunk-annotations' | 'draft-suggestions';

interface FailureEntry {
  retry: () => void;
  // #496: why the seam failed; drives the timeout-aware toast. Optional so older callers/tests compile.
  reason?: AiFailureReason;
}
type FailureMap = Record<string, Partial<Record<AiSeam, FailureEntry>>>;

export interface AiFailureApi {
  report: (prRef: PrReference, seam: AiSeam, opts: FailureEntry) => void;
  clear: (prRef: PrReference, seam: AiSeam) => void;
  clearPr: (prRef: PrReference) => void;
  retryAll: () => void;
  dismiss: () => void;
  // Read-only DERIVED views for the active PR (computed each render — not setters):
  activeFailedSeams: AiSeam[]; // failed seams for the active PR, in stable SEAM_ORDER
  retrying: boolean; // a Retry-all is in flight for the active PR
  dismissed: boolean; // user dismissed the current failure-set fingerprint
}

const NOOP: AiFailureApi = {
  report: () => {},
  clear: () => {},
  clearPr: () => {},
  retryAll: () => {},
  dismiss: () => {},
  activeFailedSeams: [],
  retrying: false,
  dismissed: false,
};

// Exported as a test seam (mirrors OpenTabsContext) so a unit test can inject a stub value with
// spy methods. App code consumes via useAiFailure(), not this directly.
export const AiFailureContext = createContext<AiFailureApi>(NOOP);

const SEAM_ORDER: AiSeam[] = ['summary', 'file-focus', 'hunk-annotations', 'draft-suggestions'];

export function AiFailureProvider({ children }: { children: ReactNode }) {
  const [failures, setFailures] = useState<FailureMap>({});
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);
  // Refs read OUTSIDE setState updaters so the updaters stay pure (StrictMode double-invokes them).
  const pendingRef = useRef<Set<AiSeam>>(new Set());
  const retryingKeyRef = useRef<string | null>(null);
  retryingKeyRef.current = retryingKey;
  // Mirrors `failures` so `clear` can read the latest snapshot without closing over the state
  // variable — keeping `clear`'s deps at [settle] (stable) and avoiding stale-closure bugs where
  // effects capture an old `clear` that closed over an outdated `failures` snapshot.
  const failuresRef = useRef<FailureMap>(failures);
  failuresRef.current = failures;

  const { pathname } = useEffectiveLocation();
  const activeKey = useMemo(() => {
    const route = parsePrRoute(pathname);
    return route && route.valid ? prRefKey(route.ref) : null;
  }, [pathname]);

  // Pure: compute decision from refs BEFORE setState; updater only returns the next value.
  const settle = useCallback((key: string, seam: AiSeam) => {
    if (retryingKeyRef.current !== key || !pendingRef.current.has(seam)) return;
    pendingRef.current.delete(seam);
    const empty = pendingRef.current.size === 0;
    setRetryingKey((cur) => (cur === key && empty ? null : cur));
  }, []);

  const report = useCallback(
    (prRef: PrReference, seam: AiSeam, opts: FailureEntry) => {
      const key = prRefKey(prRef);
      setFailures((prev) => ({ ...prev, [key]: { ...prev[key], [seam]: opts } }));
      settle(key, seam);
    },
    [settle],
  );

  const clear = useCallback(
    (prRef: PrReference, seam: AiSeam) => {
      const key = prRefKey(prRef);
      // Read the latest snapshot from the ref (not closed-over state) so this callback is stable
      // across failure mutations. Effects that capture `clear` once (on mount) always call the
      // current version of the recovery logic rather than one that closed over a stale snapshot.
      const forPr = failuresRef.current[key];
      const willEmpty = !!forPr && seam in forPr && Object.keys(forPr).length === 1;
      setFailures((prev) => {
        const cur = prev[key];
        if (!cur || !(seam in cur)) return prev;
        const next = { ...cur };
        delete next[seam];
        const out = { ...prev };
        if (Object.keys(next).length === 0) delete out[key];
        else out[key] = next;
        return out;
      });
      // Real recovery for this PR: reset any dismissal so a later identical failure re-shows.
      if (willEmpty) setDismissedFingerprint((d) => (d && d.startsWith(`${key}:`) ? null : d));
      settle(key, seam);
    },
    [settle],
  );

  const clearPr = useCallback((prRef: PrReference) => {
    const key = prRefKey(prRef);
    setFailures((prev) => {
      if (!(key in prev)) return prev;
      const out = { ...prev };
      delete out[key];
      return out;
    });
    setRetryingKey((cur) => (cur === key ? null : cur));
    setDismissedFingerprint((d) => (d && d.startsWith(`${key}:`) ? null : d));
  }, []);

  const activeFailedSeams = useMemo<AiSeam[]>(() => {
    if (!activeKey) return [];
    const forPr = failures[activeKey];
    return forPr ? SEAM_ORDER.filter((s) => s in forPr) : [];
  }, [activeKey, failures]);

  const fingerprint = activeKey ? `${activeKey}:${activeFailedSeams.join(',')}` : '';
  const dismissed = dismissedFingerprint !== null && dismissedFingerprint === fingerprint;

  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;

  const retryAll = useCallback(() => {
    if (!activeKey) return;
    const forPr = failuresRef.current[activeKey];
    if (!forPr) return;
    const seams = SEAM_ORDER.filter((s) => s in forPr);
    if (seams.length === 0) return;
    pendingRef.current = new Set(seams);
    setRetryingKey(activeKey);
    setDismissedFingerprint(null); // a retry un-dismisses
    seams.forEach((s) => forPr[s]?.retry());
  }, [activeKey]);

  const dismiss = useCallback(() => setDismissedFingerprint(fingerprintRef.current), []);

  const value = useMemo<AiFailureApi>(
    () => ({
      report,
      clear,
      clearPr,
      retryAll,
      dismiss,
      activeFailedSeams,
      retrying: retryingKey !== null && retryingKey === activeKey,
      dismissed,
    }),
    [
      report,
      clear,
      clearPr,
      retryAll,
      dismiss,
      activeFailedSeams,
      retryingKey,
      activeKey,
      dismissed,
    ],
  );

  return <AiFailureContext.Provider value={value}>{children}</AiFailureContext.Provider>;
}

export function useAiFailure(): AiFailureApi {
  return useContext(AiFailureContext);
}
