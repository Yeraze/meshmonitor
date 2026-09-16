/**
 * Allowed values for the enum-shaped user settings, and the one helper that
 * checks against them.
 *
 * These settings arrive from two places — a `localStorage` seed at mount and
 * the server settings response shortly after — and each path used to carry its
 * own hand-written copy of the valid list. That is why they disagreed: most
 * seeds allowlisted correctly while most server handlers did
 * `settings.x as SomeUnion`, which is not a check at all, just a promise to
 * the compiler. A stored `"foo"` reached component state as a value matching
 * neither branch of whatever consumed it, so the UI silently rendered its
 * else-case with no way to tell why.
 *
 * Raised reviewing #5018, where the same gap was about to be added for one
 * more setting. Fixing it per-setting would have left the duplication that
 * caused it, so the lists live here once and both paths read them.
 *
 * `preferredSortField` is the one that was unchecked on BOTH paths — nine
 * values, and nothing anywhere confirming the stored string is one of them.
 *
 * Adding an enum setting: put its values here, and use `pickSetting` at both
 * entry points. Nothing else should hardcode the list.
 */
import type { TemperatureUnit } from '../utils/temperature';
import type { SortField, SortDirection } from '../types/ui';
import type { NodeListStyle } from '../utils/nodeColor';
import type { IconStyle } from './IconStyleContext';
import type { SortOption as DashboardSortOption } from '../components/Dashboard/types';
import type {
  DistanceUnit,
  NodeHopsCalculation,
  PositionHistoryLineStyle,
  TimeFormat,
  DateFormat,
  MapPinStyle,
  MapPinColorMode,
} from './SettingsContext';

export const TEMPERATURE_UNITS = ['C', 'F'] as const satisfies readonly TemperatureUnit[];
export const DISTANCE_UNITS = ['km', 'mi'] as const satisfies readonly DistanceUnit[];
export const POSITION_HISTORY_LINE_STYLES = ['linear', 'spline'] as const satisfies readonly PositionHistoryLineStyle[];
export const TIME_FORMATS = ['12', '24'] as const satisfies readonly TimeFormat[];
export const DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'] as const satisfies readonly DateFormat[];
export const MAP_PIN_STYLES = ['meshmonitor', 'official'] as const satisfies readonly MapPinStyle[];
export const MAP_PIN_COLOR_MODES = ['node', 'hops'] as const satisfies readonly MapPinColorMode[];
export const NODE_LIST_STYLES = ['monochrome', 'meshtastic', 'importance'] as const satisfies readonly NodeListStyle[];
export const ICON_STYLES = ['lucide', 'emoji'] as const satisfies readonly IconStyle[];
export const SORT_DIRECTIONS = ['asc', 'desc'] as const satisfies readonly SortDirection[];
export const NODE_HOPS_CALCULATIONS = ['nodeinfo', 'traceroute', 'messages'] as const satisfies readonly NodeHopsCalculation[];
export const DASHBOARD_SORT_OPTIONS = [
  'custom',
  'node-asc',
  'node-desc',
  'type-asc',
  'type-desc',
] as const satisfies readonly DashboardSortOption[];
export const SORT_FIELDS = [
  'longName',
  'shortName',
  'id',
  'lastHeard',
  'snr',
  'battery',
  'hwModel',
  'hops',
  'uptime',
] as const satisfies readonly SortField[];

/**
 * Return `value` when it is one of `allowed`, otherwise null.
 *
 * Takes `unknown` on purpose. Both callers hand it something typed as `string`
 * that is really "whatever was in the database" or "whatever is in
 * localStorage", and a signature that accepted `string` would invite the same
 * cast this exists to remove.
 */
export function pickSetting<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Compile-time exhaustiveness.
 *
 * `satisfies readonly T[]` above rejects a value that is NOT in the union, but
 * says nothing about a union member missing from the list. That direction is
 * the dangerous one: add a value to a union, forget the list here, and
 * `pickSetting` quietly rejects a perfectly valid setting — the user's choice
 * silently reverts to the default with no error anywhere.
 *
 * Each line below fails to compile if its union has grown past its list.
 */
type Covers<Union extends string, List extends readonly string[]> =
  [Exclude<Union, List[number]>] extends [never] ? true : ['missing from list:', Exclude<Union, List[number]>];

export const _exhaustive: {
  temperatureUnit: Covers<TemperatureUnit, typeof TEMPERATURE_UNITS>;
  distanceUnit: Covers<DistanceUnit, typeof DISTANCE_UNITS>;
  positionHistoryLineStyle: Covers<PositionHistoryLineStyle, typeof POSITION_HISTORY_LINE_STYLES>;
  timeFormat: Covers<TimeFormat, typeof TIME_FORMATS>;
  dateFormat: Covers<DateFormat, typeof DATE_FORMATS>;
  mapPinStyle: Covers<MapPinStyle, typeof MAP_PIN_STYLES>;
  mapPinColorMode: Covers<MapPinColorMode, typeof MAP_PIN_COLOR_MODES>;
  nodeListStyle: Covers<NodeListStyle, typeof NODE_LIST_STYLES>;
  iconStyle: Covers<IconStyle, typeof ICON_STYLES>;
  sortDirection: Covers<SortDirection, typeof SORT_DIRECTIONS>;
  sortField: Covers<SortField, typeof SORT_FIELDS>;
  nodeHopsCalculation: Covers<NodeHopsCalculation, typeof NODE_HOPS_CALCULATIONS>;
  dashboardSortOption: Covers<DashboardSortOption, typeof DASHBOARD_SORT_OPTIONS>;
} = {
  temperatureUnit: true,
  distanceUnit: true,
  positionHistoryLineStyle: true,
  timeFormat: true,
  dateFormat: true,
  mapPinStyle: true,
  mapPinColorMode: true,
  nodeListStyle: true,
  iconStyle: true,
  sortDirection: true,
  sortField: true,
  nodeHopsCalculation: true,
  dashboardSortOption: true,
};
