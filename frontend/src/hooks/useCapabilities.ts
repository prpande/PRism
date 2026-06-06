import type { AiCapabilities } from '../api/types';
import { usePreferences } from './usePreferences';

// #221: capabilities currently mirror the aiPreview preference on the wire
// (CapabilitiesEndpoints.cs returns AllOn/AllOff from AiPreviewState.IsOn). Rather
// than fetch /api/capabilities into per-consumer `useState` — which left every
// consumer holding a stale snapshot until its own mount/window-focus, so toggling
// AI preview did not take effect until reload/refocus/fresh-PR — derive capabilities
// from the already-shared, reactive `usePreferences()` source (#143). Every
// `useAiGate` consumer then re-renders the instant the toggle updates the single
// shared preferences store, in one round-trip (the prefs POST), with no
// /api/capabilities call.
//
// Forward-compat (D112, DEFER-TO-V1.X): when backend capability decoupling lands and
// `AiCapabilities` stops mirroring `AiPreviewState.IsOn`, restore an independent
// reactive capabilities source here (the deferred shared-store / CapabilitiesContext).
// `useAiGate`'s two-factor `capabilities[key] && aiPreview` shape is intentionally
// left unchanged so that swap is the only follow-up needed.
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
  const capabilities = preferences?.ui ? (preferences.ui.aiPreview ? ALL_ON : ALL_OFF) : null;
  return { capabilities, error, refetch: noopRefetch };
}
