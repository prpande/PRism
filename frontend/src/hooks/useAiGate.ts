import type { AiCapabilities } from '../api/types';
import { useCapabilities } from './useCapabilities';
import { usePreferences } from './usePreferences';

// PR9b-ai-gating § 3.1 / PR3a. Centralizes the two-factor AI gate that was
// previously duplicated across several AI-gated call sites.
//
// The two factors: `capabilities[key]` (derived locally from `ui.aiMode` — see
// useCapabilities) AND `ui.aiMode !== 'off'`. As of PR2 the backend resolves
// capabilities per-flag/tri-state, but the FE still derives them locally, so today
// both factors move together with the mode. The two-factor shape is forward-compat
// scaffolding for the FE adopting the real per-flag wire — see D112.
export function useAiGate(key: keyof AiCapabilities): boolean {
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  return (capabilities?.[key] ?? false) && (preferences?.ui.aiMode ?? 'off') !== 'off';
}

// Preview-mode predicate for the sample-data treatment (SampleBadge). True only
// in Preview; false in Off and Live. Spec §5/§6.
export function useIsSampleMode(): boolean {
  const { preferences } = usePreferences();
  return preferences?.ui.aiMode === 'preview';
}
