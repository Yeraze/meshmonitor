/**
 * MeshCore announcement token replacement.
 *
 * Mirrors the Meshtastic auto-announce token expansion so operators
 * familiar with the Meshtastic side can reuse muscle memory. Tokens are
 * resolved against a MeshCoreManager: contact counts come from the
 * manager's in-memory cache, uptime/version come from process state.
 *
 * The set intentionally stays narrow — `{VERSION}`, `{DURATION}`,
 * `{CONTACTCOUNT}`, `{COMPANIONCOUNT}`, `{REPEATERCOUNT}`,
 * `{ROOMCOUNT}`, `{NODE_NAME}`, `{NODE_ID}`. Adding more is cheap, but
 * shapes the contract every consumer (announce, timer-trigger text,
 * future auto-responder text) inherits.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { MeshCoreDeviceType } from '../meshcoreManager.js';
import type { MeshCoreManager } from '../meshcoreManager.js';

let cachedVersion: string | null = null;

async function readPackageVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // utils/ → server/ → src/ → repo root
    const pkgPath = path.resolve(here, '..', '..', '..', 'package.json');
    const raw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    cachedVersion = pkg.version || 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

export interface MeshCoreAnnounceTokenContext {
  /** Process uptime override for deterministic tests. */
  uptimeMs?: number;
  /** Version override for deterministic tests. */
  version?: string;
}

/**
 * Replace `{TOKEN}` placeholders in `template` with values from the
 * supplied manager. Unknown tokens are left untouched (rather than
 * silently dropped) so authoring mistakes are visible to the operator.
 */
export async function replaceMeshCoreAnnounceTokens(
  template: string,
  manager: MeshCoreManager | null,
  ctx: MeshCoreAnnounceTokenContext = {},
): Promise<string> {
  const version = ctx.version ?? (await readPackageVersion());
  const uptimeMs = ctx.uptimeMs ?? process.uptime() * 1000;

  let contactCount = 0;
  let companionCount = 0;
  let repeaterCount = 0;
  let roomCount = 0;
  let nodeName = 'MeshMonitor';
  let nodeId = '';

  if (manager) {
    try {
      const contacts = manager.getContacts();
      contactCount = contacts.length;
      for (const c of contacts) {
        if (c.advType === MeshCoreDeviceType.COMPANION) companionCount += 1;
        else if (c.advType === MeshCoreDeviceType.REPEATER) repeaterCount += 1;
        else if (c.advType === MeshCoreDeviceType.ROOM_SERVER) roomCount += 1;
      }
    } catch {
      // Manager may not be connected yet — leave counts at 0.
    }
    const local = manager.getLocalNode?.();
    if (local) {
      nodeName = local.name || nodeName;
      nodeId = local.publicKey ? local.publicKey.substring(0, 16) : '';
    }
  }

  return template
    .replace(/\{VERSION\}/g, version)
    .replace(/\{DURATION\}/g, formatDuration(uptimeMs))
    .replace(/\{CONTACTCOUNT\}/g, String(contactCount))
    .replace(/\{COMPANIONCOUNT\}/g, String(companionCount))
    .replace(/\{REPEATERCOUNT\}/g, String(repeaterCount))
    .replace(/\{ROOMCOUNT\}/g, String(roomCount))
    .replace(/\{NODE_NAME\}/g, nodeName)
    .replace(/\{NODE_ID\}/g, nodeId);
}
