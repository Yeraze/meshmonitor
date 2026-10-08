/**
 * Which MeshCore source-page tabs a viewer may open (#5666).
 *
 * One rule set, read by the nav (`MeshCoreSubToolbar`) and by the page
 * (`MeshCorePage`), so a tab the nav hides cannot be reached another way.
 * Each tab needs the grant its routes check, on this source. The rules match
 * the Meshtastic sidebar (`Sidebar.tsx`) tab for tab:
 *
 *   nodes          always: the page shell. Its rows need `nodes:read`.
 *   channels       `messages:read` or any `channel_N:read`
 *   rooms          `messages:read`
 *   dms            `messages:read`            (Node Details)
 *   telemetry      `dashboard:read`           (the Meshtastic Dashboard tab)
 *   packets        `packetmonitor:read`
 *   info           the page's own gate, `connection:read`
 *   configuration  `configuration:read`
 *   automations    `automation:read`
 *   notifications  signed in (per-user preferences)
 *   settings       `settings:read`
 *
 * Hiding a tab is not the access control: every route behind these tabs
 * checks its own grant.
 */
import { useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import type { ResourceType } from '../../types/permission';

export type MeshCoreView = 'nodes' | 'channels' | 'rooms' | 'dms' | 'telemetry' | 'packets' | 'info' | 'configuration' | 'automations' | 'notifications' | 'settings';

/** Every tab, in nav order. */
export const MESHCORE_VIEWS: readonly MeshCoreView[] = [
  'nodes', 'channels', 'rooms', 'dms', 'telemetry', 'packets', 'info',
  'configuration', 'automations', 'notifications', 'settings',
];

/** The tab shown when the requested one is not open to the viewer. Always visible. */
export const MESHCORE_FALLBACK_VIEW: MeshCoreView = 'nodes';

/** Channel slots that have their own `channel_N` resource. */
const CHANNEL_RESOURCES: readonly ResourceType[] = [
  'channel_0', 'channel_1', 'channel_2', 'channel_3',
  'channel_4', 'channel_5', 'channel_6', 'channel_7',
];

export interface MeshCoreViewAccessInput {
  /** `read` on a resource, on this source for a per-source resource. */
  canRead: (resource: ResourceType) => boolean;
  isAuthenticated: boolean;
  /** False when there is no source context: the Info tab would have no data. */
  showInfo?: boolean;
}

/** The tabs open to a viewer, in nav order. Pure. */
export function visibleMeshCoreViews({ canRead, isAuthenticated, showInfo = true }: MeshCoreViewAccessInput): MeshCoreView[] {
  const messages = canRead('messages');
  const open: Record<MeshCoreView, boolean> = {
    nodes: true,
    channels: messages || CHANNEL_RESOURCES.some((resource) => canRead(resource)),
    rooms: messages,
    dms: messages,
    telemetry: canRead('dashboard'),
    packets: canRead('packetmonitor'),
    info: showInfo,
    configuration: canRead('configuration'),
    automations: canRead('automation'),
    notifications: isAuthenticated,
    settings: canRead('settings'),
  };
  return MESHCORE_VIEWS.filter((view) => open[view]);
}

/** The requested tab when the viewer may open it, else the fallback. */
export function resolveMeshCoreView(requested: MeshCoreView, visible: readonly MeshCoreView[]): MeshCoreView {
  return visible.includes(requested) ? requested : MESHCORE_FALLBACK_VIEW;
}

/** The tabs open to the current viewer on the current source (from SourceContext). */
export function useMeshCoreViewAccess(showInfo = true): MeshCoreView[] {
  const { authStatus, hasPermission } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;
  return useMemo(
    () => visibleMeshCoreViews({
      canRead: (resource) => hasPermission(resource, 'read'),
      isAuthenticated,
      showInfo,
    }),
    [hasPermission, isAuthenticated, showInfo],
  );
}
