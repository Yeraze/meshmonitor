/**
 * Text markers for `{{ trigger.replyContext }}` (#4697).
 *
 * A Meshtastic tapback/reply reads as an ordinary standalone message once
 * relayed to a protocol with no reply/thread concept of its own — the MT→MC
 * bridge template (`src/components/automations/templates/bridge.ts`), since
 * MeshCore's send API has no reply-id field to preserve real threading.
 * These are the best available signal short of true threading: a short
 * prefix marking the relayed text as a reaction/reply rather than fresh chat.
 *
 * Shared (not inlined in `triggerContext.ts`) so the Substitutions help
 * drawer can reference the exact same glyphs instead of hardcoding its own
 * copy — see `HOP_COUNT_EMOJIS` in `hopEmoji.ts` for the same pattern.
 */
export const REPLY_CONTEXT_TAPBACK = '↩️ reacted: ';
export const REPLY_CONTEXT_REPLY = '↩️ reply: ';
