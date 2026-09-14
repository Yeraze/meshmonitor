import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './SectionNav.module.css';
import { useSectionNavHeightVar } from '../hooks/useSectionNavHeightVar';
import { matchesQuery, tokenize } from './search/configSearchMatch';

export interface NavItem {
  id: string;
  label: string;
  /**
   * Extra terms the filter should match on beyond the label and the section's
   * own rendered text — synonyms and the words a user is likely to reach for
   * ("GPS" for Position, "radio" for LoRa). Also feeds the cross-page palette.
   */
  keywords?: string[];
}

interface SectionNavProps {
  items: NavItem[];
  /**
   * Extra class for the <nav>. Callers use it to re-shape the picker for their
   * own surface — e.g. ConfigurationTab turns it into a left rail on a
   * landscape phone (#5069).
   */
  className?: string;
  /**
   * Render a filter box in the nav that narrows BOTH the chip list and the
   * sections those chips point at (#5182). Off by default so surfaces with a
   * handful of sections keep the plain picker.
   */
  searchable?: boolean;
  /** Placeholder for the filter box. Callers pass a translated string. */
  searchPlaceholder?: string;
  /** Accessible label for the filter box. Callers pass a translated string. */
  searchLabel?: string;
  /** Shown in place of the chips when nothing matches. */
  noMatchesLabel?: string;
}

/**
 * Section ids are author-written slugs, but they end up inside a generated CSS
 * selector, so anything that isn't a plain slug is dropped rather than escaped.
 * A section we cannot safely name simply stays visible.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Where a clicked section lands when the window is the scroller. */
const WINDOW_SCROLL_OFFSET = 130;
/** Where a clicked section lands when an inner pane is the scroller. */
const PANE_SCROLL_OFFSET = 50;

/**
 * The "reading position": the section whose top most recently crossed this line
 * is the current one. Mostly viewport-relative — a bare pixel offset would go
 * wrong the moment the header or the nav changes height — but floored just
 * below WINDOW_SCROLL_OFFSET so that a section you clicked reads as current
 * where it lands. Without the floor a 390px-tall landscape phone puts the line
 * at 117px while clicks land at 130px, and every click highlights the
 * *previous* category.
 */
const readingLine = () => Math.max(window.innerHeight * 0.3, WINDOW_SCROLL_OFFSET + 8);

/** How long to trust a click over the scrollspy, in ms — one smooth scroll. */
const CLICK_SETTLE_MS = 700;

const SectionNav: React.FC<SectionNavProps> = ({
  items,
  className,
  searchable = false,
  searchPlaceholder,
  searchLabel,
  noMatchesLabel,
}) => {
  const navRef = useRef<HTMLElement | null>(null);
  const settleUntilRef = useRef(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // This nav is sticky and opaque, so a second sticky element beside it has to
  // park below BOTH the fixed bar and this row. Its height is a function of how
  // many chips wrap at the current width, so it gets measured (#5100).
  useSectionNavHeightVar(navRef);

  // Stable dependency: callers build the `items` array inline, so it is a new
  // reference on every render and would re-arm the observer each time.
  const idsKey = items.map((item) => item.id).join('|');

  const tokens = useMemo(() => (searchable ? tokenize(query) : []), [searchable, query]);

  /**
   * Ids surviving the filter, or `null` when no filter is active.
   *
   * Computed in an effect rather than during render because the haystack
   * includes each section's RENDERED text — a section is matched by any word
   * inside it, not only by its own heading, which is what makes "battery" or
   * "gps" find the right panel without anyone maintaining a keyword list per
   * setting. That text only exists after commit, and it keeps arriving (device
   * config values land asynchronously).
   *
   * So the effect deliberately re-runs on every render while a query is active
   * and re-reads the DOM. It settles immediately: the state setter returns the
   * previous array when the result is unchanged, so no render it causes can
   * cause another.
   */
  const [matchedIds, setMatchedIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (tokens.length === 0) {
      setMatchedIds((prev) => (prev === null ? prev : null));
      return;
    }
    const next = items
      .filter((item) => {
        const element = document.getElementById(item.id);
        const haystack = [
          item.label,
          (item.keywords ?? []).join(' '),
          element?.textContent ?? '',
        ].join(' ');
        return matchesQuery(haystack, tokens);
      })
      .map((item) => item.id);
    setMatchedIds((prev) =>
      prev && prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next,
    );
  }, [items, tokens]);

  const visibleItems = matchedIds === null ? items : items.filter((item) => matchedIds.includes(item.id));

  /**
   * Sections the filter excludes are hidden with a generated stylesheet rather
   * than by touching their DOM nodes. Those nodes belong to the tab that
   * rendered them; setting `hidden` or a class on them from here would be
   * clobbered by that tab's next render. A <style> element is React's own and
   * survives.
   */
  const hideRule = useMemo(() => {
    if (matchedIds === null) return '';
    const hidden = items
      .map((item) => item.id)
      .filter((id) => !matchedIds.includes(id) && SAFE_ID.test(id));
    if (hidden.length === 0) return '';
    return `${hidden.map((id) => `#${id}`).join(',')}{display:none!important}`;
  }, [items, matchedIds]);

  const scrollToSection = useCallback((id: string) => {
    const element = document.getElementById(id);
    if (!element) return;

    // Clicking is an explicit choice — reflect it immediately, and hold it for
    // the duration of the smooth scroll so the highlight doesn't sweep through
    // every section on the way (which in the landscape rail would also drag the
    // rail's own scroll position along with it).
    setActiveId(id);
    settleUntilRef.current = Date.now() + CLICK_SETTLE_MS;

    // Find the nearest ACTUALLY-scrollable ancestor so this works both when the
    // window is the scroll container (standalone settings pages) and when an
    // inner flex pane is the scroll container (MeshCore notifications view).
    //
    // We require both overflow:auto/scroll AND scrollHeight > clientHeight, and
    // we exclude <body>/<html>: on the standalone settings page `body` computes
    // to overflow-y:auto but isn't itself the scroller (it's as tall as its
    // content — the window scrolls). Picking it made scrollBy a no-op, so none
    // of the nav buttons scrolled. Falling through to the window branch fixes it.
    let scrollContainer: Element | null = element.parentElement;
    while (
      scrollContainer &&
      scrollContainer !== document.body &&
      scrollContainer !== document.documentElement
    ) {
      const { overflowY } = window.getComputedStyle(scrollContainer);
      const scrollable =
        (overflowY === 'auto' || overflowY === 'scroll') &&
        scrollContainer.scrollHeight > scrollContainer.clientHeight;
      if (scrollable) break;
      scrollContainer = scrollContainer.parentElement;
    }

    if (
      scrollContainer &&
      scrollContainer !== document.body &&
      scrollContainer !== document.documentElement
    ) {
      // Inner pane scrolling — offset only for the sticky nav (~50px).
      const offset = PANE_SCROLL_OFFSET;
      const containerRect = scrollContainer.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      scrollContainer.scrollBy({
        top: elementRect.top - containerRect.top - offset,
        behavior: 'smooth',
      });
    } else {
      // Window scrolling (standalone settings page).
      // Account for fixed header (60px) + sticky nav (~50px) + padding (16px).
      const offset = WINDOW_SCROLL_OFFSET;
      const elementPosition = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: elementPosition - offset, behavior: 'smooth' });
    }
  }, []);

  /**
   * Scrollspy. The picker is an anchor list over one long document, so without
   * this there is no "selected" state at all — which is tolerable when every
   * button is on screen at once, and a bug the moment the picker itself has to
   * scroll (the landscape rail, and the portrait chip row). #5069.
   */
  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : [];
    if (ids.length === 0) return;

    let frame = 0;
    const pickCurrent = () => {
      frame = 0;
      if (Date.now() < settleUntilRef.current) return;
      const line = readingLine();
      let current: string | null = null;
      let seen = false;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        seen = true;
        if (el.getBoundingClientRect().top <= line) current = id;
      }
      if (!seen) return;
      // Above the first section: the first entry is still the one in view.
      setActiveId(current ?? ids[0]);
    };

    const schedule = () => {
      if (frame) return;
      // Coalesce a scroll burst into one read pass.
      frame = requestAnimationFrame(pickCurrent);
    };

    // Capture phase, because scroll events from an inner pane (the MeshCore
    // notifications view) do not bubble to window.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    pickCurrent();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [idsKey]);

  /**
   * Honour a `#section-id` in the URL (#5182).
   *
   * The cross-page configuration palette navigates to `…/configuration#config-lora`,
   * and the browser cannot do that jump itself: the section does not exist yet
   * when the hash is applied, and even once it does, a bare anchor jump parks it
   * under the fixed header and this sticky nav. So the nav — which already knows
   * the right scroller and the right offset — does it.
   *
   * A short delay lets the target tab finish its first paint; without it the
   * element is either absent or laid out at the wrong height.
   */
  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : [];
    if (ids.length === 0) return;

    let timer = 0;
    const jumpToHash = () => {
      const target = decodeURIComponent(window.location.hash.replace(/^#/, ''));
      if (!target || !ids.includes(target)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => scrollToSection(target), 80);
    };

    jumpToHash();
    window.addEventListener('hashchange', jumpToHash);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('hashchange', jumpToHash);
    };
  }, [idsKey, scrollToSection]);

  /**
   * Keep the active button inside the picker's own scrollport. Deliberately not
   * `scrollIntoView` — that walks up and scrolls the window too, which would
   * fight the smooth scroll we just started.
   */
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !activeId) return;
    // Section ids are plain slugs, so no escaping dance is needed here.
    const button = nav.querySelector<HTMLElement>(`[data-section-id="${activeId}"]`);
    if (!button) return;
    const navRect = nav.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (buttonRect.top < navRect.top) nav.scrollTop += buttonRect.top - navRect.top;
    else if (buttonRect.bottom > navRect.bottom) nav.scrollTop += buttonRect.bottom - navRect.bottom;
    if (buttonRect.left < navRect.left) nav.scrollLeft += buttonRect.left - navRect.left;
    else if (buttonRect.right > navRect.right) nav.scrollLeft += buttonRect.right - navRect.right;
  }, [activeId]);

  return (
    <nav ref={navRef} className={`section-nav ${className ?? ''}`.trim()}>
      {hideRule && <style>{hideRule}</style>}
      {searchable && (
        <div className={styles.search}>
          <input
            type="search"
            className={styles.searchInput}
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchLabel ?? searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears the filter instead of bubbling to whatever modal
              // or drawer happens to be listening further up.
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
        </div>
      )}
      {searchable && visibleItems.length === 0 && (
        <span className={styles.noMatches} role="status">
          {noMatchesLabel}
        </span>
      )}
      {visibleItems.map((item) => (
        <button
          key={item.id}
          type="button"
          data-section-id={item.id}
          aria-current={activeId === item.id ? 'true' : undefined}
          className={`section-nav-item ${activeId === item.id ? styles.active : ''}`.trim()}
          title={item.label}
          onClick={() => scrollToSection(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
};

export default SectionNav;
