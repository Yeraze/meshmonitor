import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../services/api';
import { QrCodeCanvas } from './common/QrCodeCanvas';
import { UiIcon } from './icons';
import styles from './MeshtasticContactShare.module.css';

interface MeshtasticContactShareProps {
  nodeNum: number;
  sourceId: string;
  nodeName: string;
}

export const MeshtasticContactShare: React.FC<MeshtasticContactShareProps> = ({
  nodeNum,
  sourceId,
  nodeName,
}) => {
  const { t } = useTranslation();
  const generationError = t(
    'node_details.contact_share.error',
    'Failed to generate contact URL',
  );
  const qrError = t(
    'node_details.contact_share.qr_error',
    'Failed to generate QR code',
  );
  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setUrl(null);
    setLoading(false);
    setError(null);
    setCopied(false);
  }, [nodeNum, sourceId]);

  useEffect(() => {
    if (!expanded) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setCopied(false);

    apiService.getMeshtasticContactUrl(nodeNum, sourceId)
      .then(contactUrl => {
        if (!cancelled) setUrl(contactUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setUrl(null);
          setError(generationError);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [expanded, nodeNum, sourceId, generationError]);

  const handleQrError = useCallback(() => {
    setError(qrError);
  }, [qrError]);

  const handleCopy = async () => {
    if (!url) return;

    setError(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = url;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        let copySucceeded = false;
        try {
          textArea.select();
          copySucceeded = document.execCommand('copy');
        } finally {
          document.body.removeChild(textArea);
        }
        if (!copySucceeded) throw new Error('Clipboard copy was rejected');
      }
      setCopied(true);
    } catch {
      setCopied(false);
      setError(t('node_details.contact_share.copy_error', 'Failed to copy contact URL'));
    }
  };

  return (
    <div className={`node-detail-card node-detail-card-2col ${styles.root}`}>
      <div className={styles.heading}>
        <div>
          <div className="node-detail-label">
            {t('node_details.contact_share.title', 'Share contact')}
          </div>
          <div className={styles.name}>{nodeName}</div>
          <div className={styles.summary}>
            {t(
              'node_details.contact_share.summary',
              'Create a Meshtastic contact QR code and URL for this node.',
            )}
          </div>
        </div>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded
            ? t('node_details.contact_share.hide', 'Hide')
            : t('node_details.contact_share.show', 'Create QR code')}
          <UiIcon name={expanded ? 'chevronUp' : 'chevronDown'} size={15} />
        </button>
      </div>

      {expanded && (
        <div className={styles.content}>
          {loading && (
            <div role="status" className={styles.status}>
              {t('node_details.contact_share.loading', 'Generating contact…')}
            </div>
          )}

          {error && (
            <div role="alert" className={styles.error}>
              {error}
            </div>
          )}

          {url && !loading && (
            <>
              <p className={styles.instructions}>
                {t(
                  'node_details.contact_share.instructions',
                  'Scan this QR code or open the URL in Meshtastic to add this node as a contact.',
                )}
              </p>
              <div className={styles.qr}>
                <QrCodeCanvas
                  value={url}
                  className={styles.canvas}
                  ariaLabel={t(
                    'node_details.contact_share.qr_label',
                    'Meshtastic contact QR code',
                  )}
                  onError={handleQrError}
                />
              </div>
              <div className={styles.urlRow}>
                <input
                  type="text"
                  className={styles.url}
                  value={url}
                  readOnly
                  aria-label={t(
                    'node_details.contact_share.url_label',
                    'Meshtastic contact URL',
                  )}
                />
                <button
                  type="button"
                  className={styles.copy}
                  onClick={() => void handleCopy()}
                >
                  <UiIcon name={copied ? 'check' : 'copy'} size={15} />
                  {copied
                    ? t('node_details.contact_share.copied', 'Copied')
                    : t('node_details.contact_share.copy', 'Copy URL')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
