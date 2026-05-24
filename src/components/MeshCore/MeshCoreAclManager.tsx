/**
 * MeshCoreAclManager
 *
 * Structured form for the most common MeshCore Repeater / Room Server
 * admin operation: granting or revoking ACL entries via `setperm`.
 *
 * Why a form instead of just letting the user type `setperm` into the
 * console? Typing 64 hex chars by hand is error-prone, and getting the
 * permission level number wrong silently grants the wrong access. The
 * form validates the pubkey shape and surfaces the level names so the
 * user picks a level rather than memorizing 0/1/2/3.
 *
 * Result routing: the form has no transcript of its own — it pushes
 * the built `setperm <pubkey> <level>` command through the parent's
 * shared CliConsoleBody handle so the command + reply appear inline
 * with whatever else the user typed in the console.
 *
 * No list view in v1. The firmware's `get acl` command is serial-only
 * (works on a directly-connected Repeater but not over the mesh), and
 * the structured `GetAccessList` binary request isn't wrapped in
 * meshcore.js yet. A user can still type `get acl` manually into the
 * local console for a Repeater they're physically attached to.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CliConsoleBodyHandle } from './CliConsoleBody';
import './MeshCoreAclManager.css';

/** Permission levels recognized by MeshCore's `setperm` command.
 *  Mapping from the firmware (CommonCLI.cpp handleCommand):
 *    0 — remove the ACL entry (revoke all access)
 *    1 — guest (read-only stats / telemetry)
 *    2 — read-write (room servers only — can post)
 *    3 — admin (full control, including ACL management)
 */
const PERMISSION_LEVELS = [
  { value: 0, key: 'remove',    defaultLabel: 'Remove (revoke access)' },
  { value: 1, key: 'guest',     defaultLabel: 'Guest (read-only)' },
  { value: 2, key: 'readwrite', defaultLabel: 'Read/Write (room servers)' },
  { value: 3, key: 'admin',     defaultLabel: 'Admin (full control)' },
] as const;

interface MeshCoreAclManagerProps {
  /** Imperative handle into the sibling CliConsoleBody. The form pushes
   *  its built command through this so the result lands in the console
   *  transcript, exactly as if the user had typed it. */
  bodyRef: React.RefObject<CliConsoleBodyHandle | null>;
  /** Disables the form (e.g. remote console: !loggedIn). */
  disabled?: boolean;
}

export const MeshCoreAclManager: React.FC<MeshCoreAclManagerProps> = ({
  bodyRef,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [pubkey, setPubkey] = useState('');
  const [level, setLevel] = useState<number>(1);
  const [busy, setBusy] = useState(false);

  const normalized = pubkey.trim().toLowerCase();
  const valid = /^[0-9a-f]{64}$/.test(normalized);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || disabled || busy) return;
    setBusy(true);
    try {
      await bodyRef.current?.runCommand(`setperm ${normalized} ${level}`);
      // Clear the pubkey on success so the user doesn't accidentally
      // apply a different level to the same key without re-pasting.
      setPubkey('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="meshcore-acl-manager" aria-label={t('meshcore.acl.title', 'Manage access list')}>
      <h4 className="acl-title">{t('meshcore.acl.title', 'Manage access list')}</h4>
      <p className="acl-hint">
        {t(
          'meshcore.acl.hint',
          'Grant or revoke admin / guest access for a specific public key. Translates to a `setperm` command.',
        )}
      </p>
      <form className="acl-form" onSubmit={handleSubmit}>
        <label className="acl-field">
          <span className="acl-field-label">{t('meshcore.acl.pubkey_label', 'Public key (64 hex)')}</span>
          <input
            type="text"
            value={pubkey}
            onChange={(e) => setPubkey(e.target.value)}
            placeholder="0123456789abcdef…"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled || busy}
            className={`acl-input acl-pubkey-input${pubkey.length > 0 && !valid ? ' acl-input-invalid' : ''}`}
          />
          {pubkey.length > 0 && !valid && (
            <span className="acl-error-hint">
              {t('meshcore.acl.pubkey_invalid', 'Must be exactly 64 hex characters')}
            </span>
          )}
        </label>
        <label className="acl-field">
          <span className="acl-field-label">{t('meshcore.acl.level_label', 'Permission level')}</span>
          <select
            value={level}
            onChange={(e) => setLevel(parseInt(e.target.value, 10))}
            disabled={disabled || busy}
            className="acl-input"
          >
            {PERMISSION_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {t(`meshcore.acl.level.${l.key}`, l.defaultLabel)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="mrc-btn-primary"
          disabled={disabled || busy || !valid}
        >
          {busy
            ? t('meshcore.acl.applying', 'Applying…')
            : t('meshcore.acl.apply', 'Apply')}
        </button>
      </form>
    </section>
  );
};
