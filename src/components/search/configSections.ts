/**
 * The catalogue of configurable sections MeshMonitor ships (#5182).
 *
 * Every settings-ish tab already rendered a `SectionNav` from an inline array
 * of `{ id, label }`. Those arrays are lifted here so there is ONE list per
 * surface, used by three consumers at once:
 *
 *   1. the tab itself, which still renders its `SectionNav` from it;
 *   2. the in-page filter inside that nav;
 *   3. the cross-page configuration palette, which has to know about sections
 *      on tabs that are not currently mounted.
 *
 * (3) is the reason this cannot be derived from the DOM: searching for "MQTT"
 * from the Nodes tab has to find the Configuration tab's MQTT panel, and that
 * panel does not exist until you navigate there.
 *
 * `keywords` exist for the gap between what a section is called and what a user
 * types. The in-page filter also matches a section's rendered text, so a
 * keyword is only needed for a word that does NOT appear on screen — "GPS" for
 * Position, "radio" for LoRa, "email" for Apprise. The palette has no rendered
 * text to fall back on, so it leans on them harder.
 */
import type { TFunction } from 'i18next';
import type { NavItem } from '../SectionNav';
import { isMqttOnlySourceType } from '../../utils/nodeTransport';

/**
 * i18next's `t`, exactly as the tabs already hold it.
 *
 * Aliased rather than narrowed to `(key, default) => string`: TFunction is a
 * heavily overloaded type and a narrower structural alias is not assignable
 * from it, so every caller would need a cast. Tests stub it the way
 * TracerouteParticipationPicker's already do — `as unknown as Translate`.
 */
export type Translate = TFunction;

/**
 * Settings sections that belong to the standalone global settings page.
 *
 * Moved here from SettingsTab so the palette can reason about which surface a
 * section lives on without importing that 3,000-line component.
 */
export const GLOBAL_SETTINGS_SECTIONS = new Set([
  'settings-language', 'settings-units', 'settings-appearance', 'settings-link-previews',
  'settings-privacy', 'settings-meshcore-messaging', 'settings-map',
  'settings-security',
  'settings-remote-admin',
  'settings-apprise-server', 'settings-elevation', 'settings-atak-cot', 'settings-backup',
  'settings-channel-database',
  'settings-scripts',
  'settings-maintenance', 'settings-analytics',
  // Position estimation is a single global, cross-source batch job (issue
  // #3271) — it belongs in global Settings, not the per-source Automation tab.
  'settings-position-estimation',
  // Mesh Issues Analysis is a single global, cross-source batch job (#4964)
  // — same reasoning as position estimation above.
  'settings-mesh-issues',
  // Auto-Enrichment runs one cross-source scheduler for the install (#5287).
  'settings-auto-enrichment',
  // Coverage Report retention is a single global setting (#5277 P1 WP2) —
  // same reasoning as position estimation/mesh issues above.
  'settings-coverage',
]);

/** Settings sections that belong to a source's own Settings tab. */
export const SOURCE_SETTINGS_SECTIONS = new Set([
  'settings-sorting', 'settings-node-display', 'settings-telemetry',
  'settings-notifications', 'settings-packet-monitor', 'settings-solar',
  'settings-firmware', 'settings-reset-ui',
  // Coverage Report MQTT gateway-reception recording (#5277 P2 WP3) — shown
  // only on mqtt_broker/mqtt_bridge sources (see the isMqttOnlySourceType
  // filter below), so it lives in the source, not global, section set.
  'settings-coverage-mqtt',
  'settings-management', 'settings-danger',
]);

export interface SettingsNavOptions {
  /**
   * `'global'` and `'source'` each render a subset; `undefined` is the legacy
   * "render everything" mode SettingsTab still supports.
   */
  mode?: 'global' | 'source';
  isAdmin: boolean;
  canWriteSettings: boolean;
  /** Database Maintenance is SQLite-only (it uses VACUUM). */
  databaseType?: 'sqlite' | 'postgres' | 'mysql' | null;
  firmwareOtaEnabled?: boolean;
  /**
   * The active source's `type` (e.g. `mqtt_broker`, `mqtt_bridge`,
   * `meshtastic_tcp`). Gates `settings-coverage-mqtt` to MQTT-only sources
   * (#5277 P2 WP3) via `isMqttOnlySourceType`. `undefined`/`null` hides it,
   * matching the global-settings surface where no single source applies.
   */
  sourceType?: string | null;
}

/**
 * Sections of the Settings tab.
 *
 * The visibility conditions mirror the tab's own — an entry the tab will not
 * render must not appear in either the nav or the palette, or the palette hands
 * out deep links that land on nothing.
 */
export function settingsNavItems(t: Translate, options: SettingsNavOptions): NavItem[] {
  const { mode, isAdmin, canWriteSettings, databaseType, firmwareOtaEnabled, sourceType } = options;
  const inMode = (id: string) =>
    !mode || (mode === 'global' ? GLOBAL_SETTINGS_SECTIONS.has(id) : SOURCE_SETTINGS_SECTIONS.has(id));

  const items: NavItem[] = [
    { id: 'settings-language', label: t('settings.language'), keywords: ['locale', 'translation'] },
    { id: 'settings-units', label: t('settings.units_and_formats'), keywords: ['metric', 'imperial', 'celsius', 'fahrenheit', 'kilometers', 'miles', 'date', 'time', 'clock'] },
    { id: 'settings-sorting', label: t('settings.sorting'), keywords: ['order', 'sort'] },
    { id: 'settings-appearance', label: t('settings.appearance'), keywords: ['theme', 'dark', 'light', 'colors', 'icons', 'font'] },
    { id: 'settings-link-previews', label: t('settings.link_previews', 'Link Previews'), keywords: ['url', 'unfurl'] },
    { id: 'settings-privacy', label: t('settings.privacy', 'Privacy'), keywords: ['terms', 'policy', 'gdpr', 'contact'] },
    { id: 'settings-meshcore-messaging', label: t('settings.meshcore_messaging', 'MeshCore Messaging'), keywords: ['meshcore', 'chat'] },
    { id: 'settings-map', label: t('settings.map'), keywords: ['tiles', 'tileset', 'basemap', 'markers', 'pins', 'zoom'] },
    { id: 'settings-node-display', label: t('settings.node_display'), keywords: ['nodes', 'list', 'columns', 'age', 'inactive'] },
    { id: 'settings-telemetry', label: t('settings.telemetry'), keywords: ['battery', 'voltage', 'charts', 'graphs', 'sensors'] },
    { id: 'settings-notifications', label: t('settings.notifications_and_security'), keywords: ['alerts', 'sounds', 'audio', 'desktop'] },
    { id: 'settings-security', label: t('settings.security', 'Security'), keywords: ['pki', 'keys', 'encryption'] },
    { id: 'settings-packet-monitor', label: t('settings.packet_monitor'), keywords: ['packets', 'logging', 'capture'] },
    { id: 'settings-solar', label: t('settings.solar_monitoring'), keywords: ['sun', 'panel', 'power', 'battery'] },
    { id: 'settings-remote-admin', label: t('settings.remote_admin_section', 'Remote Administration'), keywords: ['admin', 'password', 'credentials'] },
    { id: 'settings-apprise-server', label: t('settings.apprise_server_section', 'Apprise API Server'), keywords: ['notifications', 'email', 'push', 'webhook'] },
    { id: 'settings-elevation', label: t('settings.elevation_section', 'Elevation / Terrain'), keywords: ['dem', 'terrain', 'altitude', 'height'] },
    { id: 'settings-backup', label: t('settings.system_backup', 'System Backup'), keywords: ['restore', 'export', 'import', 'archive'] },
    { id: 'settings-channel-database', label: t('channel_database.title', 'Channel Database'), keywords: ['psk', 'decrypt', 'channels', 'keys'] },
    { id: 'settings-scripts', label: t('settings.scripts_section', 'Scripts'), keywords: ['javascript', 'automation', 'code'] },
    { id: 'settings-maintenance', label: t('maintenance.title', 'Database Maintenance'), keywords: ['vacuum', 'sqlite', 'purge', 'cleanup'] },
    { id: 'settings-firmware', label: t('firmware.title', 'Firmware Updates'), keywords: ['ota', 'update', 'flash'] },
    { id: 'settings-reset-ui', label: t('settings.reset_ui_positions'), keywords: ['layout', 'widgets', 'reset'] },
    { id: 'settings-analytics', label: t('settings.analytics'), keywords: ['telemetry', 'usage', 'stats'] },
    { id: 'settings-position-estimation', label: t('automation.position_estimation.title', 'Position Estimation'), keywords: ['gps', 'location', 'estimate', 'triangulation'] },
    { id: 'settings-mesh-issues', label: t('automation.mesh_issues.title', 'Mesh Issues Analysis'), keywords: ['diagnostics', 'health', 'problems'] },
    { id: 'settings-auto-enrichment', label: t('automation.auto_enrichment.title', 'Auto-Enrichment'), keywords: ['nodeinfo', 'enrichment', 'fix all', 'schedule', 'cron'] },
    { id: 'settings-coverage', label: t('settings.coverage_section', 'Coverage Report'), keywords: ['coverage', 'range test', 'retention', 'survey'] },
    { id: 'settings-coverage-mqtt', label: t('settings.coverage_mqtt_section', 'Coverage recording'), keywords: ['coverage', 'gateway', 'mqtt', 'survey', 'range test'] },
    { id: 'settings-management', label: t('settings.settings_management'), keywords: ['export', 'import', 'reset'] },
    { id: 'settings-danger', label: t('settings.danger_zone'), keywords: ['delete', 'purge', 'wipe', 'reset'] },
  ];

  const adminOnly = new Set([
    'settings-remote-admin', 'settings-apprise-server', 'settings-elevation',
    'settings-channel-database', 'settings-scripts', 'settings-analytics',
  ]);
  const settingsWriteOnly = new Set(['settings-position-estimation', 'settings-mesh-issues', 'settings-auto-enrichment', 'settings-coverage', 'settings-coverage-mqtt']);

  return items.filter((item) => {
    if (!inMode(item.id)) return false;
    if (adminOnly.has(item.id) && !isAdmin) return false;
    if (settingsWriteOnly.has(item.id) && !canWriteSettings) return false;
    // Database Maintenance uses SQLite-specific features like VACUUM.
    if (item.id === 'settings-maintenance' && databaseType !== 'sqlite') return false;
    if (item.id === 'settings-firmware' && !(isAdmin && firmwareOtaEnabled)) return false;
    // Coverage recording only means anything on an MQTT-only source
    // (mqtt_broker/mqtt_bridge) — see isMqttOnlySourceType (#5277 P2 WP3).
    if (item.id === 'settings-coverage-mqtt' && !isMqttOnlySourceType(sourceType)) return false;
    return true;
  });
}

/** Sections of the per-source Configuration (device radio config) tab. */
export function configurationNavItems(t: Translate): NavItem[] {
  return [
    { id: 'config-danger', label: t('config.warning_title', 'Warning') },
    { id: 'config-import-export', label: t('config.import_export_title', 'Import/Export'), keywords: ['backup', 'restore', 'yaml'] },
    { id: 'config-node-identity', label: t('config.node_identity', 'Node Identity'), keywords: ['name', 'shortname', 'longname', 'role'] },
    { id: 'config-device', label: t('config.device_config', 'Device'), keywords: ['role', 'rebroadcast', 'button', 'buzzer'] },
    { id: 'config-lora', label: t('config.lora_config', 'LoRa'), keywords: ['radio', 'region', 'preset', 'frequency', 'hops', 'bandwidth', 'spreading', 'tx', 'power'] },
    { id: 'config-position', label: t('config.position_config', 'Position'), keywords: ['gps', 'gnss', 'location', 'fixed', 'broadcast', 'smart'] },
    { id: 'config-power', label: t('config.power_config', 'Power'), keywords: ['battery', 'sleep', 'shutdown', 'charge'] },
    { id: 'config-display', label: t('config.display_config', 'Display'), keywords: ['screen', 'oled', 'brightness', 'timeout'] },
    { id: 'config-telemetry', label: t('config.telemetry_config', 'Telemetry'), keywords: ['sensors', 'battery', 'environment', 'interval'] },
    { id: 'config-mqtt', label: t('config.mqtt_config', 'MQTT'), keywords: ['broker', 'uplink', 'downlink', 'json'] },
    { id: 'config-neighbor', label: t('config.neighbor_info', 'Neighbor Info'), keywords: ['neighbours', 'neighbors'] },
    { id: 'config-network', label: t('config.network_config', 'Network'), keywords: ['wifi', 'ethernet', 'ip', 'ntp', 'dns'] },
    { id: 'config-extnotif', label: t('extnotif_config.title', 'External Notification'), keywords: ['buzzer', 'led', 'alert', 'ringtone'] },
    { id: 'config-storeforward', label: t('storeforward_config.title', 'Store & Forward'), keywords: ['history', 'router'] },
    { id: 'config-rangetest', label: t('rangetest_config.title', 'Range Test'), keywords: ['distance', 'test'] },
    { id: 'config-cannedmsg', label: t('cannedmsg_config.title', 'Canned Messages'), keywords: ['quick', 'preset', 'replies'] },
    { id: 'config-audio', label: t('audio_config.title', 'Audio'), keywords: ['codec2', 'voice', 'ptt'] },
    { id: 'config-remotehardware', label: t('remotehardware_config.title', 'Remote Hardware'), keywords: ['gpio', 'pins'] },
    { id: 'config-detectionsensor', label: t('detectionsensor_config.title', 'Detection Sensor'), keywords: ['gpio', 'trigger', 'motion'] },
    { id: 'config-paxcounter', label: t('paxcounter_config.title', 'Paxcounter'), keywords: ['wifi', 'bluetooth', 'count'] },
    { id: 'config-statusmessage', label: t('statusmessage_config.title', 'Status Message') },
    { id: 'config-trafficmanagement', label: t('trafficmanagement_config.title', 'Traffic Management'), keywords: ['airtime', 'duty', 'rate'] },
    { id: 'config-meshbeacon', label: t('meshbeacon_config.title', 'MeshBeacon'), keywords: ['beacon', 'onboarding'] },
    { id: 'config-serial', label: t('serial_config.title', 'Serial'), keywords: ['uart', 'baud', 'gpio'] },
    { id: 'config-ambientlighting', label: t('ambientlighting_config.title', 'Ambient Lighting'), keywords: ['led', 'rgb', 'color'] },
    { id: 'config-security', label: t('security_config.title', 'Security'), keywords: ['pki', 'keys', 'admin', 'serial'] },
    { id: 'config-channels', label: t('config.channels', 'Channels'), keywords: ['psk', 'primary', 'slots'] },
    { id: 'config-backup', label: t('config.backup_management', 'Backup'), keywords: ['restore', 'snapshot'] },
  ];
}

/** Sections of the per-source Automation tab. */
export function automationNavItems(t: Translate): NavItem[] {
  return [
    { id: 'airtime-cutoff', label: t('automation.airtime_cutoff.title', 'Cutoff Airtime Utilization Threshold'), keywords: ['duty cycle', 'channel', 'utilization'] },
    { id: 'auto-welcome', label: t('automation.welcome.title', 'Auto Welcome'), keywords: ['greeting', 'new node'] },
    { id: 'auto-favorite', label: t('automation.auto_favorite.title', 'Auto Favorite'), keywords: ['star', 'favourite'] },
    { id: 'auto-traceroute', label: t('automation.traceroute.title', 'Auto Traceroute'), keywords: ['route', 'path', 'hops'] },
    { id: 'auto-localstats', label: t('automation.auto_localstats.title', 'Auto Remote LocalStats'), keywords: ['telemetry', 'stats'] },
    { id: 'auto-ping', label: t('automation.auto_ping.title', 'Auto Ping'), keywords: ['keepalive', 'reachability'] },
    { id: 'auto-heap-management', label: t('automation.auto_heap.title', 'Auto Heap Management'), keywords: ['memory', 'reboot'] },
    { id: 'remote-admin-scanner', label: t('automation.remote_admin_scanner.title', 'Remote Admin Scanner'), keywords: ['admin', 'discover'] },
    { id: 'auto-time-sync', label: t('automation.time_sync.title', 'Auto Time Sync'), keywords: ['clock', 'ntp', 'rtc'] },
    { id: 'auto-acknowledge', label: t('automation.acknowledge.title', 'Auto Acknowledge'), keywords: ['ack', 'reply'] },
    { id: 'auto-announce', label: t('automation.announce.title', 'Auto Announce'), keywords: ['broadcast', 'scheduled', 'message'] },
    { id: 'auto-responder', label: t('automation.auto_responder.title', 'Auto Responder'), keywords: ['reply', 'bot', 'keyword'] },
    { id: 'auto-key-management', label: t('automation.auto_key_management.title', 'Auto Key Management'), keywords: ['pki', 'key mismatch', 'nodeinfo'] },
    { id: 'timer-triggers', label: t('automation.timer_triggers.title', 'Timer Triggers'), keywords: ['schedule', 'cron', 'timed events'] },
    { id: 'geofence-triggers', label: t('automation.geofence_triggers.title', 'Geofence Triggers'), keywords: ['location', 'area', 'boundary'] },
    { id: 'auto-delete-by-distance', label: t('automation.distance_delete.title', 'Auto Delete by Distance'), keywords: ['purge', 'range', 'cleanup'] },
    { id: 'ignored-nodes', label: t('automation.ignored_nodes.title', 'Ignored Nodes'), keywords: ['block', 'mute', 'blacklist'] },
  ];
}

/** Sections of the per-source Notifications tab. */
export function notificationsNavItems(t: Translate): NavItem[] {
  return [
    { id: 'notif-services', label: t('notifications.services_title', 'Services'), keywords: ['filters', 'alerts', 'triggers'] },
    { id: 'notif-webpush', label: t('notifications.webpush_title', 'Web Push'), keywords: ['browser', 'desktop', 'subscribe'] },
    { id: 'notif-apprise', label: t('notifications.apprise_title', 'Apprise'), keywords: ['email', 'discord', 'telegram', 'webhook', 'slack'] },
  ];
}

/** Sections of the per-source Admin (remote administration) tab. */
export function adminCommandsNavItems(t: Translate): NavItem[] {
  return [
    { id: 'admin-target-node', label: t('admin_commands.target_node', 'Target Node'), keywords: ['remote', 'select'] },
    { id: 'radio-config', label: t('admin_commands.radio_configuration', 'Radio Configuration'), keywords: ['lora', 'region', 'preset'] },
    { id: 'device-config', label: t('admin_commands.device_configuration', 'Device Configuration'), keywords: ['role', 'position', 'power', 'display'] },
    { id: 'module-config', label: t('admin_commands.module_configuration', 'Module Configuration'), keywords: ['mqtt', 'telemetry', 'serial', 'modules'] },
    { id: 'admin-import-export', label: t('admin_commands.config_import_export', 'Import/Export'), keywords: ['backup', 'restore'] },
    { id: 'admin-node-management', label: t('admin_commands.node_favorites_ignored', 'Node Management'), keywords: ['favorites', 'ignored', 'reboot'] },
    { id: 'admin-auto-favorites', label: t('auto_favorite.nav', 'Automatic Favorites'), keywords: ['star', 'favourite'] },
  ];
}

/** One searchable page in the palette. */
export interface ConfigSurface {
  /** Stable, non-translated identity — used as a React key and in tests. */
  key: string;
  /** Translated page name, shown as the result group heading. */
  label: string;
  /** Router path to navigate to. The section id is appended as the hash. */
  path: string;
  items: NavItem[];
}

export interface ConfigSurfaceContext extends SettingsNavOptions {
  /**
   * The source whose tabs should be offered, or `null` when the palette is open
   * outside a source (the standalone global settings page).
   *
   * Per-source surfaces are omitted rather than guessed at: with several
   * sources configured, silently picking one and navigating there is worse than
   * not offering the result.
   */
  sourceId: string | null;
  /** Whether the current user may see the per-source Admin tab at all. */
  canUseAdmin?: boolean;
}

/**
 * Every surface the palette should search, in the order results are grouped.
 */
export function buildConfigSurfaces(t: Translate, context: ConfigSurfaceContext): ConfigSurface[] {
  const { sourceId, canUseAdmin = false, ...settingsOptions } = context;
  const surfaces: ConfigSurface[] = [];

  if (sourceId) {
    const base = `/source/${encodeURIComponent(sourceId)}`;
    surfaces.push({
      key: 'source-settings',
      label: t('nav.settings', 'Settings'),
      path: `${base}/settings`,
      items: settingsNavItems(t, { ...settingsOptions, mode: 'source' }),
    });
    surfaces.push({
      key: 'configuration',
      label: t('nav.configuration', 'Configuration'),
      path: `${base}/configuration`,
      items: configurationNavItems(t),
    });
    surfaces.push({
      key: 'automation',
      label: t('nav.automation', 'Automation'),
      path: `${base}/automation`,
      items: automationNavItems(t),
    });
    surfaces.push({
      key: 'notifications',
      label: t('nav.notifications', 'Notifications'),
      path: `${base}/notifications`,
      items: notificationsNavItems(t),
    });
    if (canUseAdmin) {
      surfaces.push({
        key: 'admin',
        label: t('nav.admin_commands', 'Admin'),
        path: `${base}/admin`,
        items: adminCommandsNavItems(t),
      });
    }
  }

  surfaces.push({
    key: 'global-settings',
    label: t('config_search.global_settings', 'Global Settings'),
    path: '/settings',
    items: settingsNavItems(t, { ...settingsOptions, mode: 'global' }),
  });

  return surfaces.filter((surface) => surface.items.length > 0);
}
