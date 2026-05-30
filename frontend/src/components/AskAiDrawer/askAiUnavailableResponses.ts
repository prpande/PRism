/**
 * Canned strings shown when AI is unavailable.
 *
 * Used today by PR8's AskAiDrawer as the canned-reply pool (no AI backend exists yet).
 * Reusable downstream by any AI-integration code path that needs an "AI is unavailable"
 * fallback (timeout / unset API key / user disabled in Settings). The phrasing is honest
 * in BOTH states without rewording.
 */
export const AI_UNAVAILABLE_RESPONSES: readonly string[] = [
  "AI isn't available right now. When it is, it would summarize the diff per file and highlight risky areas.",
  "AI isn't available right now. When it is, it would surface tests that exercise the changed lines.",
  "AI isn't available right now. When it is, it would explain how a specific function got refactored.",
  "AI isn't available right now. When it is, it would compare the head SHA to the base and call out behavior changes.",
  "AI isn't available right now. When it is, it would flag drafts whose anchor lines moved in the latest iteration.",
] as const;

export function pickAiUnavailableResponse(cycleIndex: number): string {
  const len = AI_UNAVAILABLE_RESPONSES.length;
  const i = ((cycleIndex % len) + len) % len;
  return AI_UNAVAILABLE_RESPONSES[i];
}
