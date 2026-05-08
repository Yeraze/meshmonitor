/**
 * WaypointEditorModal — create/edit dialog for waypoints.
 *
 * Fields: lat/lon (text inputs, with optional map-pick callback), name (≤30),
 * description (≤100), emoji (a small quick-pick + free text), expire
 * (datetime-local or "never"), locked_to (self / open), virtual toggle,
 * rebroadcast interval (numeric, optional).
 */
import { useEffect, useState } from 'react';
import type { Waypoint, WaypointInput } from '../types/waypoint';

const DEFAULT_EMOJIS = ['📍', '🏠', '🏕️', '⛺', '🚗', '🛟', '⚠️', '⭐', '🚩', '🛠️'];

export interface WaypointEditorModalProps {
  isOpen: boolean;
  initial?: Waypoint | null;
  /** Optional callback to enter map-pick mode for coordinates. */
  onPickLocation?: () => void;
  onClose: () => void;
  onSave: (input: WaypointInput) => Promise<void> | void;
  /** Local node's nodeNum, used when the user toggles "lock to me". */
  selfNodeNum?: number | null;
}

function expireSecondsToLocal(expire: number | null | undefined): string {
  if (expire === null || expire === undefined || expire === 0) return '';
  const d = new Date(expire * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToExpireSeconds(local: string): number | null {
  if (!local) return null;
  const ms = Date.parse(local);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

export default function WaypointEditorModal(props: WaypointEditorModalProps) {
  const { isOpen, initial, onPickLocation, onClose, onSave, selfNodeNum } = props;

  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('📍');
  const [expireLocal, setExpireLocal] = useState('');
  const [hasExpiry, setHasExpiry] = useState(false);
  const [lockToSelf, setLockToSelf] = useState(false);
  const [virtual, setVirtual] = useState(false);
  const [rebroadcast, setRebroadcast] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset form when opened or `initial` changes
  useEffect(() => {
    if (!isOpen) return;
    if (initial) {
      setLat(String(initial.latitude));
      setLon(String(initial.longitude));
      setName(initial.name ?? '');
      setDescription(initial.description ?? '');
      setEmoji(initial.iconEmoji ?? '📍');
      setHasExpiry(initial.expireAt != null && initial.expireAt > 0);
      setExpireLocal(expireSecondsToLocal(initial.expireAt));
      setLockToSelf(
        initial.lockedTo != null && selfNodeNum != null && initial.lockedTo === selfNodeNum,
      );
      setVirtual(Boolean(initial.isVirtual));
      setRebroadcast(initial.rebroadcastIntervalS ? String(initial.rebroadcastIntervalS) : '');
    } else {
      setLat('');
      setLon('');
      setName('');
      setDescription('');
      setEmoji('📍');
      setHasExpiry(false);
      setExpireLocal('');
      setLockToSelf(false);
      setVirtual(false);
      setRebroadcast('');
    }
    setError(null);
  }, [isOpen, initial, selfNodeNum]);

  if (!isOpen) return null;

  function validate(): WaypointInput | null {
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!Number.isFinite(latN) || latN < -90 || latN > 90) {
      setError('Latitude must be between -90 and 90');
      return null;
    }
    if (!Number.isFinite(lonN) || lonN < -180 || lonN > 180) {
      setError('Longitude must be between -180 and 180');
      return null;
    }
    if (name.length > 30) {
      setError('Name must be 30 characters or fewer');
      return null;
    }
    if (description.length > 100) {
      setError('Description must be 100 characters or fewer');
      return null;
    }
    let expire: number | null = null;
    if (hasExpiry) {
      const sec = localToExpireSeconds(expireLocal);
      if (!sec) {
        setError('Invalid expiration date/time');
        return null;
      }
      expire = sec;
    }
    let rebroadcastIntervalS: number | null = null;
    if (rebroadcast.trim().length > 0) {
      const r = Number(rebroadcast);
      if (!Number.isFinite(r) || r < 60) {
        setError('Rebroadcast interval must be at least 60 seconds');
        return null;
      }
      rebroadcastIntervalS = Math.floor(r);
    }
    return {
      lat: latN,
      lon: lonN,
      name: name.trim(),
      description: description.trim(),
      icon: emoji,
      expire,
      locked_to: lockToSelf && selfNodeNum != null ? selfNodeNum : null,
      virtual,
      rebroadcast_interval_s: rebroadcastIntervalS,
    };
  }

  async function handleSave() {
    const input = validate();
    if (!input) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(input);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal waypoint-editor" style={{ maxWidth: 480 }}>
        <h3>{initial ? 'Edit Waypoint' : 'New Waypoint'}</h3>

        <label>Latitude
          <input
            type="number"
            step="0.000001"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
          />
        </label>
        <label>Longitude
          <input
            type="number"
            step="0.000001"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
          />
        </label>
        {onPickLocation && (
          <button type="button" onClick={onPickLocation}>
            Pick on map…
          </button>
        )}

        <label>Name (≤30)
          <input
            type="text"
            maxLength={30}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>Description (≤100)
          <textarea
            maxLength={100}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <fieldset>
          <legend>Icon</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {DEFAULT_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setEmoji(e)}
                aria-pressed={emoji === e}
                style={{
                  padding: 6,
                  background: emoji === e ? '#dde' : 'transparent',
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                {e}
              </button>
            ))}
            <input
              type="text"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
              style={{ width: 60 }}
              aria-label="Custom emoji"
            />
          </div>
        </fieldset>

        <label>
          <input
            type="checkbox"
            checked={hasExpiry}
            onChange={(e) => setHasExpiry(e.target.checked)}
          /> Expires
        </label>
        {hasExpiry && (
          <label>Expire at
            <input
              type="datetime-local"
              value={expireLocal}
              onChange={(e) => setExpireLocal(e.target.value)}
            />
          </label>
        )}

        <label>
          <input
            type="checkbox"
            checked={lockToSelf}
            onChange={(e) => setLockToSelf(e.target.checked)}
            disabled={selfNodeNum == null}
          /> Lock to this node ({selfNodeNum != null ? `!${selfNodeNum.toString(16).padStart(8, '0')}` : 'unknown'})
        </label>

        <label>
          <input
            type="checkbox"
            checked={virtual}
            onChange={(e) => setVirtual(e.target.checked)}
          /> Virtual (do not broadcast)
        </label>

        <label>Rebroadcast interval (seconds, optional)
          <input
            type="number"
            min={60}
            value={rebroadcast}
            onChange={(e) => setRebroadcast(e.target.value)}
          />
        </label>

        {error && <div role="alert" style={{ color: '#c0392b' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
