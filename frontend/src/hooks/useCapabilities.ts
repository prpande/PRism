import type { AiCapabilities } from '../api/types';
import { usePreferences } from './usePreferences';

// #221 / PR3a: the FE derives AI capabilities LOCALLY from the shared, reactive
// `ui.aiMode` preference (`aiMode === 'preview' ? AllOn : AllOff`) rather than
// fetching /api/capabilities into per-consumer `useState` — which left every
// consumer holding a stale snapshot until its own mount/window-focus, so changing
// the AI mode did not take effect until reload/refocus/fresh-PR. Deriving from
// `usePreferences()` (#143) makes every `useAiGate` consumer re-render the instant
// the mode changes, in one round-trip (the prefs POST), with no /api/capabilities call.
//
// Backend note: as of PR2 `/api/capabilities` is tri-state and resolves each `ai.*`
// flag per-mode (Off → all false; Preview → all true; Live → true only where a real
// seam is registered AND the provider probe succeeds). The FE does not consume that
// per-flag wire yet — it keeps the local AllOn/AllOff derivation above.
//
// Forward-compat (D112, DEFER-TO-V1.X): when the FE adopts the real per-flag wire,
// restore an independent reactive capabilities source here (the deferred shared-store
// / CapabilitiesContext). `useAiGate`'s two-factor `capabilities[key] && aiMode !== 'off'`
// shape is intentionally left unchanged so that swap is the only follow-up needed.
const ALL_ON: AiCapabilities = {
  summary: true,
  fileFocus: true,
  hunkAnnotations: true,
  preSubmitValidators: true,
  composerAssist: true,
  draftSuggestions: true,
  draftReconciliation: true,
  inboxEnrichment: true,
  inboxRanking: true,
};
const ALL_OFF: AiCapabilities = {
  summary: false,
  fileFocus: false,
  hunkAnnotations: false,
  preSubmitValidators: false,
  composerAssist: false,
  draftSuggestions: false,
  draftReconciliation: false,
  inboxEnrichment: false,
  inboxRanking: false,
};

// Stable no-op: capabilities are derived from the shared preferences store, which
// owns refetching (mount + window focus). Retained for the { capabilities, error,
// refetch } return shape useAiGate consumes; no current caller invokes it.
const noopRefetch = async (): Promise<void> => {};

export function useCapabilities() {
  const { preferences, error } = usePreferences();
  // Guard on `preferences?.ui` (not just `preferences`): until the shared store has
  // loaded a well-formed PreferencesResponse, derive `null` so useAiGate's
  // `capabilities?.[key] ?? false` short-circuits the gate off — same as the
  // pre-#221 loading state.
  const capabilities = preferences?.ui
    ? preferences.ui.aiMode === 'preview'
      ? ALL_ON
      : ALL_OFF
    : null;
  return { capabilities, error, refetch: noopRefetch };
}
