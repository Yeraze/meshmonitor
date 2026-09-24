/**
 * CoverageReceiverFilter — scalable receiver picker for the Coverage Report
 * (#5277 Phase 2 WP4, spec §2.9). Replaces P1's flat checkbox list, which
 * doesn't scale to hundreds of MQTT gateways: a search box, select-all/none
 * (acting on the currently-searched rows), one collapsible group per source
 * with a three-state checkbox, a Local/Gateway kind badge per row, rows
 * sorted by `receptionCount` descending, and a 200-row-per-group cap with a
 * "Show all" escape hatch (no virtualisation library).
 *
 * Also renders the live per-source MQTT gateway-recording status (user
 * decision Q4): a Recording/Off badge per MQTT source the caller can read,
 * with a link to that source's Coverage recording settings section when
 * it's off. This block is independent of whether there are any receivers
 * yet — it must show in the empty state too — so it's rendered before the
 * receiver-picker trigger, which only appears once there's at least one
 * receiver to pick.
 *
 * MeshCore (#5277 Phase 3 WP3, spec §2.6): a receiver row whose `protocol`
 * is `'meshcore'` gets a MeshCore badge, and a `mqtt_gateway` MeshCore row
 * (an Observer feed) shows the kind badge "Observer" instead of "Gateway".
 * Ids display via `formatCoverageNodeId` (Meshtastic `!id` unchanged, a
 * MeshCore pubkey abbreviated) — search still matches the full raw id
 * (`matchesReceiverSearch` in `coverageReceiverGroups.ts` already substring
 * -matches `receiverId` verbatim, so a pubkey-prefix search needs no change
 * there). The MQTT status block labels a MeshCore observer source "Observer
 * recording" instead of "Recording" when it's on.
 *
 * `mqttSources` entries are typed against the WP2 DTO, which is gaining a
 * `protocol` field in a parallel work package (spec §4) — until that lands,
 * a missing field reads as `'meshtastic'` via the local `sourceProtocol`
 * helper below, so this component builds and behaves correctly either way.
 *
 * Pure grouping/search/sort logic lives in
 * `src/utils/coverageReceiverGroups.ts` (react-refresh/only-export-components
 * keeps this file component-only). Selection state (`deselected`, a Set of
 * `receiverKey(sourceId, receiverId)` composite keys — carry-over a) is
 * owned by the parent (`CoverageReport`); this component only ever proposes
 * a new Set via `onChange`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { UiIcon } from '../icons';
import { receiverKey } from '../../utils/coverageReceiverFilter';
import { formatCoverageNodeId } from '../../utils/coverage';
import {
  groupReceiversBySource,
  filterReceiverGroups,
  groupSelectionState,
  receiverSelectionSummary,
  RECEIVER_GROUP_CAP,
  type ReceiverGroup,
  type GroupSelectionState,
} from '../../utils/coverageReceiverGroups';
import type { CoverageReceiverDto, CoverageMqttSourceStatusDto, CoverageProtocol } from '../../types/coverage';
import styles from './CoverageReceiverFilter.module.css';

/**
 * `CoverageMqttSourceStatusDto` gains `protocol` in WP2 (parallel work
 * package, spec §4). Read it defensively so this component compiles and
 * behaves against both the pre- and post-WP2-merge shape; a source with no
 * `protocol` at all is a Meshtastic MQTT source (P2's only kind before P3).
 */
function sourceProtocol(s: CoverageMqttSourceStatusDto): CoverageProtocol {
  return (s as CoverageMqttSourceStatusDto & { protocol?: CoverageProtocol }).protocol ?? 'meshtastic';
}

interface CoverageReceiverFilterProps {
  receivers: CoverageReceiverDto[];
  /** Composite `receiverKey(sourceId, receiverId)` set of DESELECTED
   *  receivers. Default-all-selected: a receiver with no entry is on. */
  deselected: Set<string>;
  onChange: (next: Set<string>) => void;
  mqttSources: CoverageMqttSourceStatusDto[];
}

const GroupCheckbox: React.FC<{ state: GroupSelectionState; onToggle: () => void; label: string }> = ({
  state,
  onToggle,
  label,
}) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'partial';
  }, [state]);
  return <input ref={ref} type="checkbox" checked={state === 'all'} onChange={onToggle} aria-label={label} />;
};

export const CoverageReceiverFilter: React.FC<CoverageReceiverFilterProps> = ({
  receivers,
  deselected,
  onChange,
  mqttSources,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const allGroups = useMemo(() => groupReceiversBySource(receivers), [receivers]);
  const allGroupsBySourceId = useMemo(
    () => new Map(allGroups.map((g) => [g.sourceId, g] as const)),
    [allGroups],
  );
  const filteredGroups = useMemo(() => filterReceiverGroups(allGroups, query), [allGroups, query]);
  const summary = useMemo(() => receiverSelectionSummary(receivers, deselected), [receivers, deselected]);

  const toggleReceiver = (r: CoverageReceiverDto) => {
    const key = receiverKey(r.sourceId, r.receiverId);
    const next = new Set(deselected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  const toggleGroup = (group: ReceiverGroup, state: GroupSelectionState) => {
    const next = new Set(deselected);
    const selectAll = state !== 'all';
    for (const r of group.receivers) {
      const key = receiverKey(r.sourceId, r.receiverId);
      if (selectAll) next.delete(key);
      else next.add(key);
    }
    onChange(next);
  };

  const selectAllVisible = () => {
    const next = new Set(deselected);
    for (const g of filteredGroups) {
      for (const r of g.receivers) next.delete(receiverKey(r.sourceId, r.receiverId));
    }
    onChange(next);
  };

  const selectNoneVisible = () => {
    const next = new Set(deselected);
    for (const g of filteredGroups) {
      for (const r of g.receivers) next.add(receiverKey(r.sourceId, r.receiverId));
    }
    onChange(next);
  };

  const toggleCollapsed = (sourceId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  const expandGroup = (sourceId: string) => {
    setExpandedGroups((prev) => new Set(prev).add(sourceId));
  };

  const triggerLabel =
    summary.total > 0 && summary.selected === summary.total
      ? t('analysis.coverage.receivers_all', 'All receivers')
      : t('analysis.coverage.receivers_summary', 'Receivers: {{selected}} of {{total}}', {
          selected: summary.selected,
          total: summary.total,
        });

  return (
    <div className={styles.wrap}>
      {mqttSources.length > 0 && (
        <div className={styles.mqttStatus} data-testid="coverage-mqtt-status">
          {mqttSources.map((s) => (
            <div key={s.sourceId} className={styles.mqttStatusRow}>
              <span className={styles.mqttSourceName}>{s.sourceName}</span>
              <span className={s.recordingEnabled ? styles.badgeOn : styles.badgeOff}>
                {s.recordingEnabled
                  ? sourceProtocol(s) === 'meshcore'
                    ? t('analysis.coverage.observer_recording', 'Observer recording')
                    : t('analysis.coverage.mqtt_recording', 'Recording')
                  : t('analysis.coverage.mqtt_off', 'Off')}
              </span>
              {!s.recordingEnabled && (
                <Link
                  to={`/source/${encodeURIComponent(s.sourceId)}/settings#settings-coverage-mqtt`}
                  className={styles.mqttLink}
                >
                  {t('analysis.coverage.mqtt_turn_on', 'Turn on in source settings')}
                </Link>
              )}
            </div>
          ))}
        </div>
      )}

      {receivers.length > 0 && (
        <div className={styles.filterWrap}>
          <button
            type="button"
            className="reports-btn reports-btn--ghost"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <UiIcon name="filter" size={14} />
            {triggerLabel}
          </button>

          {open && (
            <div className={styles.panel}>
              <label className={styles.searchRow}>
                <UiIcon name="search" size={14} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('analysis.coverage.receivers_search_placeholder', 'Search by name or id')}
                  aria-label={t('analysis.coverage.receivers_search', 'Search receivers')}
                  className={styles.searchInput}
                />
              </label>

              <div className={styles.bulkRow}>
                <button type="button" className="reports-btn reports-btn--ghost" onClick={selectAllVisible}>
                  {t('analysis.coverage.receivers_select_all', 'Select all')}
                </button>
                <button type="button" className="reports-btn reports-btn--ghost" onClick={selectNoneVisible}>
                  {t('analysis.coverage.receivers_select_none', 'Select none')}
                </button>
              </div>

              <div className={styles.groups}>
                {filteredGroups.map((group) => {
                  const fullGroup = allGroupsBySourceId.get(group.sourceId) ?? group;
                  const state = groupSelectionState(fullGroup, deselected);
                  const fullSummary = receiverSelectionSummary(fullGroup.receivers, deselected);
                  const collapsed = collapsedGroups.has(group.sourceId);
                  const capped = !expandedGroups.has(group.sourceId) && group.receivers.length > RECEIVER_GROUP_CAP;
                  const visibleRows = capped ? group.receivers.slice(0, RECEIVER_GROUP_CAP) : group.receivers;

                  return (
                    <div key={group.sourceId} className={styles.group}>
                      <div className={styles.groupHeader}>
                        <button
                          type="button"
                          className={styles.collapseToggle}
                          onClick={() => toggleCollapsed(group.sourceId)}
                          aria-expanded={!collapsed}
                          aria-label={t('analysis.coverage.receivers_toggle_group', 'Toggle {{name}} group', {
                            name: group.sourceName,
                          })}
                        >
                          <UiIcon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
                        </button>
                        <GroupCheckbox
                          state={state}
                          onToggle={() => toggleGroup(fullGroup, state)}
                          label={group.sourceName}
                        />
                        <span className={styles.groupName}>{group.sourceName}</span>
                        <span className={styles.groupCount}>
                          {t('analysis.coverage.receivers_group_count', '{{selected}} of {{total}}', {
                            selected: fullSummary.selected,
                            total: fullSummary.total,
                          })}
                        </span>
                      </div>

                      {!collapsed && (
                        <>
                          <ul className={styles.rows}>
                            {visibleRows.map((r) => {
                              const key = receiverKey(r.sourceId, r.receiverId);
                              const label = r.longName || r.shortName || formatCoverageNodeId(r.receiverId);
                              const isMeshCore = r.protocol === 'meshcore';
                              const isGateway = r.receiverKind === 'mqtt_gateway';
                              const isObserver = isGateway && isMeshCore;
                              const kindLabel = isObserver
                                ? t('analysis.coverage.kind_observer', 'Observer')
                                : isGateway
                                  ? t('analysis.coverage.kind_gateway', 'Gateway')
                                  : t('analysis.coverage.kind_local', 'Local');
                              return (
                                <li key={key} className={styles.row}>
                                  <label className={styles.rowLabel}>
                                    <input
                                      type="checkbox"
                                      checked={!deselected.has(key)}
                                      onChange={() => toggleReceiver(r)}
                                      aria-label={label}
                                    />
                                    <span className={styles.rowName}>{label}</span>
                                    <span className={styles.rowId}>{formatCoverageNodeId(r.receiverId)}</span>
                                    <span className={isGateway ? styles.badgeGateway : styles.badgeLocal}>
                                      {kindLabel}
                                    </span>
                                    {isMeshCore && (
                                      <span className={styles.badgeMeshCore}>
                                        {t('analysis.coverage.protocol_meshcore', 'MeshCore')}
                                      </span>
                                    )}
                                    <span className={styles.rowCount}>{r.receptionCount}</span>
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                          {capped && (
                            <button
                              type="button"
                              className={`reports-btn reports-btn--ghost ${styles.showAllBtn}`}
                              onClick={() => expandGroup(group.sourceId)}
                            >
                              {t('analysis.coverage.receivers_show_all', 'Show all {{count}}', {
                                count: group.receivers.length,
                              })}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CoverageReceiverFilter;
