/**
 * Small pure helpers shared by the places that mount the root finder (#6287).
 */
import { REGION_SHORT_NAME } from '../../utils/loraFrequency';

/** First `n` segments of a root. */
export function firstSegments(root: string, n = 2): string {
  return root.trim().replace(/^\/+|\/+$/g, '').split('/').slice(0, n).join('/');
}

/**
 * Where a device search starts: `msh/<region>`, unless the current root has a
 * non-`msh` prefix, in which case its first two segments.
 */
export function defaultDeviceRegionRoot(currentRoot: string, loraRegion?: number): string {
  const current = currentRoot.trim();
  const parts = current.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] !== 'msh') return parts.slice(0, 2).join('/');
  const name = loraRegion !== undefined ? REGION_SHORT_NAME[loraRegion] : undefined;
  if (name) return `msh/${name}`;
  if (parts.length >= 2) return parts.slice(0, 2).join('/');
  return 'msh/US';
}

/** Where a bridge search starts: the first two segments of its first subscription. */
export function defaultBridgeRegionRoot(subscriptions: string): string {
  const first = subscriptions
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  const root = first ? firstSegments(first.replace(/\/?[#+].*$/, '')) : '';
  return root.split('/').length >= 2 ? root : 'msh/US';
}

/**
 * Apply a picked root to a bridge's subscription lines. A single `<old>/#`
 * line is replaced; otherwise `<root>/#` is added (once).
 */
export function applyRootToSubscriptions(subscriptions: string, root: string): string {
  const next = `${root}/#`;
  const lines = subscriptions
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 1 && lines[0].endsWith('/#')) return next;
  if (lines.includes(next)) return lines.join('\n');
  return [...lines, next].join('\n');
}
