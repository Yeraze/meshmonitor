/**
 * The per-source app's tabs, each in its own lazy chunk.
 *
 * Before this split, `App.tsx` imported every tab statically, so opening any
 * one tab downloaded and ran the code for all of them (settings, device
 * configuration, admin commands, charts, ...). Now `App` renders them through
 * a `<Suspense>` boundary and only the tab on screen loads.
 *
 * Two things keep tab switching quick:
 * - `preloadAppTabForPath` starts the landing tab's chunk alongside the `App`
 *   chunk (called from `main.tsx`), so the first tab does not wait for `App`
 *   to download before its own download starts.
 * - The sidebar calls `preloadAppTab` on hover/focus of an entry.
 *
 * Keep the order below matching the old import order in `App.tsx`: the
 * `meshmonitor-eager-css` plugin walks these calls in source order to keep
 * each tab's CSS in the entry sheet, in the same cascade position as before.
 */
import { lazyWithPreload } from './utils/lazyWithPreload';

export const InfoTab = lazyWithPreload(() => import('./components/InfoTab'));
export const SettingsTab = lazyWithPreload(() => import('./components/SettingsTab'));
export const ConfigurationTab = lazyWithPreload(() => import('./components/ConfigurationTab'));
export const MqttBridgeConfigurationView = lazyWithPreload(() => import('./components/MQTT/MqttBridgeConfigurationView'));
export const NotificationsTab = lazyWithPreload(() => import('./components/NotificationsTab'));
export const UsersTab = lazyWithPreload(() => import('./components/UsersTab'));
export const AuditLogTab = lazyWithPreload(() => import('./components/AuditLogTab'));
export const SecurityTab = lazyWithPreload(() => import('./components/SecurityTab').then((m) => ({ default: m.SecurityTab })));
export const AdminCommandsTab = lazyWithPreload(() => import('./components/AdminCommandsTab'));
export const Dashboard = lazyWithPreload(() => import('./components/Dashboard'));
export const NodesTab = lazyWithPreload(() => import('./components/NodesTab'));
export const MessagesTab = lazyWithPreload(() => import('./components/MessagesTab'));
export const ChannelsTab = lazyWithPreload(() => import('./components/ChannelsTab'));
export const PacketMonitorPanel = lazyWithPreload(() => import('./components/PacketMonitorPanel'));
export const MqttPacketMonitorView = lazyWithPreload(() => import('./components/MQTT/MqttPacketMonitorView'));
export const AutomationTab = lazyWithPreload(() => import('./components/AutomationTab'));

/** Chunks behind each tab route in `App.tsx` (the `<Route path>` values). */
const TAB_CHUNKS: Record<string, Array<{ preload: () => Promise<unknown> }>> = {
  nodes: [NodesTab],
  messages: [MessagesTab],
  channels: [ChannelsTab],
  info: [InfoTab],
  dashboard: [Dashboard],
  configuration: [ConfigurationTab],
  settings: [SettingsTab, MqttBridgeConfigurationView],
  automation: [AutomationTab],
  notifications: [NotificationsTab],
  users: [UsersTab],
  audit: [AuditLogTab],
  security: [SecurityTab],
  admin: [AdminCommandsTab],
  packetmonitor: [PacketMonitorPanel, MqttPacketMonitorView],
};

/** The tab `App` shows for an empty sub-path (its index route). */
const DEFAULT_TAB = 'nodes';

/**
 * Start loading a tab's code. Unknown ids (search, config-search, ...) are a
 * no-op. A failed download is not reported here: rendering the tab retries it
 * and surfaces the error through the tab's own error boundary.
 */
export function preloadAppTab(tab: string): void {
  for (const chunk of TAB_CHUNKS[tab] ?? []) {
    chunk.preload().catch(() => undefined);
  }
}

/**
 * Start loading the tab named by a `/source/:id/*` splat (`'messages'`,
 * `'nodes/123'`, `''` for the index route).
 */
export function preloadAppTabForPath(splat: string | undefined): void {
  const tab = (splat ?? '').split('/')[0] || DEFAULT_TAB;
  preloadAppTab(tab);
}
