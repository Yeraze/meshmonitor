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
 * of the DM sender — the retriever proves identity via the DM sender context,
 * so there is no fragile store-time node lookup.
 *
 * All state is per-source (each radio keeps its own mailbox). The repository is
 * injected so the service is unit-testable against a real SQLite repo.
 */
import { randomBytes } from 'crypto';
import { DeadDropRepository } from '../../db/repositories/deadDrop.js';
import databaseService from '../../services/database.js';

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
function nodeIdHex(nodeNum: number): string {
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
  const forms = [
    norm(ctx.senderShortName),
    norm(ctx.senderLongName),
    norm(nodeIdHex(ctx.senderNodeNum)),
    norm(String(ctx.senderNodeNum)),
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
  constructor(private getRepo: () => DeadDropRepository) {}

  private get repo(): DeadDropRepository {
    return this.getRepo();
  }

  /** Parse + execute one mailbox command. Returns the lines to send back. */
  async handleCommand(ctx: DeadDropContext, now: number = Date.now()): Promise<string[]> {
    if (!ctx.isDirect) {
      return ['Mailbox commands must be sent by DM.'];
    }

    const text = ctx.text.trim();
    const lower = text.toLowerCase();

    // msg <recipient> <body>
    const msgMatch = text.match(/^msg\s+(\S+)\s+([\s\S]+)$/i);
    if (msgMatch) {
      return this.cmdMsg(ctx, msgMatch[1], msgMatch[2].trim(), now);
    }
    if (/^msg(\s+\S+)?\s*$/i.test(text)) {
      return ['Usage: msg <name> <message>'];
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

    return ['Commands: msg <name> <text> | inbox | inbox play | inbox delete <id> | inbox clear'];
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

  private async cmdMsg(ctx: DeadDropContext, recipientRaw: string, body: string, now: number): Promise<string[]> {
    const recipient = norm(recipientRaw);
    if (!recipient) return ['Usage: msg <name> <message>'];
    if (!body) return ['Usage: msg <name> <message>'];

    if (byteLen(body) > MAX_BODY_BYTES) {
      return [`Message too long (${byteLen(body)} bytes). Limit ${MAX_BODY_BYTES}.`];
    }

    const cutoff = now - EXPIRY_MS;

    const recipientPending = await this.repo.countPendingForRecipient(ctx.sourceId, recipient, cutoff);
    if (recipientPending >= MAX_PENDING_PER_RECIPIENT) {
      return [`${recipientRaw}'s inbox is full (${MAX_PENDING_PER_RECIPIENT} pending). Not stored.`];
    }

    const senderPending = await this.repo.countPendingFromSender(ctx.sourceId, ctx.senderNodeNum, cutoff);
    if (senderPending >= MAX_PENDING_PER_SENDER) {
      return ['You have too many pending messages out. Wait for some to be picked up.'];
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

    return [`Stored for ${recipientRaw} (id ${shortId}). Tell them to DM 'inbox'.`];
  }

  private async cmdInbox(ctx: DeadDropContext, now: number): Promise<string[]> {
    const cutoff = now - EXPIRY_MS;
    const pending = await this.repo.getPendingForRecipient(ctx.sourceId, recipientIdentities(ctx), cutoff);
    if (pending.length === 0) return ['No pending messages.'];

    const names = senderNames(pending);
    const oldest = ago(pending[0].createdAt, now);
    const mc = pending.length;
    const sc = names.length;
    const playHint = sc === 1 ? `inbox play ${names[0]}` : 'inbox play';

    return [
      `${mc} msg${mc !== 1 ? 's' : ''} from ${sc} node${sc !== 1 ? 's' : ''} (${names.join(', ')}). ` +
      `Oldest: ${oldest}. Reply '${playHint}'.`,
    ];
  }

  private async cmdInboxPlay(ctx: DeadDropContext, senderFilter: string | null, now: number): Promise<string[]> {
    const cutoff = now - EXPIRY_MS;
    let pending = await this.repo.getPendingForRecipient(ctx.sourceId, recipientIdentities(ctx), cutoff);

    if (senderFilter) {
      const sf = norm(senderFilter);
      pending = pending.filter(m => norm(m.senderShortName) === sf || norm(m.senderLongName) === sf);
      if (pending.length === 0) return [`No pending messages from ${senderFilter}.`];
    } else if (pending.length === 0) {
      return ['No pending messages.'];
    }

    const total = pending.length;
    const batch = pending.slice(0, MAX_PLAY_BATCH);
    const remaining = total - batch.length;

    const responses: string[] = [];
    const playedIds: number[] = [];
    batch.forEach((m, i) => {
      const sender = m.senderShortName || m.senderLongName || nodeIdHex(m.senderNodeNum);
      responses.push(`MSG ${i + 1}/${total} from ${sender}, ${ago(m.createdAt, now)}, id ${m.shortId}`);
      responses.push(m.body);
      if (m.id != null) playedIds.push(m.id);
    });

    await this.repo.markPlayed(ctx.sourceId, playedIds, now);

    if (remaining > 0) {
      responses.push(`${batch.length} delivered. ${remaining} more — reply 'inbox play'. Or 'inbox clear' to delete played.`);
    } else {
      responses.push(`All ${batch.length} delivered. Reply 'inbox clear' to delete.`);
    }
    return responses;
  }

  private async cmdInboxDelete(ctx: DeadDropContext, idRaw: string, now: number): Promise<string[]> {
    const shortId = idRaw.trim().toUpperCase();
    if (!shortId) return ['Usage: inbox delete <id>'];

    const row = await this.repo.getByShortId(ctx.sourceId, shortId);
    if (!row) return [`Message ${shortId} not found.`];

    if (!recipientIdentities(ctx).includes(norm(row.recipientName))) {
      return ['That message is not addressed to you.'];
    }

    if (row.id != null) await this.repo.softDelete(ctx.sourceId, [row.id], now);
    return [`Message ${shortId} deleted.`];
  }

  private async cmdInboxClear(ctx: DeadDropContext, now: number): Promise<string[]> {
    const cutoff = now - EXPIRY_MS;
    const played = await this.repo.getPlayedForRecipient(ctx.sourceId, recipientIdentities(ctx), cutoff);
    if (played.length === 0) return ['No played messages to clear.'];

    const ids = played.map(m => m.id).filter((id): id is number => id != null);
    await this.repo.softDelete(ctx.sourceId, ids, now);

    const n = played.length;
    return [`Cleared ${n} played message${n !== 1 ? 's' : ''}.`];
  }
}

/** Process-wide singleton; resolves the repo lazily after DB init. */
export const deadDropService = new DeadDropService(() => databaseService.deadDrop);
