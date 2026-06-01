/**
 * Shared (de)serialization for mqtt_bridge source `config` blobs.
 *
 * Used by BOTH the source create/edit modal (`DashboardPage.tsx`) and the
 * dedicated bridge Configuration page (`MqttBridgeConfigurationView.tsx`) so
 * the two editors can never drift on how a bridge config is shaped.
 *
 * `buildBridgeConfig` merges over a `base` config (the existing source blob on
 * edit) so an editor that doesn't render every field — e.g. the modal, which
 * has no publish-filter or topic-rewrite inputs — leaves those keys intact
 * instead of clobbering them. Fields are only authoritatively managed when the
 * caller supplies the corresponding form value:
 *  - `uplinkTopicMode` undefined  → preserve `base.uplinkFilters`
 *  - `downlinkRewrite`/`uplinkRewrite` undefined → preserve the rewrite keys
 *
 * Passwords are never echoed back: upstream is rebuilt from the form, and an
 * empty password serializes to `undefined` (dropped by JSON) so the server's
 * `preserveSourceCredentials` round-trips the stored value.
 */

export type BridgeMode = 'bidirectional' | 'publish_only' | 'subscribe_only';
export type BridgeForwardingMode = 'per_gateway' | 'single';

/** Off = no publish topic filter; block/allow map to uplinkFilters.topics.{block,allow}. */
export type UplinkTopicMode = 'off' | 'block' | 'allow';

export const BRIDGE_MODES: readonly BridgeMode[] = [
  'bidirectional',
  'publish_only',
  'subscribe_only',
];
export const BRIDGE_FORWARDING_MODES: readonly BridgeForwardingMode[] = [
  'per_gateway',
  'single',
];

export interface BridgeGeoStrings {
  minLat: string;
  maxLat: string;
  minLng: string;
  maxLng: string;
}

export interface BridgeRewriteStrings {
  from: string;
  to: string;
}

export interface BridgeConfigForm {
  brokerId: string;
  url: string;
  username: string;
  /** '' on edit means "keep the stored password" (server-side merge). */
  password: string;
  /** Upstream topics, one per line. */
  subscriptions: string;
  mode: BridgeMode;
  forwardingMode: BridgeForwardingMode;
  ignoreOkToMqtt: boolean;
  // Subscribe-side (downlink) filtering.
  useTopicBlock: boolean;
  topicBlock: string;
  useGeo: boolean;
  geo: BridgeGeoStrings;
  // --- Page-only fields. When omitted, `buildBridgeConfig` preserves `base`. ---
  /**
   * Publish-side (uplink) channel allow-list — #3294. Channel *names* (e.g.
   * "LongFast") matched against the decoded ServiceEnvelope channelId. Empty
   * = uplink every channel. This is the primary, reliable publish filter;
   * the topic filter below is the advanced/raw escape hatch.
   */
  uplinkChannels?: string[];
  /** Publish-side (uplink) raw topic filter — advanced. */
  uplinkTopicMode?: UplinkTopicMode;
  uplinkTopics?: string;
  downlinkRewrite?: BridgeRewriteStrings;
  uplinkRewrite?: BridgeRewriteStrings;
}

export interface BridgeConfigError {
  key: string;
  fallback: string;
}

export interface BuildBridgeOptions {
  editing: boolean;
  /** Existing source config to merge over (preserves unmanaged keys). */
  base?: Record<string, any> | null;
}

const GEO_KEYS = ['minLat', 'maxLat', 'minLng', 'maxLng'] as const;

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseGeo(
  useGeo: boolean,
  geo: BridgeGeoStrings,
): { geo?: Record<string, number>; error?: BridgeConfigError } {
  if (!useGeo) return {};
  const out: Record<string, number> = {};
  for (const k of GEO_KEYS) {
    const v = geo[k];
    if (v) {
      const n = Number(v);
      if (Number.isNaN(n)) {
        return {
          error: { key: 'source.form.error_geo_invalid', fallback: 'Geo bounds must be numbers' },
        };
      }
      out[k] = n;
    }
  }
  return { geo: Object.keys(out).length > 0 ? out : undefined };
}

/** Drop the `block`/`allow` arrays from a topics object, keeping any other keys. */
function clearTopicLists(topics: Record<string, any> | undefined): Record<string, any> {
  const { block, allow, ...rest } = topics ?? {};
  void block;
  void allow;
  return rest;
}

function applyRewrite(
  cfg: Record<string, any>,
  key: 'downlinkTopicRewrite' | 'uplinkTopicRewrite',
  rule: BridgeRewriteStrings | undefined,
): void {
  if (rule === undefined) return; // unmanaged by this caller — preserve base.
  const from = rule.from.trim();
  const to = rule.to.trim();
  if (from && to) {
    cfg[key] = { from, to };
  } else {
    delete cfg[key];
  }
}

/**
 * Serialize a bridge form into the `config` blob posted to /api/sources.
 * Returns `{ config }` on success or `{ error }` with a translatable key.
 */
export function buildBridgeConfig(
  form: BridgeConfigForm,
  opts: BuildBridgeOptions,
): { config?: Record<string, any>; error?: BridgeConfigError } {
  if (!form.url.trim()) {
    return {
      error: { key: 'source.form.error_mqtt_url_required', fallback: 'Upstream URL is required' },
    };
  }

  const cfg: Record<string, any> = { ...(opts.base ?? {}) };

  // Parent broker — omit entirely when standalone (issue #3134).
  if (form.brokerId) cfg.brokerSourceId = form.brokerId;
  else delete cfg.brokerSourceId;

  // Upstream is rebuilt fresh (never spread from base — avoids leaking the
  // stored password back through). Empty password => undefined => server keeps.
  cfg.upstream = {
    url: form.url.trim(),
    username: form.username.trim() || undefined,
    password: form.password || undefined,
  };

  const subs = splitLines(form.subscriptions);
  cfg.subscriptions = subs.length > 0 ? subs : ['msh/#'];

  // Omit defaults so existing rows stay clean / adopt new defaults on upgrade.
  if (form.mode !== 'bidirectional') cfg.mode = form.mode;
  else delete cfg.mode;
  if (form.forwardingMode !== 'per_gateway') cfg.forwardingMode = form.forwardingMode;
  else delete cfg.forwardingMode;
  if (form.ignoreOkToMqtt) cfg.ignoreOkToMqtt = true;
  else delete cfg.ignoreOkToMqtt;

  // --- Subscribe-side (downlink) filters: manage topics.block + geo,
  // preserve any other downlink subkeys (channels/nodes/portnums). ---
  const downlink: Record<string, any> = { ...(opts.base?.downlinkFilters ?? {}) };
  const topicBlock = form.useTopicBlock ? splitLines(form.topicBlock) : [];
  if (topicBlock.length > 0) {
    downlink.topics = { ...clearTopicLists(downlink.topics), block: topicBlock };
  } else {
    const rest = clearTopicLists(downlink.topics);
    if (Object.keys(rest).length > 0) downlink.topics = rest;
    else delete downlink.topics;
  }
  const downGeo = parseGeo(form.useGeo, form.geo);
  if (downGeo.error) return { error: downGeo.error };
  if (downGeo.geo) downlink.geo = downGeo.geo;
  else delete downlink.geo;
  if (Object.keys(downlink).length > 0) cfg.downlinkFilters = downlink;
  else delete cfg.downlinkFilters;

  // --- Publish-side (uplink) filters (#3294): channel allow-list (primary)
  // and raw topic filter (advanced). Each sub-field is only managed when the
  // caller supplies it; otherwise the corresponding part of base.uplinkFilters
  // is preserved. The modal supplies neither, so it never touches them. ---
  if (form.uplinkChannels !== undefined || form.uplinkTopicMode !== undefined) {
    const uplink: Record<string, any> = { ...(opts.base?.uplinkFilters ?? {}) };

    if (form.uplinkChannels !== undefined) {
      const channels: Record<string, any> = { ...(uplink.channels ?? {}) };
      delete channels.allow;
      const names = form.uplinkChannels.map((c) => c.trim()).filter(Boolean);
      if (names.length > 0) channels.allow = names;
      if (Object.keys(channels).length > 0) uplink.channels = channels;
      else delete uplink.channels;
    }

    if (form.uplinkTopicMode !== undefined) {
      const topics = clearTopicLists(uplink.topics);
      const list = form.uplinkTopicMode !== 'off' ? splitLines(form.uplinkTopics ?? '') : [];
      if (form.uplinkTopicMode === 'block' && list.length > 0) topics.block = list;
      else if (form.uplinkTopicMode === 'allow' && list.length > 0) topics.allow = list;
      if (Object.keys(topics).length > 0) uplink.topics = topics;
      else delete uplink.topics;
    }

    if (Object.keys(uplink).length > 0) cfg.uplinkFilters = uplink;
    else delete cfg.uplinkFilters;
  }

  // --- Topic rewrites (#3166). Server rejects them on standalone bridges,
  // so clear when there's no parent broker. ---
  if (!cfg.brokerSourceId) {
    if (form.downlinkRewrite !== undefined) delete cfg.downlinkTopicRewrite;
    if (form.uplinkRewrite !== undefined) delete cfg.uplinkTopicRewrite;
  } else {
    applyRewrite(cfg, 'downlinkTopicRewrite', form.downlinkRewrite);
    applyRewrite(cfg, 'uplinkTopicRewrite', form.uplinkRewrite);
  }

  return { config: cfg };
}

/** Hydrate a full bridge form (including page-only fields) from a config blob. */
export function formFromBridgeConfig(config: Record<string, any> | null | undefined): BridgeConfigForm {
  const cfg = config ?? {};

  const downTopicBlock: string[] = cfg.downlinkFilters?.topics?.block ?? [];
  const downGeo = cfg.downlinkFilters?.geo ?? {};
  const hasGeo = GEO_KEYS.some((k) => downGeo[k] != null);

  const upChannels: string[] = Array.isArray(cfg.uplinkFilters?.channels?.allow)
    ? cfg.uplinkFilters.channels.allow
    : [];

  const upTopics = cfg.uplinkFilters?.topics ?? {};
  let uplinkTopicMode: UplinkTopicMode = 'off';
  let uplinkTopics = '';
  if (Array.isArray(upTopics.allow) && upTopics.allow.length > 0) {
    uplinkTopicMode = 'allow';
    uplinkTopics = upTopics.allow.join('\n');
  } else if (Array.isArray(upTopics.block) && upTopics.block.length > 0) {
    uplinkTopicMode = 'block';
    uplinkTopics = upTopics.block.join('\n');
  }

  const savedMode = cfg.mode;
  const savedForwarding = cfg.forwardingMode;

  return {
    brokerId: cfg.brokerSourceId ?? '',
    url: cfg.upstream?.url ?? '',
    username: cfg.upstream?.username ?? '',
    password: '',
    subscriptions: (cfg.subscriptions ?? []).join('\n'),
    mode:
      savedMode === 'publish_only' || savedMode === 'subscribe_only'
        ? savedMode
        : 'bidirectional',
    forwardingMode: savedForwarding === 'single' ? 'single' : 'per_gateway',
    ignoreOkToMqtt: cfg.ignoreOkToMqtt === true,
    useTopicBlock: downTopicBlock.length > 0,
    topicBlock: downTopicBlock.join('\n'),
    useGeo: hasGeo,
    geo: {
      minLat: downGeo.minLat != null ? String(downGeo.minLat) : '',
      maxLat: downGeo.maxLat != null ? String(downGeo.maxLat) : '',
      minLng: downGeo.minLng != null ? String(downGeo.minLng) : '',
      maxLng: downGeo.maxLng != null ? String(downGeo.maxLng) : '',
    },
    uplinkChannels: upChannels,
    uplinkTopicMode,
    uplinkTopics,
    downlinkRewrite: {
      from: cfg.downlinkTopicRewrite?.from ?? '',
      to: cfg.downlinkTopicRewrite?.to ?? '',
    },
    uplinkRewrite: {
      from: cfg.uplinkTopicRewrite?.from ?? '',
      to: cfg.uplinkTopicRewrite?.to ?? '',
    },
  };
}

export function emptyBridgeForm(): BridgeConfigForm {
  return {
    brokerId: '',
    url: '',
    username: '',
    password: '',
    subscriptions: 'msh/#',
    mode: 'bidirectional',
    forwardingMode: 'per_gateway',
    ignoreOkToMqtt: false,
    useTopicBlock: false,
    topicBlock: '',
    useGeo: false,
    geo: { minLat: '', maxLat: '', minLng: '', maxLng: '' },
    uplinkChannels: [],
    uplinkTopicMode: 'off',
    uplinkTopics: '',
    downlinkRewrite: { from: '', to: '' },
    uplinkRewrite: { from: '', to: '' },
  };
}
