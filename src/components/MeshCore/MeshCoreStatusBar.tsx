import React from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';
import { UiIcon } from '../icons';
import { MeshCoreAdvertButtons } from './MeshCoreAdvertButtons';

interface MeshCoreStatusBarProps {
  status: ConnectionStatus | null;
  loading: boolean;
  onOpenSettings: () => void;
  actions: MeshCoreActions;
  /** When true, the parent renders the connection chip in its own header
   *  and we suppress the duplicate "Connected to X" text + dot here. */
  hideConnectionText?: boolean;
  /** True when this MeshCore source is in strict receive-only mode (#4547
   *  Phase 2). Plumbed here in WP1; WP3 wires the actual gating (Send advert
   *  disabled + tooltip, receive-only status chip). */
  receiveOnly?: boolean;
  /** False when the viewer may not drive the radio (#6524): not signed in, or
   *  no `connection:write` on this source. Advert, Flood advert, Disconnect
   *  and Connect all hit routes that check `requireAuth()` +
   *  `connection:write`, so the buttons are hidden rather than shown only to
   *  fail. Hiding them is not the access control; the routes are. */
  canControl?: boolean;
}

export const MeshCoreStatusBar: React.FC<MeshCoreStatusBarProps> = ({
  status,
  loading,
  onOpenSettings,
  actions,
  hideConnectionText,
  receiveOnly = false,
  canControl = true,
}) => {
  const { t } = useTranslation();
  const connected = status?.connected ?? false;
  const localName = status?.localNode?.name || t('meshcore.unknown', 'Unknown');

  return (
    <div className="meshcore-status-bar">
      <div className="meshcore-status-bar-left">
        {!hideConnectionText && (
          <>
            <span className={`status-dot ${connected ? 'connected' : ''}`} />
            <span className="status-text">
              {connected
                ? t('meshcore.connected_to', { name: localName, defaultValue: `Connected to ${localName}` })
                : t('meshcore.disconnected', 'Disconnected')}
            </span>
            {connected && status?.deviceTypeName && (
              <span className="status-meta">{status.deviceTypeName}</span>
            )}
          </>
        )}
        {receiveOnly && (
          <span className="mrc-status-chip mrc-status-idle">
            <UiIcon name="blocked" size={12} /> {t('meshcore.receive_only.status_chip', 'Receive-only')}
          </span>
        )}
      </div>
      {canControl && (
        <div className="meshcore-status-bar-right">
          {connected ? (
            <>
              <MeshCoreAdvertButtons
                onSend={(mode) => actions.sendAdvert(mode)}
                disabled={loading || receiveOnly}
                disabledTitle={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
              />
              <button
                className="disconnect"
                onClick={() => void actions.disconnect()}
                disabled={loading}
              >
                {t('meshcore.disconnect', 'Disconnect')}
              </button>
            </>
          ) : (
            <button onClick={onOpenSettings} disabled={loading}>
              {loading
                ? t('meshcore.connecting', 'Connecting…')
                : t('meshcore.connect', 'Connect')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
