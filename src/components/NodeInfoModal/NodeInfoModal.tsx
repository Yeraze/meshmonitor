import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './NodeInfoModal.css';

interface NodeInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  nodeInfo: {
    longName: string;
    shortName: string;
    nodeId: string;
  } | null;
  nodeIp: string;
  tcpPort: number;
  defaultIp: string;
  defaultPort: number;
  isOverridden: boolean;
  isAdmin: boolean;
  onChangeIp: (newIp: string) => Promise<void>;
}

export const NodeInfoModal: React.FC<NodeInfoModalProps> = ({
  isOpen,
  onClose,
  nodeInfo,
  nodeIp,
  tcpPort,
  defaultIp,
  defaultPort,
  isOverridden,
  isAdmin,
  onChangeIp,
}) => {
  const { t } = useTranslation();
  const [newAddress, setNewAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showIpForm, setShowIpForm] = useState(false);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setNewAddress('');
      setError(null);
      setSuccess(null);
      setShowIpForm(false);
    }
  }, [isOpen]);

  // Reset error/success when address changes
  useEffect(() => {
    setError(null);
    setSuccess(null);
  }, [newAddress]);

  if (!isOpen) return null;

  const validateAddress = (address: string): boolean => {
    // Allow IPv4 addresses or hostnames, with optional port
    // Accepts: 192.168.1.100, 192.168.1.100:4403, hostname, hostname:4403
    const addressRegex = /^(?:(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)|[\w.-]+)(?::\d{1,5})?$/;
    if (!addressRegex.test(address)) {
      return false;
    }
    // Validate port range if specified
    const portMatch = address.match(/:(\d+)$/);
    if (portMatch) {
      const port = parseInt(portMatch[1], 10);
      if (port < 1 || port > 65535) {
        return false;
      }
    }
    return true;
  };

  const handleSave = async () => {
    if (!newAddress.trim()) {
      setError(t('node_info.error_empty_ip'));
      return;
    }

    if (!validateAddress(newAddress.trim())) {
      setError(t('node_info.error_invalid_ip'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onChangeIp(newAddress.trim());
      setSuccess(t('node_info.success'));
      setNewAddress('');
      setShowIpForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('node_info.error_failed'));
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setNewAddress('');
    setError(null);
    setShowIpForm(false);
  };

  // Format address with port for display
  const currentAddress = `${nodeIp}:${tcpPort}`;
  const defaultAddress = `${defaultIp}:${defaultPort}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content node-info-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('node_info.title')}</h2>
          <button className="modal-close" onClick={onClose} disabled={saving}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          {/* Node Information Section */}
          <div className="node-info-section">
            <div className="node-info-row">
              <span className="node-info-label">{t('node_info.node_name')}</span>
              <span className="node-info-value">{nodeInfo?.longName || '-'}</span>
            </div>
            <div className="node-info-row">
              <span className="node-info-label">{t('node_info.short_name')}</span>
              <span className="node-info-value">{nodeInfo?.shortName || '-'}</span>
            </div>
            <div className="node-info-row">
              <span className="node-info-label">{t('node_info.node_id')}</span>
              <span className="node-info-value monospace">{nodeInfo?.nodeId || '-'}</span>
            </div>
          </div>

          {/* Connection Information Section */}
          <div className="node-info-section">
            <h3 className="node-info-section-title">{t('node_info.connection_section')}</h3>
            <div className="node-info-row">
              <span className="node-info-label">{t('node_info.address')}</span>
              <span className="node-info-value monospace">
                {currentAddress}
                {isOverridden && (
                  <span className="node-info-badge override-badge">{t('node_info.overridden')}</span>
                )}
              </span>
            </div>
            {isOverridden && (
              <div className="node-info-row">
                <span className="node-info-label">{t('node_info.default_address')}</span>
                <span className="node-info-value monospace muted">{defaultAddress}</span>
              </div>
            )}
          </div>

          {/* Admin Section - Change IP */}
          {isAdmin && (
            <div className="node-info-section admin-section">
              <h3 className="node-info-section-title">{t('node_info.change_address')}</h3>

              {/* Warning Banner */}
              <div className="node-info-warning">
                <div className="node-info-warning-title">{t('node_info.warning_title')}</div>
                <ul className="node-info-warning-list">
                  <li>{t('node_info.warning_no_purge')}</li>
                  <li>{t('node_info.warning_temporary')}</li>
                  <li>{t('node_info.warning_immediate')}</li>
                </ul>
              </div>

              {success && (
                <div className="node-info-success">
                  {success}
                </div>
              )}

              {!showIpForm ? (
                <button
                  className="change-ip-btn"
                  onClick={() => setShowIpForm(true)}
                  disabled={saving}
                >
                  {t('node_info.change_address_button')}
                </button>
              ) : (
                <div className="node-info-ip-form">
                  <div className="node-info-field">
                    <label htmlFor="new-address">{t('node_info.new_address')}</label>
                    <input
                      id="new-address"
                      type="text"
                      value={newAddress}
                      onChange={e => setNewAddress(e.target.value)}
                      placeholder={t('node_info.address_placeholder')}
                      disabled={saving}
                      className={error ? 'input-error' : ''}
                    />
                    {error && <span className="error-message">{error}</span>}
                  </div>

                  <div className="node-info-form-actions">
                    <button
                      className="cancel-btn"
                      onClick={handleCancelEdit}
                      disabled={saving}
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      className="save-btn"
                      onClick={handleSave}
                      disabled={saving || !newAddress.trim()}
                    >
                      {saving ? t('node_info.saving') : t('node_info.save')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Close Button */}
          <div className="node-info-actions">
            <button className="close-btn" onClick={onClose} disabled={saving}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
