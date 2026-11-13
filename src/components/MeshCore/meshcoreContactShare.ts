/**
 * Which contacts can be shared as a contact-share token, and the token for
 * this source's own node (#6370). Pure helpers so the picker, the composer
 * menu and tests share one rule.
 */
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import {
  formatMeshCoreContactToken,
  isMeshCoreContactTokenType,
  type MeshCoreContactTokenType,
} from '../../utils/meshcoreContactToken';

export interface ShareableContact {
  publicKey: string;
  name: string;
  type: MeshCoreContactTokenType;
  token: string;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Display name the token would carry: advert name, else the stored name. */
function contactName(c: MeshCoreContact): string {
  return (c.advName || c.name || '').trim();
}

/**
 * Contacts a token can describe: Companion / Repeater / Room, a full 64-hex
 * key and a non-blank name. The source's own node is left out (it has its
 * own menu entry). Sorted by name, then key.
 */
export function listShareableContacts(
  contacts: readonly MeshCoreContact[],
  selfPublicKey?: string | null,
): ShareableContact[] {
  const self = (selfPublicKey ?? '').toLowerCase();
  const seen = new Set<string>();
  const out: ShareableContact[] = [];
  for (const c of contacts) {
    if (!c.publicKey || !HEX64.test(c.publicKey)) continue;
    const key = c.publicKey.toLowerCase();
    if (key === self || seen.has(key)) continue;
    if (!isMeshCoreContactTokenType(c.advType)) continue;
    const name = contactName(c);
    const token = formatMeshCoreContactToken({ publicKey: key, type: c.advType, name });
    if (!token) continue;
    seen.add(key);
    out.push({ publicKey: key, name, type: c.advType, token });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.publicKey.localeCompare(b.publicKey));
}

/** Case-insensitive match on name or public-key prefix. */
export function filterShareableContacts(list: readonly ShareableContact[], query: string): ShareableContact[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((c) => c.name.toLowerCase().includes(q) || c.publicKey.startsWith(q));
}

/**
 * Token for this source's own node: always type 1 (Companion), since only a
 * Companion source sends channel messages and DMs. Null without a 64-hex key
 * (a Repeater source reports the placeholder 'repeater') or a name.
 */
export function selfContactToken(localNode: { publicKey?: string | null; name?: string | null } | null | undefined): string | null {
  if (!localNode?.publicKey || !HEX64.test(localNode.publicKey)) return null;
  return formatMeshCoreContactToken({ publicKey: localNode.publicKey, type: 1, name: localNode.name ?? '' });
}
