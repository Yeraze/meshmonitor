/**
 * Derives a user-facing "node address" label from a configured source.
 * Returns null when the source has no host/broker field to display.
 */
export interface SourceLike {
  type?: string;
  config?: Record<string, unknown>;
}

export function getSourceEndpointLabel(source: SourceLike | undefined | null): string | null {
  const cfg = source?.config as Record<string, unknown> | undefined;
  if (!cfg) return null;

  const host = typeof cfg.host === 'string' ? cfg.host : undefined;
  const broker = typeof cfg.broker === 'string' ? cfg.broker : undefined;
  const portRaw = cfg.port;
  const port = typeof portRaw === 'number' ? portRaw : undefined;

  const base = host ?? broker;
  if (!base) return null;
  return port ? `${base}:${port}` : base;
}
