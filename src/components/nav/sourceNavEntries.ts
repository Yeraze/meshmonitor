/**
 * The two per-source nav entries every source type shares (issue #5683).
 *
 * Each source type builds its own nav (Meshtastic's `Sidebar`, MeshCore's and
 * Reticulum's sub-toolbars), and each used to spell these two entries itself.
 * They drifted: the entry that opens the radio's own config read "Device" on
 * Meshtastic and "Configuration" on MeshCore and Reticulum, under one icon.
 *
 * The convention, defined once here so it cannot drift again:
 *
 * | Entry                | Icon            | Label                  | Opens                                          |
 * |----------------------|-----------------|------------------------|------------------------------------------------|
 * | Device Configuration | `configuration` | "Device Configuration" | settings held ON the radio and sent to it      |
 * | Settings             | `settings`      | "Settings"             | MeshMonitor's own behaviour for this source    |
 *
 * A nav must take the icon AND the label from here, never one of them.
 * `sourceNavEntries.convention.test.ts` fails a nav that spells either itself.
 *
 * Tab ids and permission gates stay with each nav: only the look is shared.
 */
import type { UiIconName } from '../icons';

type Translate = (key: string, fallback: string) => string;

export interface SharedSourceNavEntry {
  icon: UiIconName;
  /** Locale key of the full label: the rail, the tooltip, the accessible name. */
  labelKey: string;
  fallback: string;
  /**
   * Locale key of the label the phone bottom bar shows when the full one does
   * not fit its 120px tab. Omit when the full label fits.
   */
  shortLabelKey?: string;
  shortFallback?: string;
}

export const DEVICE_CONFIGURATION_NAV_ENTRY = {
  icon: 'configuration',
  labelKey: 'nav.device_configuration',
  fallback: 'Device Configuration',
  shortLabelKey: 'nav.device_configuration_short',
  shortFallback: 'Device Config',
} as const satisfies SharedSourceNavEntry;

export const SOURCE_SETTINGS_NAV_ENTRY = {
  icon: 'settings',
  labelKey: 'nav.settings',
  fallback: 'Settings',
} as const satisfies SharedSourceNavEntry;

/**
 * The install-wide settings page, as opposed to a source's own Settings.
 *
 * Three pages hold settings, sorted by what a control acts on (#5683
 * follow-up):
 *
 * | Page                 | Holds                                                    |
 * |----------------------|----------------------------------------------------------|
 * | Device Configuration | what is written to, or done on, the radio                |
 * | Settings             | what MeshMonitor stores and does for this one source     |
 * | Global Settings      | what applies to the whole install                        |
 *
 * A per-source gear is always "Settings". Any link that opens `/settings` is
 * "Global Settings", from this entry, so the two cannot be told apart only by
 * where they sit.
 */
export const GLOBAL_SETTINGS_NAV_ENTRY = {
  icon: 'settings',
  labelKey: 'nav.global_settings',
  fallback: 'Global Settings',
} as const satisfies SharedSourceNavEntry;

/** Router path of the Global Settings page. */
export const GLOBAL_SETTINGS_PATH = '/settings';

/** The presentation half of a `SourceNavItem`; the nav adds `id` and `onClick`. */
export interface SharedSourceNavPresentation {
  icon: UiIconName;
  label: string;
  shortLabel?: string;
}

export function sharedSourceNavPresentation(
  entry: SharedSourceNavEntry,
  t: Translate
): SharedSourceNavPresentation {
  return {
    icon: entry.icon,
    label: t(entry.labelKey, entry.fallback),
    ...(entry.shortLabelKey
      ? { shortLabel: t(entry.shortLabelKey, entry.shortFallback ?? entry.fallback) }
      : {}),
  };
}

/** Icon + label of the entry that opens the radio's own configuration. */
export const deviceConfigurationNav = (t: Translate): SharedSourceNavPresentation =>
  sharedSourceNavPresentation(DEVICE_CONFIGURATION_NAV_ENTRY, t);

/** Icon + label of the entry that opens MeshMonitor's settings for the source. */
export const sourceSettingsNav = (t: Translate): SharedSourceNavPresentation =>
  sharedSourceNavPresentation(SOURCE_SETTINGS_NAV_ENTRY, t);

/** Icon + label of a link that opens the install-wide Global Settings page. */
export const globalSettingsNav = (t: Translate): SharedSourceNavPresentation =>
  sharedSourceNavPresentation(GLOBAL_SETTINGS_NAV_ENTRY, t);
