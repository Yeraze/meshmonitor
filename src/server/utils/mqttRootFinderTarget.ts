/**
 * Turn a root-finder request body into a vetted sample target (#6287).
 *
 * Everything that decides WHO may sample WHERE lives here, apart from the
 * sampler (which must stay free of source managers and databases):
 *
 *   - permission per context, the same one that would let the user SAVE the
 *     root: sources:write (bridge), configuration:write on the source (device,
 *     remote device), admin (preset);
 *   - the broker address, vetted with the SSRF guard;
 *   - the login: typed, or a preset's (endpoint-bound), or a bridge's stored
 *     one (endpoint-bound). A stored secret never reaches another host;
 *   - the user's location, read on the server (never from the browser).
 */

import databaseService from '../../services/database.js';
import { hasPermission } from '../auth/authMiddleware.js';
import { assertSafeHost, SsrfBlockedError } from './ssrfGuard.js';
import { mergeSourceConfigOnSave } from './sourceConfigRedaction.js';
import { fillBridgeConfigFromPreset, fillDeviceMqttFromPreset } from '../services/mqttBrokerPresetFill.js';
import {
  MESHTASTIC_DEFAULT_SERVER,
  defaultMqttPort,
  normalizeBrokerUrl,
  splitDeviceAddress,
} from '../../utils/mqttBrokerEndpoint.js';
import { rootDepth, validateMqttRoot } from '../../utils/mqttRootTopic.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { getPrimaryMeshtasticManager, isMeshtasticManager } from '../sourceManagerTypes.js';
import type { LatLon } from '../services/mqttRootFinder/ladder.js';
import type { User } from '../../types/auth.js';

export type RootFinderContext = 'bridge' | 'device' | 'remote_device' | 'preset';
const CONTEXTS: RootFinderContext[] = ['bridge', 'device', 'remote_device', 'preset'];

export interface TargetError {
  status: number;
  code: string;
  message: string;
}

export interface ResolvedTarget {
  broker: { url: string; username?: string; password?: string };
  /** `host:port:tls`, lower case. */
  endpointKey: string;
  regionRoot: string;
  userPos?: LatLon;
}

const ALLOWED_PROTOCOLS = new Set(['mqtt:', 'mqtts:', 'ws:', 'wss:']);

const err = (status: number, code: string, message: string): { error: TargetError } => ({
  error: { status, code, message },
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const blank = (v: unknown) => v === undefined || v === null || v === '';

/** Region root: valid, 2 or 3 segments. */
export function parseRegionRoot(raw: unknown): { root: string } | { error: TargetError } {
  const root = typeof raw === 'string' ? raw.trim() : '';
  if (!root || !validateMqttRoot(root).ok) {
    return err(400, 'INVALID_ROOT', 'That topic root is not valid.');
  }
  const depth = rootDepth(root);
  if (depth < 2 || depth > 3) {
    return err(400, 'INVALID_ROOT', 'Search under a root with two or three parts, such as msh/US.');
  }
  return { root };
}

interface ParsedBroker {
  url: string;
  host: string;
  endpointKey: string;
}

/** Build the connection URL and endpoint from the body's `broker` block. */
function parseBroker(raw: unknown): { broker: ParsedBroker } | { error: TargetError } {
  const bad = () => err(400, 'INVALID_BROKER', 'That broker address is not valid.');
  if (!isObj(raw)) return bad();

  if (typeof raw.url === 'string') {
    let parsed: URL;
    try {
      parsed = new URL(normalizeBrokerUrl(raw.url));
    } catch {
      return bad();
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return bad();
    const tls = parsed.protocol === 'mqtts:' || parsed.protocol === 'wss:';
    const isWs = parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    const port = parsed.port ? Number(parsed.port) : isWs ? (tls ? 443 : 80) : defaultMqttPort(tls);
    // Credentials in the URL are dropped: the login rides in its own fields.
    const url = `${parsed.protocol}//${parsed.host}${isWs ? parsed.pathname : ''}`;
    const host = parsed.hostname.toLowerCase();
    return { broker: { url, host, endpointKey: `${host}:${port}:${tls}` } };
  }

  if (typeof raw.address === 'string' || raw.address === undefined) {
    const tls = raw.tlsEnabled === true;
    const { host: h, port: p } = splitDeviceAddress(raw.address ?? '');
    const host = h === '' ? MESHTASTIC_DEFAULT_SERVER : h;
    if (!/^[a-z0-9._:[\]-]+$/i.test(host) || Number.isNaN(p)) return bad();
    const port = p ?? defaultMqttPort(tls);
    if (port < 1 || port > 65535) return bad();
    const url = `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`;
    return { broker: { url, host, endpointKey: `${host}:${port}:${tls}` } };
  }
  return bad();
}

async function mayStart(
  user: User,
  context: RootFinderContext,
  sourceId: string | undefined,
): Promise<boolean> {
  if (!user || user.username === 'anonymous') return false;
  switch (context) {
    case 'preset':
      return user.isAdmin === true;
    case 'bridge':
      return hasPermission(user, 'sources', 'write', sourceId);
    case 'device':
    case 'remote_device':
      // Always against a named source: an omitted id must not pass on a grant
      // for ANY source.
      return !!sourceId && hasPermission(user, 'configuration', 'write', sourceId);
  }
}

async function bridgeSource(sourceId: string) {
  const row = await databaseService.sources.getSource(sourceId).catch(() => null);
  return row && row.type === 'mqtt_bridge' ? row : null;
}

/** Position of one node on one source: the override if set, else the last fix. */
async function nodePosition(sourceId: string, nodeNum: number): Promise<LatLon | undefined> {
  try {
    const node = await databaseService.nodes.getNode(nodeNum, sourceId);
    if (!node) return undefined;
    const useOverride =
      node.positionOverrideEnabled &&
      typeof node.latitudeOverride === 'number' &&
      typeof node.longitudeOverride === 'number';
    const lat = useOverride ? node.latitudeOverride : node.latitude;
    const lon = useOverride ? node.longitudeOverride : node.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') return undefined;
    if (lat === 0 && lon === 0) return undefined;
    return { lat, lon };
  } catch {
    return undefined;
  }
}

function geoCenter(config: unknown): LatLon | undefined {
  const geo = isObj(config) && isObj(config.downlinkFilters) ? config.downlinkFilters.geo : undefined;
  if (!isObj(geo)) return undefined;
  const { minLat, maxLat, minLng, maxLng } = geo as Record<string, unknown>;
  if (![minLat, maxLat, minLng, maxLng].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return undefined;
  }
  return {
    lat: ((minLat as number) + (maxLat as number)) / 2,
    lon: ((minLng as number) + (maxLng as number)) / 2,
  };
}

export async function resolveSampleTarget(
  user: User,
  body: unknown,
): Promise<{ target: ResolvedTarget } | { error: TargetError }> {
  if (!isObj(body)) return err(400, 'BAD_REQUEST', 'Invalid request body.');
  const context = body.context as RootFinderContext;
  if (!CONTEXTS.includes(context)) return err(400, 'BAD_REQUEST', 'Unknown context.');

  const region = parseRegionRoot(body.regionRoot);
  if ('error' in region) return region;

  let sourceId = blank(body.sourceId) ? undefined : str(body.sourceId);
  if (!blank(body.sourceId) && sourceId === undefined) return err(400, 'BAD_REQUEST', 'Invalid sourceId.');
  if ((context === 'device' || context === 'remote_device') && sourceId === undefined) {
    sourceId = getPrimaryMeshtasticManager(sourceManagerRegistry)?.sourceId;
    if (!sourceId) return err(400, 'MISSING_SOURCE_ID', 'sourceId is required.');
  }
  if (context === 'preset' || context === 'bridge') {
    // A preset has no source. A bridge may be new (no sourceId yet).
    if (context === 'preset') sourceId = undefined;
  }

  if (!(await mayStart(user, context, sourceId))) {
    return err(403, 'FORBIDDEN', 'You may not search topics here.');
  }

  const parsed = parseBroker(body.broker);
  if ('error' in parsed) return parsed;
  const { broker } = parsed;

  try {
    await assertSafeHost(broker.host, { strict: false, allowLoopback: user.isAdmin === true });
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      return err(400, 'ROOT_FINDER_TARGET_BLOCKED', 'That broker address is not allowed.');
    }
    return err(400, 'ROOT_FINDER_TARGET_BLOCKED', 'That broker address could not be checked.');
  }

  // --- login -------------------------------------------------------------
  let username = blank(body.username) ? undefined : str(body.username);
  let password = blank(body.password) ? undefined : str(body.password);
  const rawBroker = body.broker as Record<string, unknown>;

  if (!blank(body.brokerPresetId) && (context === 'bridge' || context === 'device' || context === 'remote_device')) {
    if (context === 'bridge') {
      const cfg: Record<string, unknown> = {
        upstream: {
          url: str(rawBroker.url) ?? '',
          username: username ?? '',
          password: password ?? '',
          brokerPresetId: body.brokerPresetId,
        },
      };
      const e = await fillBridgeConfigFromPreset(cfg);
      if (e) return err(e.status, e.code, e.message);
      const up = cfg.upstream as Record<string, unknown>;
      username = blank(up.username) ? undefined : (up.username as string);
      password = blank(up.password) ? undefined : (up.password as string);
    } else {
      const cfg: Record<string, unknown> = {
        address: str(rawBroker.address) ?? '',
        tlsEnabled: rawBroker.tlsEnabled === true,
        username: username ?? '',
        password: password ?? '',
        brokerPresetId: body.brokerPresetId,
      };
      const e = await fillDeviceMqttFromPreset(cfg);
      if (e) return err(e.status, e.code, e.message);
      username = blank(cfg.username) ? undefined : (cfg.username as string);
      password = blank(cfg.password) ? undefined : (cfg.password as string);
    }
  }

  // --- location + stored bridge login -------------------------------------
  let userPos: LatLon | undefined;

  if (context === 'bridge' && sourceId) {
    const row = await bridgeSource(sourceId);
    if (!row) return err(404, 'SOURCE_NOT_FOUND', 'Source not found.');
    const stored = isObj(row.config) ? row.config : {};
    userPos = geoCenter(stored);

    if (password === undefined) {
      // Reuse the endpoint-binding rule of the save path: a stored secret is
      // kept only while the URL still reaches the endpoint it was stored for.
      // Applied to admins too, so a sample can never aim a stored login at
      // another host.
      const merged = mergeSourceConfigOnSave(
        'mqtt_bridge',
        stored,
        { upstream: { url: str(rawBroker.url) ?? '', password: '' } },
        'editor',
      );
      const up = isObj(merged.upstream) ? merged.upstream : {};
      if (!blank(up.password)) {
        password = up.password as string;
        const storedUp = isObj(stored.upstream) ? stored.upstream : {};
        if (username === undefined && !blank(storedUp.username)) username = storedUp.username as string;
      }
    }
  } else if (context === 'device') {
    const mgr = sourceId ? sourceManagerRegistry.getManager(sourceId) : undefined;
    const local = mgr && isMeshtasticManager(mgr) ? mgr.getLocalNodeInfo() : null;
    if (sourceId && local) userPos = await nodePosition(sourceId, local.nodeNum);
  } else if (context === 'remote_device' && sourceId) {
    const n = Number(body.nodeNum);
    if (Number.isInteger(n) && n > 0) userPos = await nodePosition(sourceId, n);
  }

  return {
    target: {
      broker: {
        url: broker.url,
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
      },
      endpointKey: broker.endpointKey,
      regionRoot: region.root,
      ...(userPos ? { userPos } : {}),
    },
  };
}
