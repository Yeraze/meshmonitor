import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MeshCoreMessage, MeshCoreActions, ConnectionStatus,
} from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import { MeshCoreNodeTelemetryConfig } from './MeshCoreNodeTelemetryConfig';
import TelemetryGraphs from '../TelemetryGraphs';
import { useAuth } from '../../contexts/AuthContext';

interface MeshCoreDirectMessagesViewProps {
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  /** Frontend basename — required for the per-node telemetry-config panel. */
  baseUrl?: string;
  /**
   * Owning source id. When set together with a 64-hex contact pubkey, the
   * per-node telemetry-retrieval config panel is rendered next to the
   * contact-detail panel.
   */
  sourceId?: string;
}

/** True when the publicKey is a real 64-char hex (i.e. not a synthetic / prefix key). */
function isRealNodeKey(key: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(key);
}

export const MeshCoreDirectMessagesView: React.FC<MeshCoreDirectMessagesViewProps> = ({
  messages,
  contacts,
  status,
  actions,
  baseUrl,
  sourceId,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canSend = hasPermission('messages', 'write');
  const canWriteNodes = hasPermission('nodes', 'write');
  const canRemoteAdmin = hasPermission('remote_admin', 'write');
  const [selected, setSelected] = useState<string | null>(null);

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;
  // CMD_RESET_PATH / CMD_SHARE_CONTACT / CMD_ADD_UPDATE_CONTACT are all
  // companion-only (firmware deviceType=1).
  const isCompanion = (status?.deviceType ?? 0) === 1;

  // Lazy-read the advanced path-edit toggle from /api/settings. Off by
  // default; flipping it on/off in the Settings tab takes effect on the
  // next mount. We don't subscribe to settings changes here — the panel
  // is mounted often enough that polling isn't worth the complexity.
  const [advancedPathEditEnabled, setAdvancedPathEditEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const base = (baseUrl ?? '').replace(/\/$/, '');
    fetch(`${base}/api/settings`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        const value = j?.data?.meshcoreAdvancedPathEdit ?? j?.meshcoreAdvancedPathEdit;
        setAdvancedPathEditEnabled(value === 'true' || value === '1' || value === true);
      })
      .catch(() => {
        /* leave default false on error */
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  // Contacts that have at least one DM thread (filtered on top).
  const contactsByKey = useMemo(() => {
    const map = new Map<string, MeshCoreContact>();
    for (const c of contacts) {
      if (c.publicKey) map.set(c.publicKey, c);
    }
    return map;
  }, [contacts]);

  // Inbound `contact_message` arrives with only `pubkey_prefix` (typically
  // 12 hex chars), while contacts and outbound messages use the full pubkey.
  // Canonicalize any prefix to the matching contact's full pubkey so a single
  // peer doesn't show up as two sidebar entries.
  const canonicalize = useMemo(() => {
    return (key: string): string => {
      if (!key) return key;
      if (contactsByKey.has(key)) return key;
      for (const c of contacts) {
        if (c.publicKey && c.publicKey.startsWith(key)) return c.publicKey;
      }
      return key;
    };
  }, [contacts, contactsByKey]);

  const keysMatch = (a: string, b: string): boolean => {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b) || b.startsWith(a);
  };

  // Phase 2 of the MeshCore channels feature tags every locally-sent channel
  // message with `toPublicKey = 'channel-${idx}'` so the per-channel filter in
  // MeshCoreChannelsView can group sent messages back into the right tab.
  // Those synthetic keys are NOT real DM peers and must not surface in the
  // DM sidebar / conversation list — filter them out everywhere the DM view
  // looks at toPublicKey / fromPublicKey.
  const isChannelPseudoKey = (k: string | null | undefined): boolean =>
    typeof k === 'string' && k.startsWith('channel-');

  const dmPeers = useMemo(() => {
    const peers = new Set<string>();
    for (const m of messages) {
      if (!m.toPublicKey) continue;
      if (isChannelPseudoKey(m.toPublicKey) || isChannelPseudoKey(m.fromPublicKey)) continue;
      if (selfKey && keysMatch(m.fromPublicKey, selfKey)) peers.add(canonicalize(m.toPublicKey));
      else if (selfKey && keysMatch(m.toPublicKey, selfKey)) peers.add(canonicalize(m.fromPublicKey));
      else {
        peers.add(canonicalize(m.fromPublicKey));
        peers.add(canonicalize(m.toPublicKey));
      }
    }
    // Always include all contacts so the user can start a new DM.
    for (const c of contacts) {
      if (c.publicKey && !isChannelPseudoKey(c.publicKey)) peers.add(c.publicKey);
    }
    // Drop the local node — DMing yourself is meaningless and the local node
    // sometimes appears in the contacts list as a side-effect of seeding.
    if (selfKey) {
      for (const key of Array.from(peers)) {
        if (keysMatch(key, selfKey)) peers.delete(key);
      }
    }
    return Array.from(peers);
  }, [messages, contacts, selfKey, canonicalize]);

  const filtered = useMemo(() => {
    if (!selected) return [];
    return messages.filter(m => {
      if (!m.toPublicKey) return false;
      if (isChannelPseudoKey(m.toPublicKey) || isChannelPseudoKey(m.fromPublicKey)) return false;
      if (selfKey && keysMatch(m.fromPublicKey, selfKey) && keysMatch(m.toPublicKey, selected)) return true;
      if (selfKey && keysMatch(m.toPublicKey, selfKey) && keysMatch(m.fromPublicKey, selected)) return true;
      // No selfKey known — fall back to either direction matching the selected peer.
      return keysMatch(m.fromPublicKey, selected) || keysMatch(m.toPublicKey, selected);
    });
  }, [messages, selected, selfKey]);

  return (
    <div className="meshcore-two-pane">
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.dms', 'Direct Messages')}</span>
          <span className="pane-count">{dmPeers.length}</span>
        </div>
        <div className="meshcore-list-pane-body">
          {dmPeers.length === 0 ? (
            <div className="meshcore-empty-state">
              {t('meshcore.no_contacts', 'No contacts yet')}
            </div>
          ) : dmPeers.map(key => {
            const c = contactsByKey.get(key);
            const name = c?.advName || c?.name || `${key.substring(0, 8)}…`;
            return (
              <button
                key={key}
                className={`mc-node-row ${selected === key ? 'selected' : ''}`}
                onClick={() => setSelected(key)}
              >
                <div className="mc-node-row-name">
                  <span>{name}</span>
                </div>
                <div className="mc-node-row-key">{key.substring(0, 20)}…</div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="meshcore-main-pane">
        {selected ? (
          <>
            <MeshCoreMessageStream
              messages={filtered}
              contacts={contacts}
              selfPublicKey={selfKey}
              disabled={!connected || !canSend}
              emptyText={t('meshcore.no_messages', 'No messages with this contact yet')}
              onSend={text => actions.sendMessage(text, selected)}
            />
            <div className="meshcore-detail-pane">
              <MeshCoreContactDetailPanel
                contact={contactsByKey.get(selected) ?? null}
                publicKey={selected}
                onResetPath={actions.resetContactPath}
                onShareContact={actions.shareContact}
                onSetOutPath={actions.setContactOutPath}
                canWriteNodes={canWriteNodes && connected}
                isCompanion={isCompanion}
                advancedPathEditEnabled={advancedPathEditEnabled}
                canRemoteAdmin={canRemoteAdmin && connected}
                remoteAdminActions={{
                  loginRemote: actions.loginRemote,
                  sendCliCommand: actions.sendCliCommand,
                  getRemoteAdminCapability: actions.getRemoteAdminCapability,
                  forgetRemoteCredential: actions.forgetRemoteCredential,
                }}
              />
              {!!sourceId && typeof baseUrl === 'string' && isRealNodeKey(selected) && (
                <>
                  <MeshCoreNodeTelemetryConfig
                    baseUrl={baseUrl}
                    sourceId={sourceId}
                    publicKey={selected}
                  />
                  <TelemetryGraphs nodeId={selected} baseUrl={baseUrl} />
                </>
              )}
            </div>
          </>
        ) : (
          <div className="meshcore-empty-state" style={{ alignSelf: 'center', margin: 'auto' }}>
            {t('meshcore.select_contact', 'Select a contact to start a DM')}
          </div>
        )}
      </div>
    </div>
  );
};
