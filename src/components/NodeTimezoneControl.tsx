import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from './ToastContainer';
import { listTimeZones, useSetNodeTimezone, type NodeTimezone } from '../hooks/useNodeTimezone';
import styles from './NodeTimezoneControl.module.css';

interface NodeTimezoneControlProps {
  baseUrl?: string;
  sourceId: string | null | undefined;
  nodeId: string;
  /** The node's resolved zone; nothing renders until it is known. */
  timezone: NodeTimezone | null | undefined;
  /** Caption only, never the override picker (e.g. Dashboard charts). */
  readOnly?: boolean;
}

/**
 * The zone a node's charts are drawn in, and (with `nodes:write` on the
 * source) a Timezone Override picker (#6523). Shared by Meshtastic and MeshCore
 * node views through `TelemetryGraphs`.
 */
const NodeTimezoneControl: React.FC<NodeTimezoneControlProps> = ({ baseUrl = '', sourceId, nodeId, timezone, readOnly = false }) => {
  const { t } = useTranslation();
  if (!timezone) return null;

  const sourceLabel = t(`telemetry.timezone_source_${timezone.source}`);
  return (
    <div className={styles.timezone}>
      <span className={styles.caption}>
        {t('telemetry.timezone_caption', { zone: timezone.timeZone, source: sourceLabel })}
      </span>
      {!readOnly && sourceId && (
        <OverridePicker baseUrl={baseUrl} sourceId={sourceId} nodeId={nodeId} timezone={timezone} />
      )}
    </div>
  );
};

interface OverridePickerProps {
  baseUrl: string;
  sourceId: string;
  nodeId: string;
  timezone: NodeTimezone;
}

/** The override select, shown only to a user with `nodes:write` on the source. */
const OverridePicker: React.FC<OverridePickerProps> = ({ baseUrl, sourceId, nodeId, timezone }) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const setTimezone = useSetNodeTimezone(baseUrl);
  const canEdit = hasPermission('nodes', 'write', { sourceId });
  const override = timezone.source === 'override' ? timezone.timeZone : '';

  const zones = useMemo(() => {
    if (!canEdit) return [];
    const list = listTimeZones();
    // The server stores its own spelling, which this browser may list under
    // another name (Asia/Calcutta vs Asia/Kolkata): keep it selectable.
    return override && !list.includes(override) ? [override, ...list] : list;
  }, [canEdit, override]);

  if (!canEdit) return null;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setTimezone.mutate(
      { sourceId, nodeId, timeZone: e.target.value || null },
      { onError: () => showToast(t('telemetry.timezone_save_failed'), 'error') },
    );
  };

  return (
    <label className={styles.override}>
      <span>{t('telemetry.timezone_override')}</span>
      <select className={styles.select} value={override} onChange={handleChange} disabled={setTimezone.isPending}>
        <option value="">{t('telemetry.timezone_automatic')}</option>
        {zones.map(zone => (
          <option key={zone} value={zone}>{zone}</option>
        ))}
      </select>
    </label>
  );
};

export default NodeTimezoneControl;
