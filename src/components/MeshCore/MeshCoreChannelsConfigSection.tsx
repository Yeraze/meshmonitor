/**
 * MeshCoreChannelsConfigSection — MeshCore-specific channel configuration UI.
 *
 * Why a separate component instead of extending `ChannelsConfigSection`:
 * the Meshtastic config section is 900+ lines built around drag-reorder of
 * a fixed 8-slot grid, plus role/uplink/downlink/positionPrecision semantics
 * that simply don't exist for MeshCore. MeshCore channels are
 * `{ channelIdx, name, secret(16B AES-128) }` and the count is device-
 * dependent. Forking keeps both flows readable; phase 1 already softened
 * the shared backend (`cleanupInvalidChannels`, the PUT/DELETE routes) to
 * branch by source type.
 *
 * Capabilities:
 *  - List the channels synced by `MeshCoreManager.syncChannelsFromDevice`.
 *  - Add a new channel (auto-assigns the lowest free index).
 *  - Rename, regenerate-secret (16-byte `crypto.getRandomValues`), or
 *    delete an existing channel.
 *  - Show the secret in hex with show/copy toggles (same masked-by-default
 *    UX as the Meshtastic PSK field).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';

interface MeshCoreChannelsConfigSectionProps {
  baseUrl: string;
  sourceId: string;
  /** When false (device not connected), the section is read-only with a notice. */
  canWrite: boolean;
}

interface ChannelRow {
  id: number;
  name: string;
  /** Raw base64 PSK from the server; only present when the caller has write
   *  permission to this channel (issue #2951). For MeshCore the underlying
   *  bytes are exactly 16. */
  psk?: string | null;
}

const SECRET_BYTES = 16;
const MAX_NAME_BYTES = 31;

// --- helpers ---------------------------------------------------------------

function base64ToHex(b64: string | null | undefined): string {
  if (!b64) return '';
  try {
    const bin = atob(b64);
    let out = '';
    for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return out;
  } catch {
    return '';
  }
}

function hexToBase64(hex: string): string {
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  if (clean.length % 2 !== 0) throw new Error('odd hex length');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const v = parseInt(clean.substring(i, i + 2), 16);
    if (Number.isNaN(v)) throw new Error('invalid hex');
    bytes[i / 2] = v;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function generateSecretHex(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function isValid16ByteHex(hex: string): boolean {
  const clean = hex.replace(/\s+/g, '');
  return /^[0-9a-fA-F]{32}$/.test(clean);
}

// --- component -------------------------------------------------------------

export const MeshCoreChannelsConfigSection: React.FC<MeshCoreChannelsConfigSectionProps> = ({
  baseUrl,
  sourceId,
  canWrite,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const canConfigure = canWrite && hasPermission('configuration', 'write');

  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editSecretHex, setEditSecretHex] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const { showToast } = useToast();

  const reload = useCallback(() => setReloadTick(v => v + 1), []);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const url = `${baseUrl}/api/channels/all?sourceId=${encodeURIComponent(sourceId)}`;
        const response = await csrfFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw = await response.json();
        const rows: ChannelRow[] = Array.isArray(raw)
          ? raw
              .filter((c: any) => typeof c?.id === 'number')
              .map((c: any) => ({
                id: c.id as number,
                name: String(c.name ?? ''),
                psk: typeof c.psk === 'string' ? c.psk : null,
              }))
              .sort((a, b) => a.id - b.id)
          : [];
        if (!cancelled) setChannels(rows);
      } catch (err) {
        if (!cancelled) logger.error('Failed to fetch MeshCore channels for config:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch, reloadTick]);

  // Find the smallest free channel index (starting at 0). Used by "Add channel".
  const nextFreeIdx = useMemo(() => {
    const used = new Set(channels.map(c => c.id));
    for (let i = 0; i < 256; i++) if (!used.has(i)) return i;
    return 255;
  }, [channels]);

  const startEdit = useCallback((row: ChannelRow) => {
    setEditingIdx(row.id);
    setEditName(row.name);
    setEditSecretHex(base64ToHex(row.psk));
    setShowSecret(false);
  }, []);

  const startAdd = useCallback(() => {
    setEditingIdx(nextFreeIdx);
    setEditName('');
    setEditSecretHex(generateSecretHex());
    setShowSecret(false);
  }, [nextFreeIdx]);

  const cancelEdit = useCallback(() => {
    setEditingIdx(null);
    setEditName('');
    setEditSecretHex('');
    setShowSecret(false);
  }, []);

  const handleRegenerate = useCallback(() => {
    setEditSecretHex(generateSecretHex());
  }, []);

  const handleCopySecret = useCallback(async () => {
    if (!editSecretHex) return;
    try {
      await navigator.clipboard.writeText(editSecretHex);
      showToast(t('meshcore.channels.secret_copied', 'Secret copied to clipboard'), 'success');
    } catch {
      showToast(t('meshcore.channels.secret_copy_failed', 'Failed to copy secret'), 'error');
    }
  }, [editSecretHex, showToast, t]);

  const handleSave = useCallback(async () => {
    if (editingIdx === null) return;
    const trimmedName = editName.trim();
    if (new TextEncoder().encode(trimmedName).length > MAX_NAME_BYTES) {
      showToast(t('meshcore.channels.name_too_long', 'Channel name must be {{max}} bytes or less', { max: MAX_NAME_BYTES }), 'error');
      return;
    }
    if (!isValid16ByteHex(editSecretHex)) {
      showToast(t('meshcore.channels.invalid_secret', 'Secret must be exactly 32 hex characters (16 bytes)'), 'error');
      return;
    }

    setSaving(true);
    try {
      const pskBase64 = hexToBase64(editSecretHex);
      const response = await csrfFetch(`${baseUrl}/api/channels/${editingIdx}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          psk: pskBase64,
          sourceId,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.success === false) {
        const msg = body?.error || `HTTP ${response.status}`;
        showToast(t('meshcore.channels.save_failed', 'Failed to save channel: {{msg}}', { msg }), 'error');
        return;
      }
      showToast(t('meshcore.channels.saved', 'Channel {{idx}} saved', { idx: editingIdx }), 'success');
      cancelEdit();
      reload();
    } catch (err) {
      logger.error('MeshCore channel save error:', err);
      showToast(t('meshcore.channels.save_failed_generic', 'Failed to save channel'), 'error');
    } finally {
      setSaving(false);
    }
  }, [editingIdx, editName, editSecretHex, baseUrl, sourceId, csrfFetch, showToast, t, cancelEdit, reload]);

  const handleDelete = useCallback(async (idx: number) => {
    if (!confirm(t('meshcore.channels.confirm_delete', 'Delete channel {{idx}}? This will remove it from the device.', { idx }))) {
      return;
    }
    try {
      const response = await csrfFetch(`${baseUrl}/api/channels/${idx}?sourceId=${encodeURIComponent(sourceId)}`, {
        method: 'DELETE',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.success === false) {
        const msg = body?.error || `HTTP ${response.status}`;
        showToast(t('meshcore.channels.delete_failed', 'Failed to delete channel: {{msg}}', { msg }), 'error');
        return;
      }
      showToast(t('meshcore.channels.deleted', 'Channel {{idx}} deleted', { idx }), 'success');
      reload();
    } catch (err) {
      logger.error('MeshCore channel delete error:', err);
      showToast(t('meshcore.channels.delete_failed_generic', 'Failed to delete channel'), 'error');
    }
  }, [baseUrl, sourceId, csrfFetch, showToast, t, reload]);

  return (
    <div className="form-section">
      <h3>{t('meshcore.channels.title', 'Channels')}</h3>
      <p className="hint">
        {t(
          'meshcore.channels.hint',
          'Channels on this MeshCore device. Each channel is a name plus a 16-byte (AES-128) shared secret.',
        )}
      </p>

      {loading && channels.length === 0 && (
        <div className="meshcore-empty-state" aria-busy="true">
          {t('meshcore.channels.loading_list', 'Loading channels…')}
        </div>
      )}

      {!loading && channels.length === 0 && (
        <div className="meshcore-empty-state">
          {t('meshcore.channels.empty', 'No channels reported by the device yet.')}
        </div>
      )}

      {channels.length > 0 && (
        <ul className="mc-channels-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {channels.map(row => {
            const isEditing = editingIdx === row.id;
            return (
              <li
                key={row.id}
                style={{
                  border: '1px solid var(--ctp-surface1)',
                  borderRadius: 6,
                  padding: '0.75rem',
                  marginBottom: '0.5rem',
                  backgroundColor: 'var(--ctp-surface0)',
                }}
              >
                {!isEditing && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 'bold' }}>
                        # {row.name || t('meshcore.channels.unnamed', 'Channel {{idx}}', { idx: row.id })}
                      </div>
                      <div className="hint" style={{ fontSize: '0.8rem' }}>
                        {t('meshcore.channels.idx_label', 'Index')}: {row.id}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      disabled={!canConfigure}
                    >
                      {t('common.edit', 'Edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(row.id)}
                      disabled={!canConfigure}
                      style={{ color: 'var(--ctp-red)' }}
                    >
                      {t('common.delete', 'Delete')}
                    </button>
                  </div>
                )}

                {isEditing && (
                  <ChannelEditor
                    idx={row.id}
                    name={editName}
                    onNameChange={setEditName}
                    secretHex={editSecretHex}
                    onSecretChange={setEditSecretHex}
                    showSecret={showSecret}
                    onToggleShowSecret={() => setShowSecret(v => !v)}
                    onRegenerate={handleRegenerate}
                    onCopy={handleCopySecret}
                    onSave={handleSave}
                    onCancel={cancelEdit}
                    saving={saving}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Inline "Add channel" editor (used when starting fresh without an existing row). */}
      {editingIdx !== null && !channels.some(c => c.id === editingIdx) && (
        <div
          style={{
            border: '1px dashed var(--ctp-blue)',
            borderRadius: 6,
            padding: '0.75rem',
            marginTop: '0.5rem',
            backgroundColor: 'var(--ctp-surface0)',
          }}
        >
          <div className="hint" style={{ marginBottom: '0.5rem' }}>
            {t('meshcore.channels.adding', 'Adding channel {{idx}}', { idx: editingIdx })}
          </div>
          <ChannelEditor
            idx={editingIdx}
            name={editName}
            onNameChange={setEditName}
            secretHex={editSecretHex}
            onSecretChange={setEditSecretHex}
            showSecret={showSecret}
            onToggleShowSecret={() => setShowSecret(v => !v)}
            onRegenerate={handleRegenerate}
            onCopy={handleCopySecret}
            onSave={handleSave}
            onCancel={cancelEdit}
            saving={saving}
          />
        </div>
      )}

      <div style={{ marginTop: '1rem' }}>
        <button
          type="button"
          onClick={startAdd}
          disabled={!canConfigure || editingIdx !== null}
        >
          {t('meshcore.channels.add', '+ Add channel')}
        </button>
      </div>
    </div>
  );
};

// --- editor sub-component (used inline for both edit + add) ---------------

interface ChannelEditorProps {
  idx: number;
  name: string;
  onNameChange: (v: string) => void;
  secretHex: string;
  onSecretChange: (v: string) => void;
  showSecret: boolean;
  onToggleShowSecret: () => void;
  onRegenerate: () => void;
  onCopy: () => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}

const ChannelEditor: React.FC<ChannelEditorProps> = ({
  idx,
  name,
  onNameChange,
  secretHex,
  onSecretChange,
  showSecret,
  onToggleShowSecret,
  onRegenerate,
  onCopy,
  onSave,
  onCancel,
  saving,
}) => {
  const { t } = useTranslation();
  return (
  <div>
    <div style={{ marginBottom: '0.5rem' }}>
      <label htmlFor={`mc-ch-name-${idx}`}>
        {t('meshcore.channels.name_label', 'Name')}
      </label>
      <input
        id={`mc-ch-name-${idx}`}
        type="text"
        value={name}
        onChange={e => onNameChange(e.target.value)}
        maxLength={MAX_NAME_BYTES}
        disabled={saving}
        style={{ width: '100%' }}
      />
    </div>
    <div style={{ marginBottom: '0.5rem' }}>
      <label htmlFor={`mc-ch-secret-${idx}`}>
        {t('meshcore.channels.secret_label', 'Secret (hex, 32 chars)')}
      </label>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input
          id={`mc-ch-secret-${idx}`}
          type={showSecret ? 'text' : 'password'}
          value={secretHex}
          onChange={e => onSecretChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={saving}
          style={{ flex: 1, fontFamily: 'monospace' }}
        />
        <button
          type="button"
          onClick={onToggleShowSecret}
          disabled={saving}
          aria-pressed={showSecret}
          title={showSecret
            ? t('meshcore.channels.hide_secret', 'Hide secret')
            : t('meshcore.channels.show_secret', 'Show secret')}
        >
          {showSecret ? t('common.hide', 'Hide') : t('common.show', 'Show')}
        </button>
        <button
          type="button"
          onClick={onCopy}
          disabled={saving || !secretHex}
        >
          {t('common.copy', 'Copy')}
        </button>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={saving}
          title={t('meshcore.channels.regen_title', 'Generate a new random secret')}
        >
          {t('meshcore.channels.regen', 'Regenerate')}
        </button>
      </div>
    </div>
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
      >
        {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={saving}
      >
        {t('common.cancel', 'Cancel')}
      </button>
    </div>
  </div>
  );
};

export default MeshCoreChannelsConfigSection;
