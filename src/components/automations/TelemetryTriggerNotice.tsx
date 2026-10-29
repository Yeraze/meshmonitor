/**
 * One-time, dismissible notice on the Automations page: automations that use
 * "Telemetry is received" (trigger.telemetry) never fired before this release,
 * because no telemetry ingest path emitted the event the engine listens for.
 * They fire now, at most once per node per hour. Lists the saved automations
 * that are affected so the user can review them before they act on the mesh.
 *
 * Dismissal is stored per browser in localStorage.
 */
import { useState } from 'react';
import { UiIcon } from '../icons';
import styles from './TelemetryTriggerNotice.module.css';
import { TELEMETRY_TRIGGER_NOTICE_KEY, usesTelemetryTrigger, type NoticeAutomation } from './telemetryNoticeHelpers';

function readDismissed(): boolean {
  try { return localStorage.getItem(TELEMETRY_TRIGGER_NOTICE_KEY) === '1'; } catch { return false; }
}

export default function TelemetryTriggerNotice({ automations }: { automations: NoticeAutomation[] }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const affected = automations.filter((a) => usesTelemetryTrigger(a.config));
  if (dismissed || affected.length === 0) return null;

  const dismiss = () => {
    try { localStorage.setItem(TELEMETRY_TRIGGER_NOTICE_KEY, '1'); } catch { /* private mode: hide for this visit only */ }
    setDismissed(true);
  };

  return (
    <div className={styles.notice} role="status" data-testid="telemetry-trigger-notice">
      <span className={styles.icon}><UiIcon name="alert" size={18} /></span>
      <div className={styles.body}>
        <p className={styles.title}>Telemetry automations now fire</p>
        <p className={styles.text}>
          Automations triggered by &ldquo;Telemetry is received&rdquo; never fired before this release: no
          telemetry reached the engine. They fire now. Each is limited to once per node per hour, even if
          its cooldown is shorter. Check these before you leave them on, especially any that send messages
          or request data:
        </p>
        <ul className={styles.list}>
          {affected.map((a) => (
            <li key={a.id}>
              {a.name}
              {!a.enabled && <span className={styles.disabled}> (disabled)</span>}
            </li>
          ))}
        </ul>
        <button type="button" className="ae-btn" onClick={dismiss}>Got it</button>
      </div>
    </div>
  );
}
