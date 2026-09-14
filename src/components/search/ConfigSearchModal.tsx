/**
 * Cross-page configuration search (#5182).
 *
 * MeshMonitor's settings are spread over five tabs and roughly eighty sections,
 * and the number only goes up. Browser find cannot help — it sees the page you
 * are already on, which is the one place you have already looked. This palette
 * searches the whole catalogue in `configSections.ts` and navigates to the
 * section, deep-linking with a `#section-id` that `SectionNav` knows how to
 * scroll to.
 *
 * It deliberately searches SECTIONS, not individual inputs. A per-input index
 * would have to be hand-maintained and would rot the first time somebody added
 * a checkbox without touching it; the section list is already maintained,
 * because each tab renders its picker from it. Once you land on the page, that
 * page's own filter narrows further and DOES see individual settings, because
 * by then they are rendered.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { ConfigSurface } from './configSections';
import { matchRank, matchesQuery, tokenize } from './configSearchMatch';
import styles from './ConfigSearchModal.module.css';

interface ConfigSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  surfaces: ConfigSurface[];
}

interface Hit {
  surfaceKey: string;
  surfaceLabel: string;
  path: string;
  id: string;
  label: string;
  rank: number;
}

/** Cap on rendered hits. A query that matches everything is not a useful list. */
const MAX_HITS = 40;

export const ConfigSearchModal: React.FC<ConfigSearchModalProps> = ({ isOpen, onClose, surfaces }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const hits = useMemo<Hit[]>(() => {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const found: Hit[] = [];
    for (const surface of surfaces) {
      for (const item of surface.items) {
        const haystack = [surface.label, item.label, (item.keywords ?? []).join(' ')].join(' ');
        if (!matchesQuery(haystack, tokens)) continue;
        found.push({
          surfaceKey: surface.key,
          surfaceLabel: surface.label,
          path: surface.path,
          id: item.id,
          label: item.label,
          rank: matchRank(item.label, tokens),
        });
      }
    }
    // Stable within a rank: `surfaces` is already in the order pages appear in
    // the sidebar, and each surface's items in the order they appear on it.
    return found.sort((a, b) => a.rank - b.rank).slice(0, MAX_HITS);
  }, [query, surfaces]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const go = useCallback(
    (hit: Hit) => {
      onClose();
      void navigate(`${hit.path}#${hit.id}`);
    },
    [navigate, onClose],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (hits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[activeIndex];
      if (hit) go(hit);
    }
  };

  if (!isOpen) return null;

  const showEmpty = tokenize(query).length > 0 && hits.length === 0;

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('config_search.title', 'Search settings')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.inputRow}>
          <UiIcon name="search" />
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            value={query}
            placeholder={t('config_search.placeholder', 'Search all settings and configuration...')}
            aria-label={t('config_search.title', 'Search settings')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className={styles.close} onClick={onClose} aria-label={t('common.close', 'Close')}>
            &times;
          </button>
        </div>

        {showEmpty && (
          <p className={styles.empty} role="status">
            {t('config_search.no_results', 'No matching settings')}
          </p>
        )}

        {hits.length > 0 && (
          <ul className={styles.results} role="listbox">
            {hits.map((hit, index) => (
              <li key={`${hit.surfaceKey}:${hit.id}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`${styles.result} ${index === activeIndex ? styles.resultActive : ''}`.trim()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => go(hit)}
                >
                  <span className={styles.resultLabel}>{hit.label}</span>
                  <span className={styles.resultSurface}>{hit.surfaceLabel}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!showEmpty && hits.length === 0 && (
          <p className={styles.hint}>
            {t(
              'config_search.hint',
              'Type to find a settings section — try "battery", "mqtt", "gps" or "backup".',
            )}
          </p>
        )}
      </div>
    </div>
  );
};

export default ConfigSearchModal;
