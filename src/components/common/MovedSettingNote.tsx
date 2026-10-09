/**
 * A short pointer left where a control used to be (#5683 follow-up).
 *
 * That change sorted the per-source pages by what a control acts on: Device
 * Configuration for what is written to or done on the radio, Settings for what
 * MeshMonitor stores and does for the source, Global Settings for the whole
 * install. A user who looks in the old place finds one line and a link to the
 * new one.
 *
 * It holds no state and calls no route. Remove a note once its move is old
 * news: delete the element and its locale keys.
 */
import React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { UiIcon } from '../icons';
import styles from './MovedSettingNote.module.css';

export interface MovedSettingNoteProps {
  /** What moved and where, e.g. "Firmware update moved to Device Configuration." */
  text: string;
  /** Text of the link that goes there. */
  linkLabel: string;
  /** Router path (with `#section-id`) of the new place. */
  to?: string;
  /** For a page that switches views in local state and has no route per view. */
  onOpen?: () => void;
  /** Anchor id, so a deep link to the old section lands on the note. */
  id?: string;
  /** Extra class for the host page's section styling. */
  className?: string;
  testId?: string;
}

export const MovedSettingNote: React.FC<MovedSettingNoteProps> = ({
  text,
  linkLabel,
  to,
  onOpen,
  id,
  className,
  testId,
}) => {
  // The app always renders this inside its router. Rendered on its own (a
  // unit test of a host component) it falls back to a plain anchor.
  const inRouter = useInRouterContext();
  return (
  <p id={id} className={`${styles.note} ${className ?? ''}`.trim()} data-testid={testId} data-moved-setting-note="">
    <UiIcon name="info" size={14} />
    <span>{text}</span>
    {to ? (
      inRouter
        ? <Link className={styles.link} to={to}>{linkLabel}</Link>
        : <a className={styles.link} href={to}>{linkLabel}</a>
    ) : onOpen ? (
      <button type="button" className={styles.link} onClick={onOpen}>{linkLabel}</button>
    ) : null}
  </p>
  );
};

export default MovedSettingNote;
