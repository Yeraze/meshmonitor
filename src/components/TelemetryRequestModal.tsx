import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import './TelemetryRequestModal.css';

export type TelemetryType = 'device' | 'environment' | 'airQuality' | 'power';

interface TelemetryRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRequest: (telemetryType: TelemetryType) => void;
  loading: boolean;
  nodeName: string;
}

const TelemetryRequestModal: React.FC<TelemetryRequestModalProps> = ({
  isOpen,
  onClose,
  onRequest,
  loading,
  nodeName,
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const telemetryTypes: { type: TelemetryType; icon: string; translationKey: string; description: string }[] = [
    { type: 'device', icon: '📱', translationKey: 'messages.telemetry_type_device', description: 'messages.telemetry_type_device_desc' },
    { type: 'environment', icon: '🌡️', translationKey: 'messages.telemetry_type_environment', description: 'messages.telemetry_type_environment_desc' },
    { type: 'airQuality', icon: '💨', translationKey: 'messages.telemetry_type_air_quality', description: 'messages.telemetry_type_air_quality_desc' },
    { type: 'power', icon: '⚡', translationKey: 'messages.telemetry_type_power', description: 'messages.telemetry_type_power_desc' },
  ];

  const modalContent = (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal-content telemetry-request-modal">
        <div className="modal-header">
          <h2>{t('messages.request_telemetry')}</h2>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="telemetry-modal-subtitle">
            {t('messages.select_telemetry_type', { nodeName })}
          </p>

          <div className="telemetry-types-list">
            {telemetryTypes.map(({ type, icon, translationKey, description }) => (
              <button
                key={type}
                className="telemetry-type-button"
                onClick={() => onRequest(type)}
                disabled={loading}
              >
                <span className="telemetry-type-icon">{icon}</span>
                <div className="telemetry-type-info">
                  <span className="telemetry-type-name">{t(translationKey)}</span>
                  <span className="telemetry-type-description">{t(description)}</span>
                </div>
                {loading && <span className="spinner"></span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default TelemetryRequestModal;
