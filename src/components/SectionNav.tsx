import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './SectionNav.module.css';

export interface NavItem {
  id: string;
  label: string;
}

interface SectionNavProps {
  items: NavItem[];
  /**
   * Extra class for the <nav>. Callers use it to re-shape the picker for their
   * own surface — e.g. ConfigurationTab turns it into a left rail on a
   * landscape phone (#5069).
   */
  className?: string;
}

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

const SectionNav: React.FC<SectionNavProps> = ({ items, className }) => {
  const navRef = useRef<HTMLElement | null>(null);
  const settleUntilRef = useRef(0);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Stable dependency: callers build the `items` array inline, so it is a new
  // reference on every render and would re-arm the observer each time.
  const idsKey = items.map((item) => item.id).join('|');

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
      {items.map((item) => (
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
