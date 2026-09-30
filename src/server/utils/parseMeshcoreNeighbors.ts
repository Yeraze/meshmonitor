export interface MeshCoreNeighborEntry {
  pubkeyPrefix: string;
  lastHeardSecondsAgo: number;
  snr: number;
}

/**
 * Parse the text output of the MeshCore CLI `neighbors` command.
 *
 * Format per line: `{8-char-hex-pubkey}:{seconds_ago}:{snr*4}`
 * (firmware `formatNeighborsReply`, `sprintf("%s:%d:%d")`, uppercase hex).
 * Returns null when the device reports "not supported" (room servers).
 *
 * Accepts both the remote CLI reply (bare lines) and the local serial CLI
 * reply, where the firmware prefixes only the FIRST line with `  -> ` (#5500).
 * Lines that don't match the shape (the command echo, stray output) are
 * skipped rather than failing the whole reply.
 */
export function parseMeshcoreNeighborsResponse(
  reply: string,
): MeshCoreNeighborEntry[] | null {
  const trimmed = reply.trim();
  if (!trimmed) return [];
  if (/not supported/i.test(trimmed)) return null;
  const lines = trimmed.split('\n').map((raw) => raw.replace(/^\s*->\s?/, '').trim());
  if (lines.some((l) => l === '-none-')) return [];

  const entries: MeshCoreNeighborEntry[] = [];
  for (const line of lines) {
    // Strict shape: a garbage or merged line is skipped, never half-parsed.
    // `secs_ago` is a uint32 printed with %d, so a device clock that moved
    // backwards can print it negative; callers clamp.
    const m = /^([0-9A-Fa-f]{8}):(-?\d+):(-?\d+)$/.exec(line);
    if (!m) continue;
    const pubkeyPrefix = m[1].toLowerCase();
    const secs = parseInt(m[2], 10);
    const snrRaw = parseInt(m[3], 10);

    entries.push({
      pubkeyPrefix,
      lastHeardSecondsAgo: secs,
      snr: snrRaw / 4,
    });
  }
  return entries;
}
