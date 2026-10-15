/**
 * PatternTestBox — try sample messages against a trigger list (#5808).
 *
 * Protocol-agnostic: the section passes its triggers and a `match` function.
 * Each non-empty line of the textarea is tested against every trigger, and the
 * box lists the matches with the response the section previews.
 *
 * Purely local. It never calls the server and never sends anything: `match`
 * must be a pure function of the trigger and the text.
 *
 * `mode` mirrors the server: `first` (Meshtastic) fires only the first
 * matching trigger, so later matches are shown as shadowed; `all` (MeshCore)
 * fires every match.
 */
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import styles from './PatternTestBox.module.css';

export interface PatternTestResult {
  matched: boolean;
  /** Preview of what would be sent, already rendered by the section. */
  response?: string;
  /** Keep line breaks in the preview. */
  multiline?: boolean;
  /** Extra detail, e.g. matched pattern and extracted parameters. */
  detail?: React.ReactNode;
}

export interface PatternTestBoxProps<T> {
  triggers: T[];
  getKey: (trigger: T) => string;
  getLabel: (trigger: T) => React.ReactNode;
  match: (trigger: T, text: string) => PatternTestResult;
  mode?: 'first' | 'all';
  defaultText?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Replaces the default "No trigger matches" line. */
  noMatchLabel?: React.ReactNode;
}

export function PatternTestBox<T>({
  triggers,
  getKey,
  getLabel,
  match,
  mode = 'all',
  defaultText = '',
  title,
  description,
  noMatchLabel,
}: PatternTestBoxProps<T>): React.ReactElement {
  const { t } = useTranslation();
  const [text, setText] = useState(defaultText);
  const inputId = useId();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  return (
    <div className={styles.box}>
      <label htmlFor={inputId} className={styles.label}>
        <UiIcon name="test" size={14} /> {title ?? t('automation.pattern_test.title', 'Test a message')}
      </label>
      <p className={styles.description}>
        {description ?? t(
          'automation.pattern_test.description',
          'Type sample messages, one per line, to see which triggers match and what would be sent. Nothing is sent.',
        )}
      </p>
      <div className={styles.layout}>
        <textarea
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          className={`setting-input ${styles.input}`}
          placeholder={t('automation.pattern_test.placeholder', 'ping\nweather Miami')}
        />
        <ul className={styles.results} aria-label={t('automation.pattern_test.results', 'Test results')} aria-live="polite">
          {lines.map((line, lineIdx) => {
            const hits: Array<{ trigger: T; result: PatternTestResult }> = [];
            for (const trigger of triggers) {
              const result = match(trigger, line);
              if (result.matched) hits.push({ trigger, result });
            }
            const conflict = mode === 'first' && hits.length > 1;
            const lineClass = hits.length === 0
              ? `${styles.line} ${styles.noMatch}`
              : conflict ? `${styles.line} ${styles.conflict}` : `${styles.line} ${styles.matched}`;
            return (
              <li key={`${lineIdx}-${line}`} className={lineClass} data-testid="pattern-test-line">
                <div className={styles.message}>{line}</div>
                {hits.length === 0 ? (
                  <div className={styles.none}>
                    <UiIcon name="close" size={12} /> {noMatchLabel ?? t('automation.pattern_test.no_match', 'No trigger matches')}
                  </div>
                ) : (
                  <>
                    {conflict && (
                      <div className={styles.warning}>
                        <UiIcon name="alert" size={12} /> {t(
                          'automation.pattern_test.conflict',
                          '{{count}} triggers match; only the first one replies.',
                          { count: hits.length },
                        )}
                      </div>
                    )}
                    {hits.map(({ trigger, result }, i) => {
                      const shadowed = mode === 'first' && i > 0;
                      return (
                        <div
                          key={getKey(trigger)}
                          className={shadowed ? `${styles.hit} ${styles.shadowed}` : styles.hit}
                          data-testid="pattern-test-hit"
                        >
                          <div className={styles.hitLabel}>
                            <UiIcon name={shadowed ? 'blocked' : 'check'} size={12} /> {getLabel(trigger)}
                          </div>
                          {result.detail && <div className={styles.detail}>{result.detail}</div>}
                          {!shadowed && result.response !== undefined && (
                            <div className={result.multiline ? `${styles.response} ${styles.multiline}` : styles.response}>
                              {result.response}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export default PatternTestBox;
