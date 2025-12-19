import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './PositionOverrideModal.css';

interface Node {
  nodeNum: number;
  user?: {
    id: string;
    longName?: string;
    shortName?: string;
  };
}

interface PositionOverride {
  enabled: boolean;
  latitude?: number;
  longitude?: number;
  altitude?: number;
}

interface PositionOverrideModalProps {
  isOpen: boolean;
  selectedNode: Node | null;
  onClose: () => void;
  onSave: (nodeNum: number, data: PositionOverride) => Promise<void>;
  getNodeName: (nodeId: string) => string;
  baseUrl: string;
}

export const PositionOverrideModal: React.FC<PositionOverrideModalProps> = ({
  isOpen,
  selectedNode,
  onClose,
  onSave,
  getNodeName,
  baseUrl,
}) => {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [latitude, setLatitude] = useState<string>('');
  const [longitude, setLongitude] = useState<string>('');
  const [altitude, setAltitude] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validation state
  const [latError, setLatError] = useState<string | null>(null);
  const [lngError, setLngError] = useState<string | null>(null);

  // Track if we've loaded data for current modal session to prevent poll refresh from resetting
  const loadedForNodeRef = useRef<string | null>(null);

  // Extract node ID to use as stable dependency
  const nodeId = selectedNode?.user?.id;

  // Load current override when modal opens (only once per modal session)
  useEffect(() => {
    if (isOpen && nodeId && loadedForNodeRef.current !== nodeId) {
      loadedForNodeRef.current = nodeId;
      setLoading(true);
      setError(null);
      fetch(`${baseUrl}/api/nodes/${nodeId}/position-override`, {
        credentials: 'include',
      })
        .then(res => {
          if (res.ok) return res.json();
          throw new Error('Failed to load position override');
        })
        .then((data: PositionOverride) => {
          setEnabled(data.enabled);
          setLatitude(data.latitude?.toString() ?? '');
          setLongitude(data.longitude?.toString() ?? '');
          setAltitude(data.altitude?.toString() ?? '');
        })
        .catch(err => {
          console.error('Error loading position override:', err);
          // Reset to defaults if load fails
          setEnabled(false);
          setLatitude('');
          setLongitude('');
          setAltitude('');
        })
        .finally(() => setLoading(false));
    }
    // Reset the ref when modal closes so it reloads on next open
    if (!isOpen) {
      loadedForNodeRef.current = null;
    }
  }, [isOpen, nodeId, baseUrl]);

  // Reset error state when values change
  useEffect(() => {
    setError(null);
  }, [enabled, latitude, longitude, altitude]);

  if (!isOpen || !selectedNode) return null;

  const nodeName = selectedNode.user?.id ? getNodeName(selectedNode.user.id) : '';

  const validateLatitude = (value: string): boolean => {
    const num = parseFloat(value);
    if (isNaN(num) || num < -90 || num > 90) {
      setLatError(t('position_override.latitude_error'));
      return false;
    }
    setLatError(null);
    return true;
  };

  const validateLongitude = (value: string): boolean => {
    const num = parseFloat(value);
    if (isNaN(num) || num < -180 || num > 180) {
      setLngError(t('position_override.longitude_error'));
      return false;
    }
    setLngError(null);
    return true;
  };

  const handleSave = async () => {
    setError(null);

    // Validate if enabled
    if (enabled) {
      const latValid = validateLatitude(latitude);
      const lngValid = validateLongitude(longitude);
      if (!latValid || !lngValid) {
        return;
      }
    }

    setSaving(true);
    try {
      await onSave(selectedNode.nodeNum, {
        enabled,
        latitude: enabled ? parseFloat(latitude) : undefined,
        longitude: enabled ? parseFloat(longitude) : undefined,
        altitude: enabled && altitude ? parseFloat(altitude) : undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save position override');
    } finally {
      setSaving(false);
    }
  };

  const handleLatitudeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLatitude(e.target.value);
    if (e.target.value) {
      validateLatitude(e.target.value);
    } else {
      setLatError(null);
    }
  };

  const handleLongitudeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLongitude(e.target.value);
    if (e.target.value) {
      validateLongitude(e.target.value);
    } else {
      setLngError(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content position-override-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('position_override.title', { nodeName })}</h2>
          <button className="modal-close" onClick={onClose} disabled={saving}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div className="position-override-loading">
              {t('common.loading')}...
            </div>
          ) : (
            <>
              <p className="position-override-description">
                {t('position_override.description')}
              </p>

              <div className="position-override-checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => setEnabled(e.target.checked)}
                    disabled={saving}
                  />
                  {t('position_override.use_position')}
                </label>
              </div>

              {enabled && (
                <div className="position-override-fields">
                  <div className="position-override-field">
                    <label htmlFor="override-latitude">
                      {t('position_override.latitude')}
                      <span className="field-description">
                        {t('position_override.latitude_description')}
                      </span>
                    </label>
                    <input
                      id="override-latitude"
                      type="number"
                      step="0.000001"
                      min="-90"
                      max="90"
                      value={latitude}
                      onChange={handleLatitudeChange}
                      disabled={saving}
                      className={latError ? 'input-error' : ''}
                    />
                    {latError && <span className="error-message">{latError}</span>}
                  </div>

                  <div className="position-override-field">
                    <label htmlFor="override-longitude">
                      {t('position_override.longitude')}
                      <span className="field-description">
                        {t('position_override.longitude_description')}
                      </span>
                    </label>
                    <input
                      id="override-longitude"
                      type="number"
                      step="0.000001"
                      min="-180"
                      max="180"
                      value={longitude}
                      onChange={handleLongitudeChange}
                      disabled={saving}
                      className={lngError ? 'input-error' : ''}
                    />
                    {lngError && <span className="error-message">{lngError}</span>}
                  </div>

                  <div className="position-override-field">
                    <label htmlFor="override-altitude">
                      {t('position_override.altitude')}
                      <span className="field-description">
                        {t('position_override.altitude_description')}
                      </span>
                    </label>
                    <input
                      id="override-altitude"
                      type="number"
                      step="1"
                      value={altitude}
                      onChange={e => setAltitude(e.target.value)}
                      disabled={saving}
                    />
                  </div>

                  <div className="position-override-link">
                    <a
                      href="https://gps-coordinates.org/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('position_override.find_coordinates')}
                    </a>
                  </div>
                </div>
              )}

              {error && (
                <div className="position-override-error">
                  {error}
                </div>
              )}

              <div className="position-override-actions">
                <button
                  className="cancel-btn"
                  onClick={onClose}
                  disabled={saving}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="save-btn"
                  onClick={handleSave}
                  disabled={saving || (enabled && (latError !== null || lngError !== null))}
                >
                  {saving ? t('common.saving') : t('common.save')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
