/**
 * MeshCore contact-name hygiene.
 *
 * The companion serial protocol frames every message as `>` + u16 length +
 * payload with NO checksum. When a USB-serial link drops bytes mid-stream
 * (common during a large `get_contacts` dump), meshcore.js re-syncs on the
 * next `>` byte and happily parses a shifted or spliced frame as a contact
 * record. The fixed-width 32-byte name field then holds pieces of a public
 * key, an out_path, or the next frame's header, and the result renders as
 * binary junk in the node list.
 *
 * Two layers use these helpers:
 *  - Ingest: `isCorruptMeshCoreContactRecord()` rejects records that cannot
 *    have come from real firmware, so they never reach `meshcore_nodes` or
 *    overwrite a good name.
 *  - Store/read: `sanitizeMeshCoreName()` scrubs whatever is left (and rows
 *    written before the ingest guard existed) down to printable text.
 */

// C0 controls, DEL, and C1 controls. Firmware names are user-typed text and
// never contain these; a NUL here means the 32-byte field was not trimmed.
const HAS_CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;
const REPLACEMENT_CHAR = '\ufffd';
const TRAILING_REPLACEMENT = /\ufffd+$/;

/** Highest MeshCore ADV_TYPE value (NONE=0, CHAT=1, REPEATER=2, ROOM=3, SENSOR=4). */
const MAX_ADV_TYPE = 4;

/**
 * Reduce a MeshCore name to printable text: cut at the first NUL (an
 * untrimmed fixed-width field), turn tab/CR/LF into spaces, drop a trailing
 * run of U+FFFD (a multi-byte character the sender truncated at its name
 * limit, e.g. a clipped emoji), and trim whitespace.
 *
 * A name that still holds any other control character or an undecodable
 * byte came from a corrupt frame, not from a person, so the whole name is
 * discarded rather than showing the printable crumbs of it.
 *
 * Returns `null` when nothing usable remains, so callers fall back to the
 * public-key prefix instead of showing an empty or garbage label.
 */
export function sanitizeMeshCoreName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const nul = raw.indexOf('\u0000');
  let name = nul === -1 ? raw : raw.slice(0, nul);
  name = name.replace(/[\t\r\n]/g, ' ').replace(TRAILING_REPLACEMENT, '').trim();
  if (name.length === 0) return null;
  if (HAS_CONTROL_CHAR.test(name) || name.includes(REPLACEMENT_CHAR)) return null;
  return name;
}

/**
 * True when a decoded name holds bytes real firmware would never send:
 * control characters (including NUL past the terminator), an undecodable
 * byte anywhere but the tail, or nothing but undecodable bytes.
 */
export function isGarbageMeshCoreName(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  if (HAS_CONTROL_CHAR.test(raw)) return true;
  const withoutTail = raw.replace(TRAILING_REPLACEMENT, '');
  if (withoutTail.length === 0) return true;
  return withoutTail.includes(REPLACEMENT_CHAR);
}

/**
 * Decide whether a decoded contact record (from a `get_contacts` Contact
 * frame or a NewAdvert push) is a corrupted frame rather than a real
 * contact. Returns a short reason for logging, or `null` if it looks sound.
 */
export function isCorruptMeshCoreContactRecord(record: {
  adv_name?: unknown;
  name?: unknown;
  adv_type?: unknown;
}): string | null {
  const advType = record.adv_type;
  if (typeof advType === 'number' && (!Number.isInteger(advType) || advType < 0 || advType > MAX_ADV_TYPE)) {
    return `adv_type ${advType} out of range`;
  }
  const name = typeof record.adv_name === 'string' ? record.adv_name
    : typeof record.name === 'string' ? record.name : undefined;
  if (isGarbageMeshCoreName(name)) {
    return 'name is not text';
  }
  return null;
}
