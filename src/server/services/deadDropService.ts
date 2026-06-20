/**
 * Dead Drop / Mailbox service — the command brain.
 *
 * Parses and executes the mailbox commands a node DMs to the radio and returns
 * the lines to send back (the auto-responder handles chunking + delivery):
 *
 *   msg <name> <text>     Store a message for <name>
 *   inbox                 Pending count + sender names
 *   inbox play            Release up to MAX_PLAY_BATCH oldest messages
 *   inbox play <name>     Release messages from one sender only
 *   inbox delete <id>     Delete a specific message by its 4-char code
 *   inbox clear           Delete all already-played messages
 *
 * Messages are addressed to a *name* as typed by the sender. Retrieval matches
 * that name against any identity form (short name, long name, node id, node num)
 * of the DM sender — the retriever proves identity via the DM sender context.
 *
 * All state is per-source (each radio keeps its own mailbox). The repository and
 * a recipient-identity resolver are injected so the service is unit-testable.
 */
import { randomBytes } from 'crypto';
import { DeadDropRepository } from '../../db/repositories/deadDrop.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

export interface DeadDropContext {
  sourceId: string;
  /** Raw message text as received. */
  text: string;
  /** True only for direct messages — mailbox commands are DM-only. */
  isDirect: boolean;
  senderNodeNum: number;
  senderShortName: string;
  senderLongName: string;
}

/**
 * Result of handling a mailbox command.
 *
 * `playOnDelivery` ties `inbox play` messages to the *successful delivery* of
 * their body line — the caller marks a message played only when that line is
 * confirmed delivered, so a dropped body DM leaves the message pending instead
 * of silently lost. `index` is the position in `responses` of the body line.
 */
export interface DeadDropResult {
  responses: string[];
  playOnDelivery?: Array<{ index: number; messageId: number }>;
}

/** Resolve a typed recipient name to all identity forms of the matching node. */
export type RecipientResolver = (sourceId: string, name: string) => Promise<string[]>;

// Tuning. Body limit is in BYTES (UTF-8) because emoji/multibyte eat payload;
// 180 leaves headroom under Meshtastic's ~200-byte text limit.
export const MAX_BODY_BYTES = 180;
export const MAX_PLAY_BATCH = 5;
export const MAX_PENDING_PER_RECIPIENT = 20;
export const MAX_PENDING_PER_SENDER = 20;
export const EXPIRY_MS = 7 * 24 * 3600 * 1000;
const SHORT_ID_RETRIES = 25;

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Meshtastic node id form, e.g. 3273359375 -> "!c318d28f". */
export function nodeIdHex(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

function ago(ts: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Identity forms a stored recipient name could match the DM sender by. */
function recipientIdentities(ctx: DeadDropContext): string[] {
  return identityForms(ctx.senderNodeNum, ctx.senderShortName, ctx.senderLongName);
}

/** All normalized identity forms for a node (short/long name, !hex, node num). */
function identityForms(nodeNum: number, shortName: string, longName: string): string[] {
  const forms = [
    norm(shortName),
    norm(longName),
    norm(nodeIdHex(nodeNum)),
    norm(String(nodeNum)),
  ];
  return [...new Set(forms.filter(Boolean))];
}

/** Distinct sender display names in first-seen order. */
function senderNames(msgs: { senderShortName: string; senderLongName: string; senderNodeNum: number }[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const m of msgs) {
    const name = m.senderShortName || m.senderLongName || nodeIdHex(m.senderNodeNum);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export class DeadDropService {
  constructor(
    private getRepo: () => DeadDropRepository,
    /**
     * Resolves a typed recipient name to the matching node's identity forms so
     * the per-recipient cap is counted against the same set retrieval pools by.
     * Defaults to the typed name alone (used in tests / when no node is known).
     */
    private resolveRecipient: RecipientResolver = async (_sourceId, name) => [norm(name)],
  ) {}

  private get repo(): DeadDropRepository {
    return this.getRepo();
  }

  /** Parse + execute one mailbox command. Returns the lines to send back. */
  async handleCommand(ctx: DeadDropContext, now: number = Date.now()): Promise<DeadDropResult> {
    // DM-only. Return a true no-op for channel messages so a misconfigured
    // trigger never DMs an unsolicited rejection back to the poster.
    if (!ctx.isDirect) {
      return { responses: [] };
    }

    const text = ctx.text.trim();
    const lower = text.toLowerCase();

    // msg <recipient> <body>
    const msgMatch = text.match(/^msg\s+(\S+)\s+([\s\S]+)$/i);
    if (msgMatch) {
      return this.cmdMsg(ctx, msgMatch[1], msgMatch[2].trim(), now);
    }
    if (/^msg(\s+\S+)?\s*$/i.test(text)) {
      return { responses: ['Usage: msg <name> <message>'] };
    }

    if (lower.startsWith('inbox play ')) {
      return this.cmdInboxPlay(ctx, text.slice('inbox play '.length).trim(), now);
    }
    if (lower === 'inbox play') {
      return this.cmdInboxPlay(ctx, null, now);
    }
    if (lower.startsWith('inbox delete ')) {
      return this.cmdInboxDelete(ctx, text.slice('inbox delete '.length).trim(), now);
    }
    if (lower === 'inbox clear') {
      return this.cmdInboxClear(ctx, now);
    }
    if (lower === 'inbox') {
      return this.cmdInbox(ctx, now);
    }

    return { responses: ['Commands: msg <name> <text> | inbox | inbox play | inbox delete <id> | inbox clear'] };
  }

  /**
   * Mark one message played — called by the auto-responder from the delivery
   * success callback of that message's body line, not at enqueue time.
   */
  async markDelivered(sourceId: string, messageId: number, ts: number = Date.now()): Promise<void> {
    await this.repo.markPlayed(sourceId, [messageId], ts);
  }

  private async generateShortId(sourceId: string): Promise<string> {
    for (let i = 0; i < SHORT_ID_RETRIES; i++) {
      const candidate = randomBytes(2).toString('hex').toUpperCase(); // 4 hex chars
      if (!(await this.repo.shortIdExists(sourceId, candidate))) {
        return candidate;
      }
    }
    // Extremely unlikely; widen to 6 chars as a fallback.
    return randomBytes(3).toString('hex').toUpperCase();
  }

  private async cmdMsg(ctx: DeadDropContext, recipientRaw: string, body: string, now: number): Promise<DeadDropResult> {
    const recipient = norm(recipientRaw);
    if (!recipient) return { responses: ['Usage: msg <name> <message>'] };
    if (!body) return { responses: ['Usage: msg <name> <message>'] };

    if (byteLen(body) > MAX_BODY_BYTES) {
      return { responses: [`Message too long (${byteLen(body)} bytes). Limit ${MAX_BODY_BYTES}.`] };
    }

    const cutoff = now - EXPIRY_MS;

    // Count the per-recipient cap against the same identity set retrieval pools
    // by — otherwise a sender could address one node by several name forms and
    // get an independent counter for each, blowing past the cap.
    const recipientForms = await this.resolveRecipient(ctx.sourceId, recipient);
    const recipientPending = await this.repo.countPendingForRecipient(ctx.sourceId, recipientForms, cutoff);
    if (recipientPending >= MAX_PENDING_PER_RECIPIENT) {
      return { responses: [`${recipientRaw}'s inbox is full (${MAX_PENDING_PER_RECIPIENT} pending). Not stored.`] };
    }

    const senderPending = await this.repo.countPendingFromSender(ctx.sourceId, ctx.senderNodeNum, cutoff);
    if (senderPending >= MAX_PENDING_PER_SENDER) {
      return { responses: ['You have too many pending messages out. Wait for some to be picked up.'] };
    }

    const shortId = await this.generateShortId(ctx.sourceId);
    await this.repo.insertMessage({
      sourceId: ctx.sourceId,
      shortId,
      recipientName: recipient,
      senderNodeNum: ctx.senderNodeNum,
      senderShortName: ctx.senderShortName || '',
      senderLongName: ctx.senderLongName || '',
      body,
    }, now);

    return { responses: [`Stored for ${recipientRaw} (id ${shortId}). Tell them to DM 'inbox'.`] };
  }

  private async cmdInbox(ctx: DeadDropContext, now: number): Promise<DeadDropResult> {
    const cutoff = now - EXPIRY_MS;
    const pending = await this.repo.getPendingForRecipient(ctx.sourceId, recipientIdentities(ctx), cutoff);
    if (pending.length === 0) return { responses: ['No pending messages.'] };

    const names = senderNames(pending);
    const oldest = ago(pending[0].createdAt, now);
    const mc = pending.length;
    const sc = names.length;
    const playHint = sc === 1 ? `inbox play ${names[0]}` : 'inbox play';

    return {
      responses: [
        `${mc} msg${mc !== 1 ? 's' : ''} from ${sc} node${sc !== 1 ? 's' : ''} (${names.join(', ')}). ` +
        `Oldest: ${oldest}. Reply '${playHint}'.`,
      ],
    };
  }

  private async cmdInboxPlay(ctx: DeadDropContext, senderFilter: string | null, now: number): Promise<DeadDropResult> {
    const cutoff = now - EXPIRY_MS;
    let pending = await this.repo.getPendingForRecipient(ctx.sourceId, recipientIdentities(ctx), cutoff);

    if (senderFilter) {
      const sf = norm(senderFilter);
      // Match against every identity form of the sender, so the `inbox play
      // <name>` hint (which may be a !hex/node-num) actually filters.
      pending = pending.filter(m =>
        identityForms(m.senderNodeNum, m.senderShortName, m.senderLongName).includes(sf));
      if (pending.length === 0) return { responses: [`No pending messages from ${senderFilter}.`] };
    } else if (pending.length === 0) {
      return { responses: ['No pending messages.'] };
    }

    const total = pending.length;
    const batch = pending.slice(0, MAX_PLAY_BATCH);
    const remaining = total - batch.length;

    const responses: string[] = [];
    const playOnDelivery: Array<{ index: number; messageId: number }> = [];
    batch.forEach((m, i) => {
      const sender = m.senderShortName || m.senderLongName || nodeIdHex(m.senderNodeNum);
      responses.push(`MSG ${i + 1}/${total} from ${sender}, ${ago(m.createdAt, now)}, id ${m.shortId}`);
      responses.push(m.body);
      // Mark played only once the body line is confirmed delivered.
      if (m.id != null) playOnDelivery.push({ index: responses.length - 1, messageId: m.id });
    });

    if (remaining > 0) {
      responses.push(`${batch.length} delivered. ${remaining} more — reply 'inbox play'. Or 'inbox clear' to delete played.`);
    } else {
      responses.push(`All ${batch.length} delivered. Reply 'inbox clear' to delete.`);
    }
    return { responses, playOnDelivery };
  }

  private async cmdInboxDelete(ctx: DeadDropContext, idRaw: string, now: number): Promise<DeadDropResult> {
    const shortId = idRaw.trim().toUpperCase();
    if (!shortId) return { responses: ['Usage: inbox delete <id>'] };

    const row = await this.repo.getByShortId(ctx.sourceId, shortId);
    // Same response whether the id doesn't exist or belongs to another node, so
    // the 4-hex-char id space can't be brute-forced to enumerate stored ids.
    if (!row || !recipientIdentities(ctx).includes(norm(row.recipientName))) {
      return { responses: [`Message ${shortId} not found.`] };
    }

    if (row.id != null) await this.repo.softDelete(ctx.sourceId, [row.id], now);
    return { responses: [`Message ${shortId} deleted.`] };
  }

  private async cmdInboxClear(ctx: DeadDropContext, now: number): Promise<DeadDropResult> {
    const cutoff = now - EXPIRY_MS;
    const played = await this.repo.getPlayedForRecipient(ctx.sourceId, recipientIdentities(ctx), cutoff);
    if (played.length === 0) return { responses: ['No played messages to clear.'] };

    const ids = played.map(m => m.id).filter((id): id is number => id != null);
    await this.repo.softDelete(ctx.sourceId, ids, now);

    const n = played.length;
    return { responses: [`Cleared ${n} played message${n !== 1 ? 's' : ''}.`] };
  }
}

/**
 * Default recipient resolver for the singleton: looks up the node matching the
 * typed name within the source and returns all of its identity forms, so the
 * per-recipient cap counts every form. Falls back to the typed name alone when
 * the node isn't known to this source yet.
 */
async function defaultRecipientResolver(sourceId: string, name: string): Promise<string[]> {
  const typed = norm(name);
  try {
    const nodes = await databaseService.nodes.getAllNodes(sourceId);
    const match = nodes.find(n =>
      norm(n.shortName) === typed ||
      norm(n.longName) === typed ||
      norm(n.nodeId) === typed ||
      norm(String(n.nodeNum)) === typed);
    if (match) {
      const forms = identityForms(Number(match.nodeNum), match.shortName || '', match.longName || '');
      return forms.length ? forms : [typed];
    }
  } catch (err) {
    logger.warn('Dead Drop recipient resolve failed, using typed name only:', err);
  }
  return [typed];
}

/** Process-wide singleton; resolves the repo + node data lazily after DB init. */
export const deadDropService = new DeadDropService(
  () => databaseService.deadDrop,
  defaultRecipientResolver,
);
