/**
 * TracerouteParticipationPicker (Traceroute Strip Interactivity epic, phase
 * 2) — a native `<select>` letting the user choose which stored traceroute
 * (of the ones this node took part in, as an endpoint or as an intermediate
 * hop) the `TracerouteStrip` should render.
 *
 * Renders `null` when there are fewer than 2 entries — a single-entry
 * dropdown is chrome with no choice in it, and `MessagesTab` already knows
 * which single row to show without a picker.
 *
 * A native `<select>` rather than the hand-rolled dropdown pattern elsewhere
 * in `MessagesTab.tsx` (`showTracerouteChannelDropdown`): this is a flat
 * list of text labels, so `<select>` gets keyboard, screen-reader, and
 * mobile behaviour for free and adds no document-level click-outside
 * listener.
 *
 * See docs/internal/dev-notes/TRS_PHASE2_SPEC.md §6.3.
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { DeviceInfo } from '../../types/device';
import type { TimeFormat, DateFormat } from '../../contexts/SettingsContext';
import type { TracerouteParticipationEntry } from '../../services/api';
import { getNodeShortName } from '../../utils/nodeHelpers';
import { formatDateTime } from '../../utils/datetime';
import { UiIcon } from '../icons';
import styles from './TracerouteParticipationPicker.module.css';

/** The `<select>` value for the statistical aggregate. A string, because a
 *  `<select>` value is a string and every entry option is a numeric id — the two
 *  spaces cannot collide. */
export const STATISTICAL_OPTION_VALUE = 'statistical';

export interface TracerouteParticipationPickerProps {
  entries: TracerouteParticipationEntry[];
  /** id of the row currently in the strip; `null` while it comes from the poll row. */
  selectedId: number | null;
  onSelect: (id: number) => void;
  nodes: DeviceInfo[];
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  /** Present when the pair has an aggregate worth offering (>= 2 routes,
   *  SR_PHASE2_SPEC.md D14/S2). Absent leaves this component exactly as it was. */
  statistical?: { totalRoutes: number };
  statisticalSelected?: boolean;
  onSelectStatistical?: () => void;
}

/**
 * Builds one option's label: `${when} · ${endpoints} · ${hops}${relayed}`.
 * Exported as a pure helper so it is testable without rendering.
 */
// eslint-disable-next-line react-refresh/only-export-components -- #4381 pure helper co-located with its only consumer for focused unit testing; not a component
export function buildOptionLabel(
  entry: TracerouteParticipationEntry,
  nodes: DeviceInfo[],
  fmt: { timeFormat: TimeFormat; dateFormat: DateFormat; t: TFunction },
): string {
  const when = formatDateTime(new Date(entry.timestamp), fmt.timeFormat, fmt.dateFormat);
  const from = getNodeShortName(nodes, entry.fromNodeId);
  const to = getNodeShortName(nodes, entry.toNodeId);
  const endpoints = fmt.t('messages.traceroute_edge_endpoints', { from, to });
  const hops = entry.hopCount == null
    ? fmt.t('messages.traceroute_picker_no_route', 'no route')
    : fmt.t('messages.traceroute_picker_hops', { count: entry.hopCount });
  const relayed = entry.participation === 'hop'
    ? ' · ' + fmt.t('messages.traceroute_picker_relayed', 'relayed')
    : '';
  return `${when} · ${endpoints} · ${hops}${relayed}`;
}

export function TracerouteParticipationPicker({
  entries,
  selectedId,
  onSelect,
  nodes,
  timeFormat,
  dateFormat,
  statistical,
  statisticalSelected,
  onSelectStatistical,
}: TracerouteParticipationPickerProps) {
  const { t } = useTranslation();
  const selectId = useId();

  const optionCount = entries.length + (statistical ? 1 : 0);
  if (optionCount < 2) return null;

  return (
    <div className={styles.row}>
      <UiIcon name="route" size={14} />
      <label className={styles.label} htmlFor={selectId}>
        {t('messages.traceroute_picker_label', 'Traceroute')}
      </label>
      <select
        id={selectId}
        className={styles.select}
        aria-label={t('messages.traceroute_picker_aria', 'Choose which traceroute to display')}
        value={
          statisticalSelected
            ? STATISTICAL_OPTION_VALUE
            : selectedId != null ? String(selectedId) : ''
        }
        onChange={e => {
          if (e.target.value === STATISTICAL_OPTION_VALUE) onSelectStatistical?.();
          else onSelect(Number(e.target.value));
        }}
      >
        {/* Placeholder for the value="" state (the displayed row came from the
            poll, not the picker — it has no entry id). Without it a native
            <select> silently displays the FIRST option's label, implying a
            selection that was never made. Hidden so it can't be re-chosen. */}
        {selectedId == null && !statisticalSelected && (
          <option value="" hidden>
            {t('messages.traceroute_picker_latest', 'Latest')}
          </option>
        )}
        {/* Statistical option renders first — it summarises every dated entry
            below it, so it belongs at the top of the list (SR_PHASE2_SPEC.md
            D18). This leaves the entries' newest-first order untouched. */}
        {statistical && (
          <option value={STATISTICAL_OPTION_VALUE}>
            {t('messages.traceroute_picker_statistical', { count: statistical.totalRoutes })}
          </option>
        )}
        {entries.map(entry => (
          <option key={entry.id} value={entry.id}>
            {buildOptionLabel(entry, nodes, { timeFormat, dateFormat, t })}
          </option>
        ))}
      </select>
    </div>
  );
}
