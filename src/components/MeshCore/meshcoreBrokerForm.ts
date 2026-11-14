/**
 * Form state for the embedded MeshCore MQTT broker source (#6197), and the
 * two conversions the source modal needs: stored config -> form, form ->
 * config to save. Pure, so the shape is unit tested apart from the modal.
 *
 * Passwords are never seeded back into the form: the server keeps a stored
 * password when the field is left blank (see sourceConfigRedaction.ts).
 */

export interface BrokerTargetForm {
  id: string;
  label: string;
  enabled: boolean;
  url: string;
  identityMode: 'passthrough' | 'own';
  username: string;
  password: string;
  tokenAudience: string;
  observers: string;
  iataFilter: string;
  rejectUnauthorized: boolean;
}

export interface BrokerFormState {
  port: string;
  regions: string;
  tokenAudience: string;
  allowedObservers: string;
  username: string;
  password: string;
  maxClients: string;
  maxMessagesPerSecond: string;
  maxPayloadKb: string;
  ownIdentityName: string;
  targets: BrokerTargetForm[];
  autoConnect: boolean;
}

export const BROKER_FORM_DEFAULTS = {
  port: '1884',
  maxClients: '50',
  maxMessagesPerSecond: '20',
  maxPayloadKb: '64',
};

const KEY_RE = /^[0-9a-fA-F]{64}$/;
const IATA_RE = /^[A-Za-z0-9]{2,8}$/;

export function emptyBrokerForm(): BrokerFormState {
  return {
    port: BROKER_FORM_DEFAULTS.port,
    regions: '',
    tokenAudience: '',
    allowedObservers: '',
    username: '',
    password: '',
    maxClients: BROKER_FORM_DEFAULTS.maxClients,
    maxMessagesPerSecond: BROKER_FORM_DEFAULTS.maxMessagesPerSecond,
    maxPayloadKb: BROKER_FORM_DEFAULTS.maxPayloadKb,
    ownIdentityName: '',
    targets: [],
    autoConnect: true,
  };
}

function newTargetId(): string {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function emptyBrokerTarget(): BrokerTargetForm {
  return {
    id: newTargetId(),
    label: '',
    enabled: false,
    url: '',
    identityMode: 'passthrough',
    username: '',
    password: '',
    tokenAudience: '',
    observers: '',
    iataFilter: '',
    rejectUnauthorized: true,
  };
}

const lines = (v: unknown): string =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join('\n') : '';
const commas = (v: unknown): string =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join(', ') : '';
const numStr = (v: unknown, fallback: string): string => (typeof v === 'number' ? String(v) : fallback);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Stored (possibly masked) config -> form. */
export function brokerFormFromConfig(raw: Record<string, unknown> | undefined | null): BrokerFormState {
  const cfg = obj(raw);
  const listener = obj(cfg.listener);
  const auth = obj(cfg.auth);
  const limits = obj(cfg.limits);
  const forwarding = obj(cfg.forwarding);
  const payload = limits.maxPayloadBytes;
  const targets = Array.isArray(forwarding.targets) ? forwarding.targets.map(obj) : [];
  return {
    port: numStr(listener.port, BROKER_FORM_DEFAULTS.port),
    regions: commas(cfg.regions),
    tokenAudience: s(auth.tokenAudience),
    allowedObservers: lines(auth.allowedObservers),
    username: s(auth.username),
    password: '',
    maxClients: numStr(limits.maxClients, BROKER_FORM_DEFAULTS.maxClients),
    maxMessagesPerSecond: numStr(limits.maxMessagesPerSecond, BROKER_FORM_DEFAULTS.maxMessagesPerSecond),
    maxPayloadKb: typeof payload === 'number' ? String(Math.round(payload / 1024)) : BROKER_FORM_DEFAULTS.maxPayloadKb,
    ownIdentityName: s(forwarding.ownIdentityName),
    targets: targets.map((t) => ({
      id: s(t.id) || newTargetId(),
      label: s(t.label),
      enabled: t.enabled === true,
      url: s(t.url),
      identityMode: t.identityMode === 'own' ? 'own' : 'passthrough',
      username: s(t.username),
      password: '',
      tokenAudience: s(t.tokenAudience),
      observers: lines(t.observers),
      iataFilter: commas(t.iataFilter),
      rejectUnauthorized: t.rejectUnauthorized !== false,
    })),
    autoConnect: cfg.autoConnect !== false,
  };
}

function splitList(v: string): string[] {
  return v
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

export type BrokerFormResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; errorKey: string; fallback: string };

const err = (errorKey: string, fallback: string): BrokerFormResult => ({ ok: false, errorKey, fallback });

function intField(v: string, min: number, max: number): number | null {
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Form -> config. Mirrors the server's validateMeshCoreBrokerConfig for quick
 * feedback; the server stays the authority. `hasStoredPassword` lets an edit
 * that leaves the static password blank keep the stored one.
 */
export function brokerFormToConfig(form: BrokerFormState, hasStoredPassword = false): BrokerFormResult {
  const port = intField(form.port, 1, 65535);
  if (port === null) return err('source.form.error_port_range', 'Port must be between 1 and 65535');

  const regions = splitList(form.regions).map((r) => r.toUpperCase());
  if (regions.some((r) => !IATA_RE.test(r))) {
    return err('source.form.mcb_error_region', 'Each region must be a 2 to 8 character IATA code');
  }
  const observers = splitList(form.allowedObservers).map((k) => k.toUpperCase());
  if (observers.some((k) => !KEY_RE.test(k))) {
    return err('source.form.mcb_error_observer_key', 'Each observer public key must be 64 hex characters');
  }
  const tokenAudience = form.tokenAudience.trim();
  const username = form.username.trim();
  const hasPassword = form.password !== '' || hasStoredPassword;
  if (!tokenAudience && !(username && hasPassword)) {
    return err(
      'source.form.mcb_error_no_auth',
      'Set a token audience, a static username and password, or both. Anonymous logins are refused.',
    );
  }
  if (form.password !== '' && !username) {
    return err('source.form.mcb_error_username', 'A static password needs a username');
  }

  const maxClients = intField(form.maxClients, 1, 1000);
  const maxRate = intField(form.maxMessagesPerSecond, 1, 200);
  const maxKb = intField(form.maxPayloadKb, 1, 1024);
  if (maxClients === null || maxRate === null || maxKb === null) {
    return err('source.form.mcb_error_limits', 'Limits: up to 1000 observers, 200 messages per second, 1024 KB');
  }

  const targets: Record<string, unknown>[] = [];
  for (const t of form.targets) {
    const url = t.url.trim();
    if (!url) return err('source.form.mcb_error_target_url', 'Each forwarding target needs a broker URL');
    const tObservers = splitList(t.observers).map((k) => k.toUpperCase());
    if (tObservers.some((k) => !KEY_RE.test(k))) {
      return err('source.form.mcb_error_observer_key', 'Each observer public key must be 64 hex characters');
    }
    const iata = splitList(t.iataFilter).map((r) => r.toUpperCase());
    if (iata.some((r) => !IATA_RE.test(r))) {
      return err('source.form.mcb_error_region', 'Each region must be a 2 to 8 character IATA code');
    }
    if (t.identityMode === 'own' && t.enabled && !t.tokenAudience.trim()) {
      return err('source.form.mcb_error_target_audience', 'An own-identity target needs a token audience');
    }
    const entry: Record<string, unknown> = {
      id: t.id,
      enabled: t.enabled,
      url,
      identityMode: t.identityMode,
      observers: tObservers,
      rejectUnauthorized: t.rejectUnauthorized,
    };
    if (t.label.trim()) entry.label = t.label.trim();
    if (iata.length > 0) entry.iataFilter = iata;
    if (t.identityMode === 'passthrough') {
      if (t.username.trim()) entry.username = t.username.trim();
      if (t.password) entry.password = t.password;
    } else {
      entry.tokenAudience = t.tokenAudience.trim();
    }
    targets.push(entry);
  }

  const auth: Record<string, unknown> = {};
  if (tokenAudience) auth.tokenAudience = tokenAudience;
  if (observers.length > 0) auth.allowedObservers = observers;
  if (username) auth.username = username;
  if (form.password) auth.password = form.password;

  const config: Record<string, unknown> = {
    listener: { port },
    auth,
    limits: { maxClients, maxMessagesPerSecond: maxRate, maxPayloadBytes: maxKb * 1024 },
    autoConnect: form.autoConnect,
  };
  if (regions.length > 0) config.regions = regions;
  if (targets.length > 0 || form.ownIdentityName.trim()) {
    const forwarding: Record<string, unknown> = { targets };
    if (form.ownIdentityName.trim()) forwarding.ownIdentityName = form.ownIdentityName.trim();
    config.forwarding = forwarding;
  }
  return { ok: true, config };
}
