export interface MeshCoreNeighborEntry {
  pubkeyPrefix: string;
  lastHeardSecondsAgo: number;
  snr: number;
}

/**
 * Parse the text output of the MeshCore CLI `neighbors` command.
 *
 * Format per line: `{8-char-hex-pubkey}:{seconds_ago}:{snr*4}`
 * Returns null when the device reports "not supported" (room servers).
 */
export function parseMeshcoreNeighborsResponse(
  reply: string,
): MeshCoreNeighborEntry[] | null {
  const trimmed = reply.trim();
  if (!trimmed) return [];
  if (/not supported/i.test(trimmed)) return null;
  if (trimmed === '-none-') return [];

  const entries: MeshCoreNeighborEntry[] = [];
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const parts = line.split(':');
    if (parts.length < 3) continue;

    const pubkeyPrefix = parts[0].toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(pubkeyPrefix)) continue;

    const secs = parseInt(parts[1], 10);
    const snrRaw = parseInt(parts[2], 10);
    if (Number.isNaN(secs) || Number.isNaN(snrRaw)) continue;

    entries.push({
      pubkeyPrefix,
      lastHeardSecondsAgo: secs,
      snr: snrRaw / 4,
    });
  }
  return entries;
}
