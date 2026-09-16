/**
 * Hop-limit policy editor for an mqtt_broker source (#5190 clamp, #5188 raise).
 *
 * Two knobs with deliberately different friction. The clamp only ever makes
 * the mesh quieter, so it reads as an ordinary setting. The raise bypasses the
 * source radio's own hop scaling and costs airtime on every forwarded packet,
 * so it carries a banner and a confirm step on first enable.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import styles from './HopLimitPolicyFields.module.css';
import {
  CLAMP_EXEMPTABLE_PORTNUMS,
  MAX_HOP_LIMIT,
  MAX_RAISE_TARGET,
  RAISEABLE_PORTNUMS,
  raiseSuppressedByClamp,
  type HopLimitPolicyForm,
} from './hopLimitPolicyForm';

export interface HopLimitPolicyFieldsProps {
  value: HopLimitPolicyForm;
  onChange: (next: HopLimitPolicyForm) => void;
  /** Copy for a source still carrying the pre-4.17 override, or null. */
  legacyNotice?: string | null;
}

function togglePortnum(list: number[], portnum: number): number[] {
  return list.includes(portnum) ? list.filter((p) => p !== portnum) : [...list, portnum];
}

export function HopLimitPolicyFields({ value, onChange, legacyNotice }: HopLimitPolicyFieldsProps) {
  const { t } = useTranslation();
  // Gate only the *first* enable in this editing session. Re-opening the form
  // on a source that already has the raise on must not re-prompt.
  const [pendingRaiseConfirm, setPendingRaiseConfirm] = useState(false);

  const patch = (next: Partial<HopLimitPolicyForm>) => onChange({ ...value, ...next });

  return (
    <div className="dashboard-form-field">
      <span className="dashboard-form-label">
        {t('source.form.hop_policy', 'Hop limit on delivery to radios')}
      </span>
      <span className={styles.help}>
        {t(
          'source.form.hop_policy_help',
          'Applies to packets this broker hands to a radio — both radios subscribed over MQTT and a device linked to this broker over TCP. Ingestion, the packet log, and upstream re-publishes always see the hop limit the packet arrived with.',
        )}
      </span>

      {legacyNotice && (
        <div className={styles.notice}>
          <UiIcon name="info" size={14} />
          <span>{legacyNotice}</span>
        </div>
      )}

      {/* ---------------- Clamp (#5190) ---------------- */}
      <div className={styles.section}>
        <span className={styles.sectionTitle}>
          <UiIcon name="security" size={14} />
          {t('source.form.hop_clamp_title', 'Cap forwarded hop count')}
        </span>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={value.clampEnabled}
            onChange={(e) => patch({ clampEnabled: e.target.checked })}
          />
          <span>
            <span className={styles.fieldLabel}>
              {t('source.form.hop_clamp_enable', 'Limit hop count on forwarded packets')}
            </span>
            <span className={styles.help}>
              {t(
                'source.form.hop_clamp_help',
                'Lowers hop_limit to at most the value below. Never raises it. Older firmware without hop scaling can uplink at 7 hops, which is a lot of airtime for a dense local mesh. Leave this off for a trusted infrastructure peer whose hop limits you want honored as sent.',
              )}
            </span>
          </span>
        </label>

        {value.clampEnabled && (
          <div className={styles.indent}>
            <label>
              <span className={styles.fieldLabel}>
                {t('source.form.hop_clamp_max', 'Maximum forwarded hops')}
              </span>
              <select
                className="dashboard-form-input"
                value={value.clampMax}
                onChange={(e) => patch({ clampMax: Number(e.target.value) })}
              >
                {Array.from({ length: MAX_HOP_LIMIT + 1 }, (_, n) => (
                  <option key={n} value={n}>
                    {n === 0
                      ? t('source.form.hop_clamp_zero', '0 — zero-hop (no RF rebroadcast)')
                      : String(n)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className={styles.fieldLabel}>
                {t('source.form.hop_clamp_exempt', 'Exempt from the cap')}
              </span>
              <div className={styles.portnumGrid}>
                {CLAMP_EXEMPTABLE_PORTNUMS.map(({ portnum, label }) => (
                  <label key={portnum} className={styles.portnumLabel}>
                    <input
                      type="checkbox"
                      checked={value.clampExempt.includes(portnum)}
                      onChange={() => patch({ clampExempt: togglePortnum(value.clampExempt, portnum) })}
                    />
                    {t(`source.form.portnum_${portnum}`, label)}
                  </label>
                ))}
              </div>
              <span className={styles.help}>
                {t(
                  'source.form.hop_clamp_exempt_help',
                  'Exempt packets keep whatever hop limit they arrived with. An exemption can only be applied to a packet whose type we can read — encrypted payloads we hold no key for are always capped.',
                )}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- Raise (#5188) ---------------- */}
      <div className={styles.section}>
        <span className={styles.sectionTitle}>
          <UiIcon name="radioSignal" size={14} />
          {t('source.form.hop_raise_title', 'Raise hop count for backhaul')}
        </span>
        <div className={styles.banner}>
          <UiIcon name="alert" size={14} />
          <span>
            {t(
              'source.form.hop_raise_banner',
              'Bypasses firmware hop scaling. Modern firmware lowers hop_limit on Position, Telemetry, NodeInfo and NeighborInfo specifically to cut airtime in dense meshes. Raising it again re-injects reach the source radio deliberately trimmed, and costs airtime on every forwarded packet. Intended for managed infrastructure backhaul only — watch channel utilisation and back it off if it climbs.',
            )}
          </span>
        </div>

        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={value.raiseEnabled}
            onChange={(e) => {
              if (e.target.checked) {
                setPendingRaiseConfirm(true);
              } else {
                setPendingRaiseConfirm(false);
                patch({ raiseEnabled: false });
              }
            }}
          />
          <span>
            <span className={styles.fieldLabel}>
              {t('source.form.hop_raise_enable', 'Raise hop limit on forwarded packets')}
            </span>
            <span className={styles.help}>
              {t(
                'source.form.hop_raise_help',
                'Raises hop_limit to at least the target below. Never lowers it. Only the four packet types firmware hop scaling touches can be raised — text, direct messages and traceroutes are out of scope.',
              )}
            </span>
          </span>
        </label>

        {pendingRaiseConfirm && !value.raiseEnabled && (
          <div className={styles.confirm}>
            <span className={styles.confirmText}>
              {t(
                'source.form.hop_raise_confirm',
                'Enabling this increases channel utilisation in the receiving mesh for every forwarded Position, Telemetry, NodeInfo and NeighborInfo packet from this source, permanently, until you turn it off. Enable it?',
              )}
            </span>
            <div className={styles.confirmActions}>
              <button type="button" onClick={() => setPendingRaiseConfirm(false)}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPendingRaiseConfirm(false);
                  patch({ raiseEnabled: true });
                }}
              >
                {t('source.form.hop_raise_confirm_accept', 'Enable raise')}
              </button>
            </div>
          </div>
        )}

        {value.raiseEnabled && (
          <div className={styles.indent}>
            <label>
              <span className={styles.fieldLabel}>
                {t('source.form.hop_raise_target', 'Raise to at least')}
              </span>
              <select
                className="dashboard-form-input"
                value={value.raiseTarget}
                onChange={(e) => patch({ raiseTarget: Number(e.target.value) })}
              >
                {Array.from({ length: MAX_RAISE_TARGET }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {String(n)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className={styles.fieldLabel}>
                {t('source.form.hop_raise_portnums', 'Apply the raise to')}
              </span>
              <div className={styles.portnumGrid}>
                {RAISEABLE_PORTNUMS.map(({ portnum, label }) => (
                  <label key={portnum} className={styles.portnumLabel}>
                    <input
                      type="checkbox"
                      checked={value.raisePortnums.includes(portnum)}
                      onChange={() => patch({ raisePortnums: togglePortnum(value.raisePortnums, portnum) })}
                    />
                    {t(`source.form.portnum_${portnum}`, label)}
                  </label>
                ))}
              </div>
              {value.raisePortnums.length === 0 && (
                <span className={styles.warning}>
                  <UiIcon name="alert" size={14} />
                  {t(
                    'source.form.hop_raise_no_portnums',
                    'Pick at least one packet type, or the raise will not be saved.',
                  )}
                </span>
              )}
            </div>
          </div>
        )}

        {raiseSuppressedByClamp(value) && (
          <span className={styles.warning}>
            <UiIcon name="alert" size={14} />
            {t(
              'source.form.hop_raise_suppressed',
              'The cap runs after the raise, so a raise target above the cap has no effect. Lower the raise target or raise the cap.',
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export default HopLimitPolicyFields;
