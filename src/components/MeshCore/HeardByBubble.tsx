/**
 * HeardByBubble (#6193).
 *
 * The shared "heard by" badge for one of our MeshCore sends. It replaces the
 * old per-stream antenna badge + "Sent to Radio" status: it shows an antenna
 * icon from the moment the message is sent (count 0), and expands to the list
 * of repeaters that relayed it.
 *
 * With a Required Repeaters list set, every required repeater is pinned at the
 * top — a green ✓ (heard, with hops/SNR) or a red ✗ (not relayed yet) — and any
 * other repeater heard follows below with a ✓. The count beside the antenna is
 * the number of GREEN ✓ rows only: a required repeater still showing ✗ does not
 * count. The ✓ decision reuses the same unique-prefix `requiredRepeaterHeard`
 * matcher as the resend gate, so the badge and the gate agree by construction.
 *
 * Designed to be general (channel sends today, DMs in #6194): it takes the
 * heard-by rows, the required keys + mode, and the candidate relays, and owns
 * its own expand state. Colours come from `var(--color-*)` role tokens only.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import {
  sortHeardBy,
  requiredRepeaterHeard,
  type RequiredRepeaterMode,
} from '../../utils/meshcoreHeardBy';
import styles from './HeardByBubble.module.css';

/** One repeater hearing of a send: a path-hash prefix plus optional metadata. */
export interface HeardByBubbleEntry {
  hash: string;
  name?: string | null;
  snr?: number | null;
  hops?: number | null;
}

/** A candidate relay the required-key matcher resolves prefixes against. */
export interface HeardByBubbleRepeater {
  publicKey: string;
  advType?: number | null;
  name?: string | null;
}

export interface HeardByBubbleProps {
  heardBy?: ReadonlyArray<HeardByBubbleEntry> | null;
  /** Full public-key hex strings of the required repeaters (#6193). */
  requiredKeys?: ReadonlyArray<string>;
  /** Known relays, used to name required rows and resolve prefixes. */
  repeaters?: ReadonlyArray<HeardByBubbleRepeater>;
  /** ANY/ALL only affects the gate; the bubble lists the same rows either way. */
  mode?: RequiredRepeaterMode;
}

function shortKey(key: string): string {
  return `${key.slice(0, 12)}…`;
}

function repeaterName(
  key: string,
  repeaters: ReadonlyArray<HeardByBubbleRepeater>,
): string {
  const want = key.toLowerCase();
  const hit = repeaters.find((r) => r.publicKey && r.publicKey.toLowerCase() === want);
  return hit?.name || shortKey(key);
}

/** hops/SNR suffix spans, shared by required and other rows. */
const MetaSpans: React.FC<{ entry: HeardByBubbleEntry }> = ({ entry }) => {
  const { t } = useTranslation();
  return (
    <>
      {typeof entry.hops === 'number' && (
        <span className="mc-heard-by-hops">
          {' '}
          {t('meshcore.heard_by_hops', { count: entry.hops, defaultValue: '{{count}} hops' })}
        </span>
      )}
      {typeof entry.snr === 'number' && <span className="mc-heard-by-snr"> ({entry.snr} dB)</span>}
    </>
  );
};

export const HeardByBubble: React.FC<HeardByBubbleProps> = ({
  heardBy,
  requiredKeys,
  repeaters,
  mode = 'any',
}) => {
  void mode; // mode drives the gate, not the list; accepted for a stable API.
  const { t } = useTranslation();
  const rows = heardBy ?? [];
  const relays = repeaters ?? [];
  const keys = requiredKeys ?? [];

  // Required repeaters, pinned at the top. `entry` is the heardBy row (if any)
  // that uniquely resolves to this key — green ✓ with its hops/SNR; else red ✗.
  const required = keys.map((key) => {
    const entry = rows.find((e) => requiredRepeaterHeard([e], key, relays)) ?? null;
    return { key, name: repeaterName(key, relays), entry };
  });
  const matched = new Set(required.map((r) => r.entry).filter(Boolean));

  // Every other hearing: a repeater heard relaying this that is not one of the
  // required rows above. All are green ✓.
  const others = sortHeardBy(rows.filter((e) => !matched.has(e)));

  // Count = green checks only (required heard + other hearings).
  const greenCount = required.filter((r) => r.entry).length + others.length;
  const heardRequired = required.filter((r) => r.entry).length;

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const pendingScroll = useRef(false);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (!prev) pendingScroll.current = true;
      return !prev;
    });
  }, []);

  // Scroll the message row into view on expand only (#6124), never on collapse.
  useEffect(() => {
    if (!pendingScroll.current) return;
    pendingScroll.current = false;
    const row = containerRef.current?.closest('[data-message-id]') as HTMLElement | null;
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [open]);

  const title =
    keys.length > 0
      ? t('meshcore.heard_by.required_summary', {
          heard: heardRequired,
          total: keys.length,
          defaultValue: 'Heard {{heard}} of {{total}} required repeater(s)',
        })
      : t('meshcore.heard_by_tooltip', 'Repeaters that relayed this message');

  return (
    <span className={styles.bubble} ref={containerRef}>
      <button
        type="button"
        className="mc-heard-by-badge"
        data-testid="mc-heard-by-badge"
        title={title}
        aria-expanded={open}
        onClick={toggle}
      >
        <UiIcon name="radioSignal" size={13} /> {greenCount}
      </button>
      {open && (
        <ul className="mc-heard-by-list">
          {required.map((r) => (
            <li
              key={`req-${r.key}`}
              className={`mc-heard-by-item ${styles.requiredRow}`}
              data-heard={r.entry ? 'true' : 'false'}
            >
              <span className={r.entry ? styles.heardMark : styles.missMark} aria-hidden="true">
                <UiIcon name={r.entry ? 'check' : 'close'} size={12} />
              </span>
              <span className="mc-heard-by-name">{r.entry?.name || r.name}</span>
              {r.entry ? (
                <MetaSpans entry={r.entry} />
              ) : (
                <span className={styles.missLabel}>
                  {' '}
                  {t('meshcore.heard_by.not_yet', 'not relayed yet')}
                </span>
              )}
            </li>
          ))}
          {others.map((h, i) => (
            <li key={`other-${h.hash}-${i}`} className="mc-heard-by-item">
              <span className={styles.heardMark} aria-hidden="true">
                <UiIcon name="check" size={12} />
              </span>
              <span className="mc-heard-by-name">{h.name || h.hash}</span>
              <MetaSpans entry={h} />
            </li>
          ))}
        </ul>
      )}
    </span>
  );
};

export default HeardByBubble;
