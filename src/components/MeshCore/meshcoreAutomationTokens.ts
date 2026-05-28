/**
 * The token set shared by every MeshCore automation surface that runs
 * text through the server-side `replaceMeshCoreAnnounceTokens` helper:
 * auto-announce, auto-responder responses, and timer-trigger
 * messages/script-args. Keep this in lockstep with
 * `src/server/utils/meshcoreAnnounceTokens.ts` — the server is the
 * source of truth for which placeholders actually expand.
 */
export const MESHCORE_AUTOMATION_TOKENS = [
  '{VERSION}',
  '{DURATION}',
  '{CONTACTCOUNT}',
  '{COMPANIONCOUNT}',
  '{REPEATERCOUNT}',
  '{ROOMCOUNT}',
  '{NODE_NAME}',
  '{NODE_ID}',
] as const;
