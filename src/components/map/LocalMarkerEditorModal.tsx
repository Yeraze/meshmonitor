/**
 * LocalMarkerEditorModal — create/edit dialog for local map markers (#5686).
 *
 * Wraps the shared `<Modal />` (overlay, Escape, focus). A local marker is
 * stored in MeshMonitor only and never transmitted; the dialog says so, so
 * nobody mistakes it for the waypoint editor.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { UiIcon } from '../icons';
import {
  MAP_MARKER_COLORS, MAP_MARKER_ICONS, MAP_MARKER_LABEL_MAX, MAP_MARKER_DESCRIPTION_MAX,
  type MapMarker, type MapMarkerColor, type MapMarkerIcon, type MapMarkerInput,
} from '../../types/mapMarker';
import PinSourcePicker, { type PinSourceChoice } from './PinSourcePicker';
import styles from './LocalMarkerEditorModal.module.css';

const ICON_LABELS: Record<MapMarkerIcon, string> = {
  pin: 'Pin', star: 'Star', target: 'Target', antenna: 'Antenna', home: 'Home', warning: 'Warning',
};
const COLOR_LABELS: Record<MapMarkerColor, string> = {
  accent: 'Blue', success: 'Green', warning: 'Amber', error: 'Red', info: 'Teal', muted: 'Grey',
};

export interface LocalMarkerEditorModalProps {
  isOpen: boolean;
  initial?: MapMarker | null;
  defaultCoords?: { lat: number; lon: number } | null;
  onClose: () => void;
  onSave: (input: MapMarkerInput) => Promise<void>;
  /**
   * Which source the marker is stored on, for a surface with no implied
   * source (Map Analysis, #5685). Save stays off until one is chosen.
   */
  storingSource?: PinSourceChoice;
}

/** A map click gives ~15 decimals; 6 (about 0.1 m) is plenty and fits the field. */
const roundCoord = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6;

export default function LocalMarkerEditorModal({ isOpen, initial, defaultCoords, onClose, onSave, storingSource }: LocalMarkerEditorModalProps) {
  const { t } = useTranslation();
  const numberScope = useNumberInputScope();
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [altitude, setAltitude] = useState<number | null>(null);
  const [icon, setIcon] = useState<MapMarkerIcon>('pin');
  const [color, setColor] = useState<MapMarkerColor>('accent');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLabel(initial?.label ?? '');
    setDescription(initial?.description ?? '');
    setLat(roundCoord(initial?.latitude ?? defaultCoords?.lat));
    setLon(roundCoord(initial?.longitude ?? defaultCoords?.lon));
    setAltitude(initial?.altitude ?? null);
    setIcon(initial?.icon ?? 'pin');
    setColor(initial?.color ?? 'accent');
    setError(null);
    setSaving(false);
  }, [isOpen, initial, defaultCoords]);

  const sourceMissing = Boolean(storingSource) && !storingSource?.value;
  const canSave = !sourceMissing && label.trim().length > 0 && lat !== null && lon !== null && !numberScope.invalid && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        label: label.trim(), description: description.trim() || null,
        latitude: lat as number, longitude: lon as number, altitude, icon, color,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('localMarkers.saveFailed', 'Could not save the marker'));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="460px"
      title={initial ? t('localMarkers.editTitle', 'Edit local marker') : t('localMarkers.newTitle', 'New local marker')}>
      <NumberInputScope scope={numberScope}>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <p className={styles.note}>
            <UiIcon name="visibilityOff" size={14} />
            {t('localMarkers.editorNote', 'Saved in MeshMonitor only. It is never sent to the mesh. Anyone who can see this source\'s map can see it.')}
          </p>
          {storingSource && (
            <PinSourcePicker
              id="local-marker-source"
              label={t('mapPins.markerSourceLabel', 'Source')}
              placeholder={t('mapPins.chooseSource', 'Choose a source…')}
              hint={t('mapPins.markerSourceHint', 'The marker is kept with this source and shows on its maps. No radio sends it.')}
              hiddenNote={t(
                'mapPins.hiddenByFilter',
                'This source is not in the map\'s source filter, so the new pin will not show until you add it.',
              )}
              choice={storingSource}
            />
          )}
          <label className={styles.field}>
            <span>{t('localMarkers.label', 'Label')}</span>
            <input className={styles.input} value={label} maxLength={MAP_MARKER_LABEL_MAX} required autoFocus
              onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('localMarkers.description', 'Notes')}</span>
            <textarea className={styles.input} value={description} maxLength={MAP_MARKER_DESCRIPTION_MAX} rows={3}
              onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className={styles.row}>
            <label className={styles.field}>
              <span>{t('localMarkers.latitude', 'Latitude')}</span>
              <NumberInput className={styles.input} step="any" min={-90} max={90} value={lat}
                allowEmpty onChange={setLat} />
            </label>
            <label className={styles.field}>
              <span>{t('localMarkers.longitude', 'Longitude')}</span>
              <NumberInput className={styles.input} step="any" min={-180} max={180} value={lon}
                allowEmpty onChange={setLon} />
            </label>
          </div>
          <label className={styles.field}>
            <span>{t('localMarkers.altitude', 'Altitude (m, optional)')}</span>
            <NumberInput className={styles.input} step="any" min={-1000} max={100000} value={altitude}
              allowEmpty onChange={setAltitude} />
          </label>
          <div className={styles.row}>
            <label className={styles.field}>
              <span>{t('localMarkers.icon', 'Icon')}</span>
              <select className={styles.input} value={icon} onChange={(e) => setIcon(e.target.value as MapMarkerIcon)}>
                {MAP_MARKER_ICONS.map((k) => <option key={k} value={k}>{t(`localMarkers.icons.${k}`, ICON_LABELS[k])}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('localMarkers.color', 'Colour')}</span>
              <select className={styles.input} value={color} onChange={(e) => setColor(e.target.value as MapMarkerColor)}>
                {MAP_MARKER_COLORS.map((k) => <option key={k} value={k}>{t(`localMarkers.colors.${k}`, COLOR_LABELS[k])}</option>)}
              </select>
            </label>
          </div>
          {error && <div className={styles.error} role="alert">{error}</div>}
          <div className={styles.buttons}>
            <button type="button" onClick={onClose}>{t('common.cancel', 'Cancel')}</button>
            <button type="submit" className={styles.primary} disabled={!canSave}>
              {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </form>
      </NumberInputScope>
    </Modal>
  );
}
