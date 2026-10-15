/**
 * MeshCoreChannelsConfigSection — MeshCore-specific channel configuration UI.
 *
 * Why a separate component instead of extending `ChannelsConfigSection`:
 * the Meshtastic section is built around a fixed 8-slot grid with drag
 * reorder, plus role/uplink/downlink/positionPrecision semantics that don't
 * exist for MeshCore. MeshCore channels are
 * `{ channelIdx, name, secret(16B AES-128) }` and the count is device-
 * dependent. Both sections share the same editing model (#5829): cards that
 * open in place (`ConfigItemCard`), the shared `ChannelKeyField`, and a
 * "Save to device" per channel.
 *
 * Capabilities:
 *  - List the channels synced by `MeshCoreManager.syncChannelsFromDevice`.
 *  - Add a new channel (auto-assigns the lowest free index, never 0).
 *  - Rename, regenerate-secret (16-byte `crypto.getRandomValues`), or
 *    delete an existing channel.
 *  - Show the secret in hex, masked by default, with show/copy/generate.
 *  - Reorder the slots on the device (#5379, MeshCoreChannelReorderPanel).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';
import {
  deriveHashtagSecretHex,
  formatMeshCoreChannelName,
  isHashtagChannelName,
} from '../../utils/meshcoreHelpers';
import { pskEncryptionStatus } from '../../utils/publicChannel';
import { UiIcon } from '../icons';
import { MeshCoreChannelReorderPanel } from './MeshCoreChannelReorderPanel';
import { ConfigSection } from '../shared/config/ConfigSection';
import { ConfigItemCard, ConfigItemCardButton, type ConfigItemChip } from '../shared/config/ConfigItemCard';
import { ChannelKeyField } from '../shared/config/ChannelKeyField';
import { ChannelEncryptionLabel } from '../shared/config/ChannelEncryptionLabel';
import { DiscardChangesDialog } from '../shared/config/DiscardChangesDialog';
import { useDiscardGuard } from '../shared/config/useDiscardGuard';
import { base64ToHex, generateChannelKey, hexToBase64, isValidChannelKey } from '../shared/config/channelKey';
import { ConfirmDialog } from '../shared/automation/ConfirmDialog';
import { MESHCORE_DOCS } from './meshcoreDocs';
import styles from './MeshCoreChannelsConfigSection.module.css';

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
  /** MeshCore region/scope tag (#3667). Plain region name (no '#') or null =
   *  inherit the source default scope / unscoped. */
  scope?: string | null;
}

interface ChannelDraft {
  name: string;
  secretHex: string;
  scope: string;
}

interface EditingState {
  idx: number;
  isNew: boolean;
  draft: ChannelDraft;
  original: ChannelDraft;
}

const SECRET_BYTES = 16;
const SECRET_ALLOWED_BYTES = [SECRET_BYTES] as const;
const MAX_NAME_BYTES = 31;

/** MeshCore's implicit Public channel lives in slot 0 (#4733). */
const PUBLIC_SLOT = 0;

/**
 * True when slot 0 already reads as the stock Public channel (the synthetic
 * row the server keeps, or the firmware's own "Public"), so a reset would only
 * cost a device write. A blank name is the empty slot the firmware reports.
 */
function isStockPublicRow(row: ChannelRow): boolean {
  const name = row.name.trim().toLowerCase();
  return name === '' || name === 'public';
}

const draftsEqual = (a: ChannelDraft, b: ChannelDraft): boolean =>
  a.name === b.name && a.secretHex === b.secretHex && a.scope === b.scope;

// --- component -------------------------------------------------------------

export const MeshCoreChannelsConfigSection: React.FC<MeshCoreChannelsConfigSectionProps> = ({
  baseUrl,
  sourceId,
  canWrite,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const canWriteConfig = hasPermission('configuration', 'write', { sourceId });
  const canConfigure = canWrite && canWriteConfig;

  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmResetPublic, setConfirmResetPublic] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // "Reorder slots on device" mode (#5379): rewrites the companion's slots.
  const [reordering, setReordering] = useState(false);
  // Saved-regions catalog (#3770) — offered as scope-field suggestions so the
  // operator can pick a known region instead of typing it.
  const [savedRegions, setSavedRegions] = useState<string[]>([]);
  const { showToast } = useToast();

  const dirty = !!editing && (editing.isNew || !draftsEqual(editing.draft, editing.original));
  const discard = useDiscardGuard(dirty);

  const reload = useCallback(() => setReloadTick(v => v + 1), []);

  // Load the global saved-regions catalog for the scope-field datalist (#3770).
  // Cheap local DB read, independent of device connection.
  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/saved-regions`;
        const response = await csrfFetch(url);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data?.success && Array.isArray(data.regions)) {
          setSavedRegions(data.regions.map((r: any) => String(r.name)).filter(Boolean));
        }
      } catch {
        /* non-fatal — suggestions are optional */
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
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
                scope: typeof c.scope === 'string' ? c.scope : null,
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

  // Find the smallest free channel index, starting at 1 — slot 0 is reserved
  // for MeshCore's implicit "Public" channel and must never be offered as a
  // destination for a newly added channel (issue #4733). The server mirrors
  // this with a hard reject on writes to channel 0.
  const nextFreeIdx = useMemo(() => {
    const used = new Set(channels.map(c => c.id));
    for (let i = 1; i < 256; i++) if (!used.has(i)) return i;
    return 255;
  }, [channels]);

  const editName = editing?.draft.name ?? '';
  // A channel whose name starts with `#` is a hashtag channel: its secret is
  // derived from the name (SHA-256("#name")[0:16]) rather than randomized, so
  // it matches the well-known key everyone else on that public topic shares.
  const isHashtag = isHashtagChannelName(editName);

  const updateDraft = useCallback((patch: Partial<ChannelDraft>) => {
    setEditing(prev => (prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev));
  }, []);

  // Live-derive the secret whenever the (trimmed) name is a hashtag, mirroring
  // the official MeshCore app: typing `#general` deterministically yields the
  // shared key. Non-hashtag names keep whatever secret is in the field.
  const editingOpen = editing !== null;
  useEffect(() => {
    if (!editingOpen) return;
    const name = editName.trim();
    if (!name.startsWith('#')) return;
    let cancelled = false;
    void (async () => {
      try {
        const hex = await deriveHashtagSecretHex(name);
        if (!cancelled) updateDraft({ secretHex: hex });
      } catch (err) {
        if (!cancelled) logger.error('Failed to derive hashtag channel secret:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [editName, editingOpen, updateDraft]);

  const startEdit = (row: ChannelRow) => {
    const draft: ChannelDraft = { name: row.name, secretHex: base64ToHex(row.psk), scope: row.scope ?? '' };
    setEditing({ idx: row.id, isNew: false, draft, original: draft });
  };

  const startAdd = () => {
    const draft: ChannelDraft = { name: '', secretHex: generateChannelKey(SECRET_BYTES, 'hex'), scope: '' };
    setEditing({ idx: nextFreeIdx, isNew: true, draft, original: draft });
  };

  const cancelEdit = useCallback(() => setEditing(null), []);

  // One bridge write for this card, and only on an explicit click.
  const handleSave = useCallback(async () => {
    if (!editing) return;
    const { idx, draft } = editing;
    const trimmedName = draft.name.trim();
    if (new TextEncoder().encode(trimmedName).length > MAX_NAME_BYTES) {
      showToast(t('meshcore.channels.name_too_long', 'Channel name must be {{max}} bytes or less', { max: MAX_NAME_BYTES }), 'error');
      return;
    }

    // For hashtag channels the secret MUST be the deterministic
    // SHA-256("#name")[0:16] key — never the random placeholder set by
    // startAdd()/generate. The live-derive effect also computes this, but it
    // runs asynchronously, so a user who types "#bot" and saves quickly can
    // race ahead of it and persist the stale random secret (issue #3607).
    // Re-derive here at save time so the stored key is always deterministic.
    let secretHexToSave = draft.secretHex;
    if (isHashtagChannelName(trimmedName)) {
      try {
        secretHexToSave = await deriveHashtagSecretHex(trimmedName);
      } catch (err) {
        logger.error('Failed to derive hashtag channel secret on save:', err);
        showToast(t('meshcore.channels.invalid_secret', 'Secret must be exactly 32 hex characters (16 bytes)'), 'error');
        return;
      }
    }

    if (!isValidChannelKey(secretHexToSave, 'hex', SECRET_ALLOWED_BYTES)) {
      showToast(t('meshcore.channels.invalid_secret', 'Secret must be exactly 32 hex characters (16 bytes)'), 'error');
      return;
    }

    setSaving(true);
    try {
      const pskBase64 = hexToBase64(secretHexToSave);
      const response = await csrfFetch(`${baseUrl}/api/channels/${idx}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          psk: pskBase64,
          // Plain region name (no '#'); '' clears the scope (#3667).
          scope: draft.scope.trim().replace(/^#/, ''),
          sourceId,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.success === false) {
        const msg = body?.error || `HTTP ${response.status}`;
        showToast(t('meshcore.channels.save_failed', 'Failed to save channel: {{msg}}', { msg }), 'error');
        return;
      }
      showToast(t('meshcore.channels.saved', 'Channel {{idx}} saved', { idx }), 'success');
      setEditing(null);
      reload();
    } catch (err) {
      logger.error('MeshCore channel save error:', err);
      showToast(t('meshcore.channels.save_failed_generic', 'Failed to save channel'), 'error');
    } finally {
      setSaving(false);
    }
  }, [editing, baseUrl, sourceId, csrfFetch, showToast, t, reload]);

  const handleDelete = useCallback(async (idx: number) => {
    if (editing?.idx === idx) setEditing(null);
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
      showToast(idx === PUBLIC_SLOT
        ? t('meshcore.channels.reset_public_done', 'Slot 0 reset to the Public channel')
        : t('meshcore.channels.deleted', 'Channel {{idx}} deleted', { idx }), 'success');
      reload();
    } catch (err) {
      logger.error('MeshCore channel delete error:', err);
      showToast(t('meshcore.channels.delete_failed_generic', 'Failed to delete channel'), 'error');
    }
  }, [editing, baseUrl, sourceId, csrfFetch, showToast, t, reload]);

  const chipsFor = (row: ChannelRow): ConfigItemChip[] => {
    const chips: ConfigItemChip[] = [];
    if (row.id === PUBLIC_SLOT) {
      chips.push({ label: <ChannelEncryptionLabel status="default" defaultLabel={t('meshcore.channels.public_key', 'Public key')} /> });
    } else if (isHashtagChannelName(row.name)) {
      chips.push({
        label: <ChannelEncryptionLabel status="default" defaultLabel={t('meshcore.channels.hashtag_key', 'Hashtag key (public)')} />,
        title: t('meshcore.channels.hashtag_key_title', 'The key comes from the channel name, so anyone who knows the name can read it.'),
      });
    } else if (row.psk) {
      chips.push({ label: <ChannelEncryptionLabel status={pskEncryptionStatus(row.psk)} /> });
    }
    if (row.scope) {
      chips.push({
        label: <><UiIcon name="network" size={12} /> {t('meshcore.channels.scope_chip', 'Scope: {{scope}}', { scope: row.scope })}</>,
        tone: 'info',
        title: t('meshcore.channels.scope_label', 'Region / Scope (optional)'),
      });
    }
    return chips;
  };

  const renderEditor = (edit: EditingState) => (
    <>
      <div className={styles.field}>
        <label htmlFor={`mc-ch-name-${edit.idx}`}>
          {t('meshcore.channels.name_label', 'Name')}
        </label>
        <input
          id={`mc-ch-name-${edit.idx}`}
          type="text"
          className={`setting-input ${styles.input}`}
          value={edit.draft.name}
          onChange={e => updateDraft({ name: e.target.value })}
          maxLength={MAX_NAME_BYTES}
          disabled={saving}
        />
      </div>
      <ChannelKeyField
        id={`mc-ch-secret-${edit.idx}`}
        label={t('meshcore.channels.secret_label', 'Secret (hex, 32 chars)')}
        value={edit.draft.secretHex}
        onChange={secretHex => updateDraft({ secretHex })}
        format="hex"
        generateBytes={SECRET_BYTES}
        allowedBytes={isHashtag ? undefined : SECRET_ALLOWED_BYTES}
        invalidMessage={t('meshcore.channels.invalid_secret', 'Secret must be exactly 32 hex characters (16 bytes)')}
        readOnly={isHashtag}
        disabled={saving}
        hint={isHashtag ? t(
          'meshcore.channels.hashtag_derived',
          'Hashtag channel — secret is derived from the name (SHA-256) and shared by everyone using #{{name}}.',
          { name: edit.draft.name.trim().replace(/^#+/, '') },
        ) : undefined}
      />
      <div className={styles.field}>
        <label htmlFor={`mc-ch-scope-${edit.idx}`}>
          {t('meshcore.channels.scope_label', 'Region / Scope (optional)')}
        </label>
        <input
          id={`mc-ch-scope-${edit.idx}`}
          type="text"
          className={`setting-input ${styles.input}`}
          list={`mc-ch-scope-regions-${edit.idx}`}
          value={edit.draft.scope}
          onChange={e => updateDraft({ scope: e.target.value })}
          placeholder={t('meshcore.channels.scope_placeholder', 'e.g. muenchen — leave blank to inherit default')}
          spellCheck={false}
          autoComplete="off"
          disabled={saving}
          maxLength={63}
        />
        {savedRegions.length > 0 && (
          <datalist id={`mc-ch-scope-regions-${edit.idx}`}>
            {savedRegions.map(r => <option key={r} value={r} />)}
          </datalist>
        )}
        <p className={styles.hint}>
          {t(
            'meshcore.channels.scope_hint',
            'Messages on this channel are forwarded only by repeaters configured for this region. Blank uses the source default scope (or unscoped). Letters, digits and hyphens only.',
          )}
        </p>
      </div>
    </>
  );

  const renderFooter = (edit: EditingState) => () => {
    // A hashtag key is re-derived on save, so only a typed key is checked here.
    const keyOk = isHashtag || isValidChannelKey(edit.draft.secretHex, 'hex', SECRET_ALLOWED_BYTES);
    return (
      <>
        <ConfigItemCardButton onClick={cancelEdit} disabled={saving}>
          {t('common.cancel', 'Cancel')}
        </ConfigItemCardButton>
        <ConfigItemCardButton
          variant="primary"
          onClick={() => { void handleSave(); }}
          disabled={saving || !canConfigure || !keyOk || (!edit.isNew && !dirty)}
        >
          <UiIcon name="save" size={14} />
          {saving ? t('common.saving', 'Saving…') : t('meshcore.channels.save_to_device', 'Save to device')}
        </ConfigItemCardButton>
      </>
    );
  };

  const publicRow = channels.find(c => c.id === PUBLIC_SLOT);

  return (
    <ConfigSection
      id="meshcore-channels"
      title={t('meshcore.channels.title', 'Channels')}
      docsUrl={`${MESHCORE_DOCS}#channels`}
      canWrite={canWriteConfig}
      description={t(
        'meshcore.channels.hint',
        'Channels on this MeshCore device. Each channel is a name plus a 16-byte (AES-128) shared secret. Name a channel with a leading "#" (e.g. #general) to join a public hashtag channel — its secret is derived from the name so it matches everyone else on that topic.',
      )}
    >

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

      {reordering && (
        <MeshCoreChannelReorderPanel
          baseUrl={baseUrl}
          sourceId={sourceId}
          channels={channels.filter(c => c.id >= 1).map(c => ({ id: c.id, name: c.name }))}
          onFinished={reload}
          onClose={() => setReordering(false)}
        />
      )}

      {!reordering && channels.length > 0 && (
        <div className={styles.list}>
          {channels.map(row => {
            const isEditing = editing !== null && !editing.isNew && editing.idx === row.id;
            const title = formatMeshCoreChannelName(
              row.name,
              t('meshcore.channels.unnamed', 'Channel {{idx}}', { idx: row.id }),
            );
            if (row.id === PUBLIC_SLOT) {
              // Slot 0 is MeshCore's Public channel: the server refuses writes
              // to it (#4733), so there is no Edit (#5826). A slot 0 that holds
              // something else can be reset, which is the DELETE the server
              // still allows for slot 0.
              return (
                <ConfigItemCard
                  key={row.id}
                  testId="mc-channel-card"
                  leading={t('meshcore.channels.slot_badge', 'Slot {{idx}}', { idx: row.id })}
                  title={title}
                  summary={
                    <span data-testid="mc-public-slot-hint">
                      {t('meshcore.channels.public_slot_hint', 'Public channel, fixed by the firmware')}
                    </span>
                  }
                  chips={chipsFor(row)}
                  expanded={false}
                  actions={!isStockPublicRow(row) ? (
                    <ConfigItemCardButton
                      variant="danger"
                      onClick={() => setConfirmResetPublic(true)}
                      disabled={!canConfigure}
                    >
                      {t('meshcore.channels.reset_public', 'Reset to Public')}
                    </ConfigItemCardButton>
                  ) : undefined}
                />
              );
            }
            return (
              <ConfigItemCard
                key={row.id}
                testId="mc-channel-card"
                leading={t('meshcore.channels.slot_badge', 'Slot {{idx}}', { idx: row.id })}
                title={title}
                chips={chipsFor(row)}
                expanded={isEditing}
                disabled={!canConfigure}
                onEdit={() => discard.guard(() => startEdit(row))}
                onDelete={() => { void handleDelete(row.id); }}
                deleteTitle={t('meshcore.channels.delete_title', 'Delete channel {{idx}}?', { idx: row.id })}
                deleteMessage={t('meshcore.channels.delete_message', 'This removes the channel from the device.')}
                deletePreview={title}
                footer={isEditing && editing ? renderFooter(editing) : undefined}
              >
                {isEditing && editing && renderEditor(editing)}
              </ConfigItemCard>
            );
          })}
        </div>
      )}

      {!reordering && editing?.isNew && (
        <ConfigItemCard
          testId="mc-channel-card-new"
          leading={t('meshcore.channels.slot_badge', 'Slot {{idx}}', { idx: editing.idx })}
          title={t('meshcore.channels.adding', 'Adding channel {{idx}}', { idx: editing.idx })}
          expanded
          footer={renderFooter(editing)}
        >
          {renderEditor(editing)}
        </ConfigItemCard>
      )}

      {!reordering && (
        <div className={styles.addBar}>
          <ConfigItemCardButton
            onClick={() => discard.guard(startAdd)}
            disabled={!canConfigure || !!editing?.isNew}
            data-testid="mc-channel-add"
          >
            <UiIcon name="plus" size={14} /> {t('meshcore.channels.add', 'Add channel')}
          </ConfigItemCardButton>
          <ConfigItemCardButton
            onClick={() => discard.guard(() => { setEditing(null); setReordering(true); })}
            disabled={!canConfigure || !channels.some(c => c.id >= 1)}
            title={t('meshcore.channels.reorder.button_title', 'Change the order of the channel slots stored on the device')}
            data-testid="mc-reorder-open"
          >
            {t('meshcore.channels.reorder.button', 'Reorder slots on device')}
          </ConfigItemCardButton>
        </div>
      )}

      <DiscardChangesDialog guard={discard} />

      {confirmResetPublic && publicRow && (
        <ConfirmDialog
          title={t('meshcore.channels.reset_public_title', 'Reset slot 0 to Public?')}
          message={t('meshcore.channels.confirm_reset_public', 'Clear slot 0 on the device so it goes back to the Public channel? Whatever channel is in slot 0 now will be removed.')}
          preview={formatMeshCoreChannelName(publicRow.name, t('meshcore.channels.unnamed', 'Channel {{idx}}', { idx: 0 }))}
          confirmLabel={t('meshcore.channels.reset_public', 'Reset to Public')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onCancel={() => setConfirmResetPublic(false)}
          onConfirm={() => {
            setConfirmResetPublic(false);
            void handleDelete(PUBLIC_SLOT);
          }}
        />
      )}
    </ConfigSection>
  );
};

export default MeshCoreChannelsConfigSection;
