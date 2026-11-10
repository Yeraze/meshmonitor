/**
 * Shared request handling for the optional `senderName` on a MeshCore channel
 * send (#6282), used by the internal send route and by `POST /api/v1/messages`.
 * One place decides, so both routes refuse the same way.
 */
import { checkSenderName, readSenderNamePolicy } from './meshcoreSenderNamePolicy.js';
import { normalizeSenderName } from './meshcoreSenderName.js';

export type SenderNameDecision =
  /** No override: take today's send path, unchanged. */
  | { kind: 'none' }
  /** Allowed: send raw under `name`. */
  | { kind: 'override'; name: string }
  | { kind: 'reject'; status: number; code: string; message: string; denied: boolean };

/**
 * `raw` is the body value as received. Absent or null means "no override".
 * A name equal (after trim, case-sensitive) to the local node name is also no
 * override: the normal path already sends under that name.
 */
export async function decideSenderName(opts: {
  sourceId: string;
  raw: unknown;
  isDm: boolean;
  hasChannel: boolean;
  localNodeName: string | null | undefined;
}): Promise<SenderNameDecision> {
  const { raw } = opts;
  if (raw === undefined || raw === null) return { kind: 'none' };
  if (typeof raw !== 'string') {
    return { kind: 'reject', status: 400, code: 'INVALID_INPUT', message: 'senderName must be a string', denied: false };
  }
  if (opts.isDm) {
    return { kind: 'reject', status: 400, code: 'INVALID_INPUT', message: 'senderName applies to channel messages only', denied: false };
  }
  if (!opts.hasChannel) {
    return { kind: 'reject', status: 400, code: 'INVALID_INPUT', message: 'senderName needs an explicit channel', denied: false };
  }
  const local = opts.localNodeName ? normalizeSenderName(opts.localNodeName) : null;
  if (local && normalizeSenderName(raw) === local) return { kind: 'none' };

  const policy = await readSenderNamePolicy(opts.sourceId);
  const check = checkSenderName(policy, raw);
  if (check.ok) return { kind: 'override', name: check.name };
  const status = check.code === 'INVALID_INPUT' ? 400 : 403;
  return { kind: 'reject', status, code: check.code, message: check.message, denied: status === 403 };
}
