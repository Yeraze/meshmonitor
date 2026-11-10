/**
 * "Find topics" for MQTT root fields (#6287, meshtastic/design#167).
 *
 * One shared component, placed beside every Meshtastic root field. It opens a
 * sheet that asks the server to listen on the broker for about 60 seconds
 * (subscribe only) and lists the roots it heard, plus roots from the bundled
 * community directory. Choosing a row calls `onPickRoot`; it never saves, and
 * nothing is sent to the broker or the radio.
 *
 * Props mirror `BrokerPresetSelector`: the form owns its fields, the finder
 * only reads them through `getTarget` and writes one value back.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { UiIcon } from '../icons';
import { validateMqttRoot } from '../../utils/mqttRootTopic';
import {
  useMqttRootFinder,
  type RootFinderContext,
  type RootFinderTarget,
} from '../../hooks/useMqttRootFinder';
import { MqttRootFieldError } from './MqttRootFieldError';
import styles from './MqttRootFinder.module.css';

export interface MqttRootFinderProps {
  context: RootFinderContext;
  sourceId?: string | null;
  nodeNum?: number | null;
  /** The form's broker and login, or null when it names no broker yet. */
  getTarget: () => RootFinderTarget | null;
  /** Where to search, e.g. `msh/US`. Editable in the sheet. */
  defaultRegionRoot: string;
  /** The form's current root, shown as context. */
  currentRoot?: string;
  onPickRoot: (root: string) => void;
  disabled?: boolean;
}

export const MqttRootFinder: React.FC<MqttRootFinderProps> = ({
  context,
  sourceId,
  nodeNum,
  getTarget,
  defaultRegionRoot,
  currentRoot,
  onPickRoot,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const { state, start, stop, reset } = useMqttRootFinder();
  const [open, setOpen] = useState(false);
  const [regionRoot, setRegionRoot] = useState(defaultRegionRoot);
  const [custom, setCustom] = useState('');
  const [noBroker, setNoBroker] = useState(false);
  const [waitUntil, setWaitUntil] = useState(0);
  const [, force] = useState(0);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (waitTimer.current) clearTimeout(waitTimer.current);
    },
    [],
  );

  // A 429 disables Start until the server's retry window is over.
  useEffect(() => {
    if (state.phase !== 'rejected' || !state.retryAfterSeconds) return;
    const until = Date.now() + state.retryAfterSeconds * 1000;
    setWaitUntil(until);
    if (waitTimer.current) clearTimeout(waitTimer.current);
    waitTimer.current = setTimeout(() => force((n) => n + 1), state.retryAfterSeconds * 1000);
  }, [state.phase, state.retryAfterSeconds]);

  const waiting = waitUntil > Date.now();
  const regionCheck = validateMqttRoot(regionRoot);
  const regionOk = regionCheck.ok && regionRoot.split('/').length >= 2 && regionRoot.split('/').length <= 3;
  const active = state.phase === 'starting' || state.phase === 'running';

  const openSheet = () => {
    setRegionRoot(defaultRegionRoot);
    setCustom('');
    setNoBroker(false);
    reset();
    setOpen(true);
  };

  const close = () => {
    reset(); // cancels a running sample
    setOpen(false);
  };

  const begin = () => {
    const target = getTarget();
    if (!target) {
      setNoBroker(true);
      return;
    }
    setNoBroker(false);
    void start({ context, sourceId, nodeNum, target, regionRoot });
  };

  const pick = (root: string) => {
    onPickRoot(root);
    close();
  };

  const view = state.view;
  const pct = view ? Math.min(100, Math.round((view.elapsedMs / Math.max(1, view.durationMs)) * 100)) : 0;
  const customCheck = validateMqttRoot(custom);

  const counts = (nodes?: number, messages?: number, floor?: boolean) => (
    <span className={styles.meta}>
      {nodes !== undefined && <span>{t('mqtt_root_finder.nodes', { count: nodes })}</span>}
      {messages !== undefined && (
        <span>
          {t('mqtt_root_finder.messages', { count: messages })}
          {floor ? '+' : ''}
        </span>
      )}
      {floor && <span className={styles.badge}>{t('mqtt_root_finder.floor')}</span>}
    </span>
  );

  const errorText = () => {
    if (state.phase === 'rejected') {
      if (state.errorCode === 'ROOT_FINDER_BUSY') {
        return t('mqtt_root_finder.busy', { seconds: state.retryAfterSeconds ?? 0 });
      }
      return state.errorMessage ?? t('mqtt_root_finder.start_failed');
    }
    if (view?.error) return t(`mqtt_root_finder.error.${view.error}`);
    return null;
  };

  const err = errorText();

  return (
    <>
      <button
        type="button"
        className={`btn-secondary ${styles.trigger}`}
        onClick={openSheet}
        disabled={disabled}
      >
        <UiIcon name="search" size={14} /> {t('mqtt_root_finder.button')}
      </button>

      <Modal isOpen={open} onClose={close} title={t('mqtt_root_finder.title')} maxWidth="640px">
        <div className={styles.body}>
          <p className={styles.privacy}>{t('mqtt_root_finder.privacy')}</p>
          <p className={styles.privacy}>{t('mqtt_root_finder.vantage')}</p>
          {currentRoot ? (
            <p className={styles.privacy}>{t('mqtt_root_finder.current', { root: currentRoot })}</p>
          ) : null}

          <div className={styles.field}>
            <label htmlFor="mqtt-root-finder-region">{t('mqtt_root_finder.search_under')}</label>
            <input
              id="mqtt-root-finder-region"
              type="text"
              value={regionRoot}
              disabled={active}
              onChange={(e) => setRegionRoot(e.target.value)}
            />
            {!regionOk && regionRoot !== '' && (
              <p className={styles.fieldError} role="alert">
                {t('mqtt_root_finder.region_invalid')}
              </p>
            )}
          </div>

          <div className={styles.actions}>
            <button type="button" className="btn-primary" onClick={begin} disabled={active || !regionOk || waiting}>
              {t('mqtt_root_finder.start')}
            </button>
            {active && (
              <button type="button" className="btn-secondary" onClick={() => void stop()}>
                {t('mqtt_root_finder.stop')}
              </button>
            )}
          </div>

          {noBroker && (
            <p className={styles.error} role="alert">
              {t('mqtt_root_finder.no_broker')}
            </p>
          )}
          {err && (
            <p className={styles.error} role="alert">
              {err}
            </p>
          )}

          {(active || view) && (
            <>
              <div
                className={styles.progress}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <div className={styles.progressFill} style={{ width: `${pct}%` }} />
              </div>
              <p className={styles.status}>
                {view?.status === 'cancelled'
                  ? t('mqtt_root_finder.stopped')
                  : view?.status === 'done'
                    ? t('mqtt_root_finder.finished')
                    : t('mqtt_root_finder.listening', { seconds: Math.round((view?.elapsedMs ?? 0) / 1000) })}
              </p>
            </>
          )}

          {view && view.ladder.length > 0 && (
            <section className={styles.section}>
              <h4>{t('mqtt_root_finder.suggested')}</h4>
              <ul className={styles.list}>
                {view.ladder.map((r) => (
                  <li key={`l-${r.root}`}>
                    <button type="button" className={styles.row} onClick={() => pick(r.root)}>
                      <span className={styles.root}>{r.root}</span>
                      {r.heard ? counts(r.nodes, r.messages, r.floor) : (
                        <span className={styles.badge}>{t('mqtt_root_finder.not_heard')}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {view && view.community.length > 0 && (
            <section className={styles.section}>
              <h4>{t('mqtt_root_finder.community')}</h4>
              <ul className={styles.list}>
                {view.community.map((r) => (
                  <li key={`c-${r.root}`}>
                    <button type="button" className={styles.row} onClick={() => pick(r.root)}>
                      <span className={styles.root}>{r.root}</span>
                      {r.heard ? counts(r.nodes, r.messages, r.floor) : (
                        <span className={styles.badge}>{t('mqtt_root_finder.not_heard')}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {view && view.heard.length > 0 && (
            <section className={styles.section}>
              <h4>{t('mqtt_root_finder.heard')}</h4>
              {!view.hasLocation && <p className={styles.status}>{t('mqtt_root_finder.no_location')}</p>}
              <ul className={styles.list}>
                {view.heard.map((r) => (
                  <li key={`h-${r.root}`}>
                    <button type="button" className={styles.row} onClick={() => pick(r.root)}>
                      <span className={styles.root}>{r.root}</span>
                      <span className={styles.meta}>
                        {counts(r.nodes, r.messages, r.floor)}
                        {r.nearestKm !== undefined && (
                          <span>{t('mqtt_root_finder.nearest_km', { km: r.nearestKm })}</span>
                        )}
                        {r.retainedOnly && (
                          <span className={styles.badge} title={t('mqtt_root_finder.retained_hint')}>
                            {t('mqtt_root_finder.retained')}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {view && view.status !== 'connecting' && view.status !== 'sampling' && view.heard.length === 0 && !view.error && (
            <p className={styles.status}>{t('mqtt_root_finder.nothing_heard')}</p>
          )}
          {view && <p className={styles.status}>{t('mqtt_root_finder.quiet_note')}</p>}

          <div className={styles.field}>
            <label htmlFor="mqtt-root-finder-custom">{t('mqtt_root_finder.custom')}</label>
            <input
              id="mqtt-root-finder-custom"
              type="text"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <MqttRootFieldError value={custom} />
            <div className={styles.actions}>
              <button
                type="button"
                className="btn-secondary"
                disabled={custom === '' || !customCheck.ok}
                onClick={() => pick(custom)}
              >
                {t('mqtt_root_finder.use_custom')}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
};
