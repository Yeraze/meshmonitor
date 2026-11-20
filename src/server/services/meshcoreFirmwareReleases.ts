/**
 * MeshCore firmware releases (#4943, Phase 1: read-only).
 *
 * MeshCore publishes one GitHub release line per firmware role
 * (`companion-v1.18.0`, `repeater-v1.18.0`, `room-server-v1.18.0`), each with
 * hundreds of per-board files. Phase 1 only needs the newest version per role,
 * so only tag, version, prerelease, date and page URL are kept.
 *
 * Fetched on the same schedule as the Meshtastic list (the firmware service's
 * 6-hour poll and its "check now"), with its own ETag and cache: a failure here
 * never touches the Meshtastic releases.
 */
import { logger } from '../../utils/logger.js';
import { compareFirmwareVersions } from '../../utils/firmwareVersion.js';
import type { FirmwareChannel } from './firmwareUpdateService.js';

const MESHCORE_RELEASES_URL = 'https://api.github.com/repos/meshcore-dev/MeshCore/releases?per_page=30';

export type MeshCoreFirmwareRole = 'companion' | 'repeater' | 'room-server';

export interface MeshCoreRelease {
  role: MeshCoreFirmwareRole;
  tagName: string;
  version: string;
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
}

const TAG_RE = /^(companion|repeater|room-server)-v(\d[\w.-]*)$/;

/** A GitHub release as MeshCore tags it, or null for any other tag. */
export function parseMeshCoreRelease(raw: {
  tag_name?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  html_url?: unknown;
}): MeshCoreRelease | null {
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : '';
  const m = TAG_RE.exec(tag);
  if (!m) return null;
  return {
    role: m[1] as MeshCoreFirmwareRole,
    tagName: tag,
    version: m[2],
    prerelease: raw.prerelease === true,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
  };
}

/**
 * Newest release for `role` on `channel`. MeshCore has stable and prerelease
 * builds only: alpha and nightly include prereleases; every other channel
 * (stable, and the Meshtastic-only custom/local) means stable.
 */
export function latestMeshCoreRelease(
  releases: MeshCoreRelease[],
  role: MeshCoreFirmwareRole,
  channel: FirmwareChannel,
): MeshCoreRelease | null {
  const withPre = channel === 'alpha' || channel === 'nightly';
  let best: MeshCoreRelease | null = null;
  for (const r of releases) {
    if (r.role !== role || (r.prerelease && !withPre)) continue;
    if (!best || (compareFirmwareVersions(r.version, best.version) ?? 0) > 0) best = r;
  }
  return best;
}

class MeshCoreFirmwareReleases {
  private cached: MeshCoreRelease[] = [];
  private etag: string | null = null;
  private lastFetchTime: number | null = null;

  /** Refresh from GitHub. On any error the previous cache stays in use. */
  async fetchReleases(): Promise<MeshCoreRelease[]> {
    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'MeshMonitor',
      };
      if (this.etag) headers['If-None-Match'] = this.etag;
      const response = await fetch(MESHCORE_RELEASES_URL, { headers });
      if (response.status === 304) return this.cached;
      if (!response.ok) {
        logger.warn(`[MeshCoreFirmwareReleases] GitHub API returned ${response.status}`);
        return this.cached;
      }
      const etag = response.headers.get('etag');
      if (etag) this.etag = etag;
      const raw: unknown = await response.json();
      this.cached = Array.isArray(raw)
        ? raw.map((r) => parseMeshCoreRelease(r ?? {})).filter((r): r is MeshCoreRelease => r !== null)
        : [];
      this.lastFetchTime = Date.now();
      logger.debug(`[MeshCoreFirmwareReleases] Fetched ${this.cached.length} MeshCore releases`);
      return this.cached;
    } catch (error) {
      logger.error('[MeshCoreFirmwareReleases] Error fetching releases:', error);
      return this.cached;
    }
  }

  getCached(): MeshCoreRelease[] {
    return this.cached;
  }

  getLastFetchTime(): number | null {
    return this.lastFetchTime;
  }
}

export const meshcoreFirmwareReleases = new MeshCoreFirmwareReleases();
