import React from 'react';

export interface NavItem {
  id: string;
  label: string;
}

interface SectionNavProps {
  items: NavItem[];
}

const SectionNav: React.FC<SectionNavProps> = ({ items }) => {
  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (!element) return;

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
      const offset = 50;
      const containerRect = scrollContainer.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      scrollContainer.scrollBy({
        top: elementRect.top - containerRect.top - offset,
        behavior: 'smooth',
      });
    } else {
      // Window scrolling (standalone settings page).
      // Account for fixed header (60px) + sticky nav (~50px) + padding (16px).
      const offset = 130;
      const elementPosition = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: elementPosition - offset, behavior: 'smooth' });
    }
  };

  return (
    <nav className="section-nav">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="section-nav-item"
          onClick={() => scrollToSection(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
};

export default SectionNav;
