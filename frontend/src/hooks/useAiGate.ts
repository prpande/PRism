import type { AiCapabilities } from '../api/types';
import { useCapabilities } from './useCapabilities';
import { usePreferences } from './usePreferences';

// PR9b-ai-gating § 3.1. Centralizes the `capabilities[key] && aiPreview`
// expression that was previously duplicated across 4 sites (and missing
// the capability check on AskAiButton). 9 consumers after this PR ships.
//
// Today the two factors are coupled on the wire — CapabilitiesEndpoints.cs:13
// returns AllOn xor AllOff from AiPreviewState.IsOn, and PreferencesEndpoints
// mirrors aiPreview into that state. So `useAiGate(key)` returns the same
// value as `aiPreview` regardless of key. The two-factor shape is forward-
// compat scaffolding for backend capability decoupling — see D112.
export function useAiGate(key: keyof AiCapabilities): boolean {
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  return (capabilities?.[key] ?? false) && (preferences?.ui.aiPreview ?? false);
}
